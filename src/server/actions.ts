"use server";

/**
 * Acciones de servidor: son el único lugar donde se toca el estado de una fiesta.
 *
 * Reglas:
 *  - Todo entra validado con Zod.
 *  - Cada mutación pasa por `reduce` (el dominio) y sube `version`, así que las
 *    transiciones concurrentes siguen siendo compare-and-swap.
 *  - El cliente nunca decide una fase: pide y el servidor verifica.
 */

import { z } from "zod";
import { reduce, tracksOf } from "@/domain/machine";
import { buildBlock } from "@/domain/block";
import type { Effect } from "@/domain/types";
import {
  MAX_GUESTS_PER_PARTY,
  MAX_LIVE_PARTIES,
  addGuest,
  guestCount,
  hostIsLost,
  logEntry,
  memoryStore,
} from "@/server/store";
import { fetchPlaylist, manualTrackSchema, parseYouTubeUrl } from "@/server/youtube";
import type { GuestView, HostView, Party } from "@/server/ports";
import { settingsSchema, toGuestView, toHostView } from "@/server/views";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const nicknameSchema = z
  .string()
  .trim()
  .min(1, "Poné un apodo")
  .max(24, "Máximo 24 caracteres");

const nameSchema = z.string().trim().min(1, "Poné un nombre").max(60);

export type ActionState = { ok: true; message?: string } | { ok: false; error: string };

const ok = (message?: string): ActionState => ({ ok: true, message });
const fail = (error: string): ActionState => ({ ok: false, error });

function rejected(party: Party, action: string): ActionState {
  logEntry(party, "error", `Acción rechazada por el servidor: ${action}`);
  return fail("El servidor rechazó la acción: el estado de la fiesta cambió.");
}

/** Corre el dominio y deja el estado nuevo en la fiesta. */
function apply(party: Party, effects: Effect[]) {
  for (const effect of effects) {
    switch (effect.type) {
      case "PLAY_TRACK": {
        const track = tracksOf(party.state, effect.playlistId).find(
          (t) => t.videoId === effect.videoId,
        );
        logEntry(party, "track", `Suena: ${track?.title ?? effect.videoId}`);
        break;
      }
      case "TRACK_ERROR":
        logEntry(party, "error", `Tema no reproducible: ${effect.videoId}`);
        break;
      case "SHOW_ACTION": {
        const card = party.state.cards.find((c) => c.id === effect.cardId);
        logEntry(party, "action", `Carta: ${card?.title ?? effect.cardId}`);
        break;
      }
      case "OPEN_ROUND":
        logEntry(party, "round", `Se abrió la votación con ${effect.optionIds.length} opciones`);
        break;
      case "CLOSE_ROUND":
        logEntry(party, "round", "Se cerró la votación");
        break;
      case "PARTY_ENDED":
        logEntry(party, "phase", "La fiesta terminó");
        break;
      case "SCHEDULE_ADVANCE":
        break;
    }
  }
}

function send(party: Party, event: Parameters<typeof reduce>[1], random = Math.random) {
  const result = reduce(party.state, event, { now: Date.now(), random });
  party.state = result.state;
  apply(party, result.effects);
  return result;
}

/** Sólo avanza si el deadline venció; el dominio verifica la versión. */
function advanceIfDue(party: Party) {
  const { phase, phaseDeadline, version } = party.state;
  if (phaseDeadline === null || phaseDeadline > Date.now()) return false;
  if (phase === "lobby" || phase === "ended") return false;

  const before = party.state.version;
  send(party, { type: "ADVANCE", expectedVersion: version });
  return party.state.version !== before;
}

/** Mientras nadie avanza, el servidor mantiene el reloj de la fiesta. */
function tick(party: Party) {
  if (party.state.phase === "ended") return;
  const now = Date.now();

  const lost = hostIsLost(party, now);
  if (lost && party.state.hostLostSince === null) {
    send(party, { type: "HOST_LOST" });
  } else if (!lost && party.state.hostLostSince !== null) {
    send(party, { type: "HOST_BACK" });
  }

  if (party.state.hostLostSince !== null) return;

  let guard = 0;
  while (advanceIfDue(party) && guard++ < 20) {
    /* el dominio decide cuántas transiciones hacer */
  }
}


export async function getGuestView(partyId: string, guestId?: string): Promise<GuestView | null> {
  const found = await memoryStore.get(partyId);
  if (!found) return null;

  const party = await memoryStore.commit(partyId, (p) => {
    tick(p);
    const guest = guestId ? p.guests[guestId] : undefined;
    if (guest) guest.lastSeenAt = Date.now();
  });

  return toGuestView(party, guestId);
}

export async function getHostView(
  partyId: string,
  hostToken: string,
): Promise<HostView | null> {
  const party = await memoryStore.get(partyId);
  if (!party || party.hostToken !== hostToken) return null;

  await memoryStore.commit(partyId, (party) => tick(party));
  return toHostView(party);
}

/* ------------------------------------------------------------------ */
/* Anfitrión                                                           */
/* ------------------------------------------------------------------ */

export async function createParty(input: {
  name: string;
  settings?: unknown;
}): Promise<
  | { ok: true; partyId: string; hostToken: string; code: string }
  | { ok: false; error: string }
> {
  const parsedName = nameSchema.safeParse(input.name);
  if (!parsedName.success) return { ok: false, error: parsedName.error.issues[0].message };

  const parsedSettings = settingsSchema.partial().safeParse(input.settings ?? {});
  if (!parsedSettings.success) {
    return { ok: false, error: parsedSettings.error.issues[0].message };
  }

  const { party, hostToken } = await memoryStore.create({
    name: parsedName.data,
    settings: parsedSettings.data,
  });

  logEntry(party, "phase", "Fiesta creada");
  return { ok: true, partyId: party.id, hostToken, code: party.code };
}

async function withHost<T>(
  partyId: string,
  hostToken: string,
  action: string,
  fn: (party: Party) => T,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const party = await memoryStore.get(partyId);
  if (!party || party.hostToken !== hostToken) {
    return { ok: false, error: "No autorizado" };
  }

  const result = await memoryStore.commit(partyId, (p) => {
    tick(p);
    const outcome = fn(p);
    if (outcome === false) logEntry(p, "error", `Acción rechazada: ${action}`);
  });

  return { ok: true, data: result as unknown as T };
}

export async function addPlaylist(input: {
  partyId: string;
  hostToken: string;
  url: string;
}): Promise<{ ok: true; title: string; trackCount: number; skipped: number } | { ok: false; error: string }> {
  let fetched;
  try {
    fetched = await fetchPlaylist(input.url);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "No se pudo importar la playlist",
    };
  }

  const party = await memoryStore.get(input.partyId);
  if (!party || party.hostToken !== input.hostToken) return { ok: false, error: "No autorizado" };
  if (party.state.phase !== "lobby" && party.state.phase !== "ended") {
    return { ok: false, error: "Solo se pueden agregar listas antes de arrancar" };
  }
  if (party.state.playlists.some((p) => p.id === fetched.playlist.id)) {
    return { ok: false, error: "Esa playlist ya está en la fiesta" };
  }

  await memoryStore.commit(input.partyId, (p) => {
    p.state.playlists.push(fetched.playlist);
    p.state.version += 1;
    logEntry(
      p,
      "track",
      `Playlist importada: ${fetched.playlist.title} (${fetched.playable} temas)`,
    );
  });

  return {
    ok: true,
    title: fetched.playlist.title,
    trackCount: fetched.playable,
    skipped: fetched.skipped,
  };
}

/**
 * Plan C: cargar un tema a mano. Sirve cuando la importación no está disponible
 * (sin clave y sin scraping) o para sumar un tema suelto a la fiesta.
 */
export async function addManualTrack(input: {
  partyId: string;
  hostToken: string;
  url: string;
  title: string;
  durationSec: number;
  playlistTitle?: string;
}): Promise<ActionState> {
  const parsed = manualTrackSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const url = parseYouTubeUrl(parsed.data.url);
  if (!url) return fail("Pegá el link de un video de YouTube");

  const result = await withHost(input.partyId, input.hostToken, "agregar tema", (party) => {
    if (party.state.phase !== "lobby" && party.state.phase !== "ended") return false as const;

    const title = input.playlistTitle?.trim() || "Temas sueltos";
    let playlist = party.state.playlists.find((p) => p.title === title);
    if (!playlist) {
      playlist = {
        id: `manual-${Math.random().toString(36).slice(2, 10)}`,
        title,
        tracks: [],
        maxMinutes: null,
        played: false,
      };
      party.state.playlists.push(playlist);
    }

    if (playlist.tracks.some((t) => t.videoId === url.id)) return false as const;

    playlist.tracks.push({
      videoId: url.id,
      title: parsed.data.title,
      durationSec: parsed.data.durationSec,
      embeddable: true,
    });
    party.state.version += 1;
    logEntry(party, "track", `Tema agregado a mano: ${parsed.data.title}`);
    return true as const;
  });

  if (!result.ok) return fail(result.error);
  return result.data === false ? fail("Ese tema ya está en la fiesta") : ok("Tema agregado");
}

export async function removePlaylist(input: {
  partyId: string;
  hostToken: string;
  playlistId: string;
}): Promise<ActionState> {
  const result = await withHost(input.partyId, input.hostToken, "quitar lista", (party) => {
    if (party.state.phase !== "lobby" && party.state.phase !== "ended") return false as const;
    const before = party.state.playlists.length;
    party.state.playlists = party.state.playlists.filter((p) => p.id !== input.playlistId);
    if (party.state.playlists.length === before) return false as const;
    party.state.version += 1;
    return true as const;
  });

  return result.ok ? ok("Lista eliminada") : fail(result.error);
}

export async function updateSettings(input: {
  partyId: string;
  hostToken: string;
  settings: unknown;
}): Promise<ActionState> {
  const parsed = settingsSchema.partial().safeParse(input.settings);
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const result = await withHost(input.partyId, input.hostToken, "cambiar ajustes", (party) => {
    party.state.settings = { ...party.state.settings, ...parsed.data };
    party.state.version += 1;
    return true as const;
  });

  return result.ok ? ok("Ajustes guardados") : fail(result.error);
}

export async function startParty(input: {
  partyId: string;
  hostToken: string;
}): Promise<ActionState> {
  const party = await memoryStore.get(input.partyId);
  if (!party || party.hostToken !== input.hostToken) return fail("No autorizado");

  const live = await memoryStore.liveCount();
  if (live >= MAX_LIVE_PARTIES) {
    return fail(
      `Hay ${MAX_LIVE_PARTIES} fiestas en vivo ahora mismo. Terminá alguna para arrancar esta.`,
    );
  }
  if (party.state.playlists.length === 0) return fail("Agregá al menos una playlist");
  if (!party.state.playlists.some((p) => buildBlock(p, party.state.settings.blockMaxMinutes).length > 0)) {
    return fail("Ninguna lista tiene temas reproducibles");
  }

  const result = await withHost(input.partyId, input.hostToken, "arrancar", (p) => {
    const before = p.state.version;
    send(p, { type: "START_PARTY" });
    return p.state.version > before;
  });

  if (result.ok && result.data === false) return fail("La fiesta no pudo arrancar");
  return result.ok ? ok("¡Arrancó la fiesta!") : fail(result.error);
}

/** El anfitrión reporta lo que está pasando en el reproductor. */
export async function reportPlayback(input: {
  partyId: string;
  hostToken: string;
  event: "started" | "ended" | "failed";
  videoId: string;
}): Promise<ActionState> {
  const party = await memoryStore.get(input.partyId);
  if (!party || party.hostToken !== input.hostToken) return fail("No autorizado");
  party.hostSeenAt = Date.now();

  const result = await withHost(input.partyId, input.hostToken, "reportar reproducción", (p) => {
    if (input.event === "started") {
      const block = p.state.block;
      if (!block || !block.trackIds.includes(input.videoId)) return false as const;
      const alreadyStarted =
        p.state.trackStartedAt !== null &&
        block.trackIds[block.index] === input.videoId &&
        Date.now() - p.state.trackStartedAt < 1_000;
      if (alreadyStarted) return true as const;
      send(p, { type: "TRACK_STARTED", videoId: input.videoId });
      return true as const;
    }

    send(p, {
      type: input.event === "failed" ? "TRACK_FAILED" : "TRACK_ENDED",
      videoId: input.videoId,
    });
    return true as const;
  });

  return result.ok ? ok() : fail(result.error);
}

export async function heartbeat(input: {
  partyId: string;
  hostToken: string;
}): Promise<{ ok: true; version: number; hostLost: boolean } | { ok: false; error: string }> {
  const party = await memoryStore.get(input.partyId);
  if (!party || party.hostToken !== input.hostToken) return { ok: false, error: "No autorizado" };

  party.hostSeenAt = Date.now();
  await memoryStore.commit(input.partyId, (p) => tick(p));
  return { ok: true, version: party.state.version, hostLost: party.state.hostLostSince !== null };
}

export async function advance(input: {
  partyId: string;
  hostToken?: string;
  guestId?: string;
  expectedVersion?: number;
}): Promise<ActionState> {
  const party = await memoryStore.get(input.partyId);
  if (!party) return fail("Fiesta no encontrada");

  const isHost = input.hostToken && party.hostToken === input.hostToken;
  if (!isHost && !input.guestId) return fail("No autorizado");
  if (isHost) party.hostSeenAt = Date.now();

  const result = await memoryStore.commit(input.partyId, (p) => {
    tick(p);
    // Un invitado solo puede empujar transiciones que ya vencieron.
    if (!isHost && p.state.phaseDeadline !== null && p.state.phaseDeadline > Date.now()) return;
    if (p.state.hostLostSince !== null) return;

    const expected = input.expectedVersion ?? p.state.version;
    const attempted = send(p, { type: "ADVANCE", expectedVersion: expected });

    // Si el cliente venía con una versión vieja, se reintenta una vez con la actual.
    if (input.expectedVersion !== undefined && attempted.state.version === expected) {
      send(p, { type: "ADVANCE", expectedVersion: p.state.version });
    }
  });

  return ok(`v${result.state.version}`);
}

export async function endParty(input: {
  partyId: string;
  hostToken: string;
}): Promise<ActionState> {
  const result = await withHost(input.partyId, input.hostToken, "terminar", (party) => {
    send(party, { type: "END_PARTY" });
    return true as const;
  });

  return result.ok ? ok("Fiesta terminada") : fail(result.error);
}

export async function rotateCode(input: {
  partyId: string;
  hostToken: string;
}): Promise<ActionState> {
  const result = await withHost(input.partyId, input.hostToken, "rotar código", (party) => {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    party.code = code;
    logEntry(party, "phase", "Código de ingreso rotado");
    return true as const;
  });

  return result.ok ? ok("Código nuevo generado") : fail(result.error);
}

export async function setLocked(input: {
  partyId: string;
  hostToken: string;
  locked: boolean;
}): Promise<ActionState> {
  const result = await withHost(input.partyId, input.hostToken, "bloquear sala", (party) => {
    party.locked = input.locked;
    logEntry(party, "phase", input.locked ? "Sala bloqueada" : "Sala desbloqueada");
    return true as const;
  });

  return result.ok ? ok(input.locked ? "Sala bloqueada" : "Sala abierta") : fail(result.error);
}

export async function kickGuest(input: {
  partyId: string;
  hostToken: string;
  guestId: string;
}): Promise<ActionState> {
  const result = await withHost(input.partyId, input.hostToken, "expulsar invitado", (party) => {
    const guest = party.guests[input.guestId];
    if (!guest) return false as const;
    delete party.guests[input.guestId];
    logEntry(party, "phase", `Expulsado: ${guest.nickname}`);
    return true as const;
  });

  return result.ok ? ok("Invitado expulsado") : fail(result.error);
}

export async function reviewCard(input: {
  partyId: string;
  hostToken: string;
  cardId: string;
  approve: boolean;
}): Promise<ActionState> {
  const result = await withHost(input.partyId, input.hostToken, "revisar carta", (party) => {
    const before = party.state.version;
    send(party, { type: "REVIEW_CARD", cardId: input.cardId, approve: input.approve });
    return party.state.version > before;
  });

  return result.ok && result.data ? ok("Listo") : fail("La carta no existe");
}

export async function addHostCard(input: {
  partyId: string;
  hostToken: string;
  title: string;
  text: string;
  emoji: string;
  durationSec: number;
}): Promise<ActionState> {
  const parsed = z
    .object({
      title: z.string().trim().min(1, "Poné un título").max(60),
      text: z.string().trim().max(200),
      emoji: z.string().trim().max(4),
      durationSec: z.number().int().min(20).max(300),
    })
    .safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const result = await withHost(input.partyId, input.hostToken, "agregar carta", (party) => {
    party.state.cards.push({
      id: `host-${Math.random().toString(36).slice(2, 10)}`,
      title: parsed.data.title,
      text: parsed.data.text,
      emoji: parsed.data.emoji || "🎉",
      durationSec: parsed.data.durationSec,
      origin: "host",
      status: "approved",
      proposedBy: null,
    });
    party.state.version += 1;
    logEntry(party, "action", `Carta del anfitrión: ${parsed.data.title}`);
    return true as const;
  });

  return result.ok ? ok("Carta agregada al mazo") : fail(result.error);
}

/* ------------------------------------------------------------------ */
/* Invitados                                                           */
/* ------------------------------------------------------------------ */

export async function joinParty(input: {
  code: string;
  nickname: string;
}): Promise<
  | { ok: true; partyId: string; guestId: string; nickname: string; partyName: string }
  | { ok: false; error: string }
> {
  const parsed = nicknameSchema.safeParse(input.nickname);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

  const party = await memoryStore.getByCode(input.code);
  if (!party) return { ok: false, error: "No existe una fiesta con ese código" };
  if (party.state.phase === "ended") return { ok: false, error: "Esa fiesta ya terminó" };
  if (party.locked) return { ok: false, error: "La sala está bloqueada por el anfitrión" };

  const already = Object.values(party.guests).some(
    (g) => g.nickname.toLowerCase() === parsed.data.toLowerCase(),
  );
  if (!already && guestCount(party) >= MAX_GUESTS_PER_PARTY) {
    return { ok: false, error: `La fiesta está llena (${MAX_GUESTS_PER_PARTY} invitados)` };
  }

  let guest = Object.values(party.guests)[0];
  await memoryStore.commit(party.id, (p) => {
    guest = addGuest(p, parsed.data);
  });

  return {
    ok: true,
    partyId: party.id,
    guestId: guest.id,
    nickname: guest.nickname,
    partyName: party.name,
  };
}

export async function castVote(input: {
  partyId: string;
  guestId: string;
  optionId: string;
}): Promise<ActionState> {
  const party = await memoryStore.get(input.partyId);
  if (!party) return fail("Fiesta no encontrada");
  if (!party.guests[input.guestId]) return fail("No estás en esta fiesta");
  if (party.locked) return fail("La sala está bloqueada");

  let applied = false;
  const updated = await memoryStore.commit(input.partyId, (p) => {
    const guest = p.guests[input.guestId];
    if (guest) guest.lastSeenAt = Date.now();
    tick(p);

    const round = p.state.round;
    if (!round || round.status !== "open" || round.closesAt <= Date.now()) return;

    const before = p.state.version;
    send(p, { type: "CAST_VOTE", guestId: input.guestId, optionId: input.optionId });
    applied = p.state.version > before;
  });

  if (!applied) return rejected(updated, "votar (la ronda está cerrada)");
  return ok();
}

export async function proposeCard(input: {
  partyId: string;
  guestId: string;
  title: string;
  text: string;
  emoji: string;
}): Promise<ActionState> {
  const parsed = z
    .object({
      title: z.string().trim().min(3, "Poné un título de al menos 3 letras").max(60),
      text: z.string().trim().max(200, "Máximo 200 caracteres"),
      emoji: z.string().trim().max(4),
    })
    .safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const party = await memoryStore.get(input.partyId);
  if (!party || !party.guests[input.guestId]) return fail("No estás en esta fiesta");
  if (party.locked) return fail("La sala está bloqueada");

  const myCards = party.state.cards.filter((c) => c.proposedBy === input.guestId);
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentProposals = party.log.filter(
    (entry) => entry.kind === "action" && entry.detail.includes(input.guestId) && entry.at > oneHourAgo,
  ).length;

  if (myCards.length >= 3) return fail("Ya propusiste 3 cartas, dejale lugar a los demás");
  if (recentProposals > 5) return fail("Vas muy rápido: esperá un poco para proponer otra");

  await memoryStore.commit(input.partyId, (p) => {
    send(p, {
      type: "PROPOSE_CARD",
      card: {
        id: `guest-${Math.random().toString(36).slice(2, 10)}`,
        title: parsed.data.title,
        text: parsed.data.text,
        emoji: parsed.data.emoji || "🎉",
        durationSec: 90,
        origin: "guest",
        status: "approved",
        proposedBy: party.guests[input.guestId].nickname,
      },
    });
    logEntry(p, "action", `Propuesta de ${party.guests[input.guestId].nickname}: ${parsed.data.title}`);
  });

  return party.state.settings.autoApproveCards
    ? ok("¡Carta agregada al mazo!")
    : ok("Propuesta enviada: el anfitrión la revisa");
}

export async function leaveParty(input: { partyId: string; guestId: string }): Promise<ActionState> {
  const party = await memoryStore.get(input.partyId);
  if (!party) return fail("Fiesta no encontrada");

  await memoryStore.commit(input.partyId, (p) => {
    const guest = p.guests[input.guestId];
    if (!guest) return;
    logEntry(p, "phase", `${guest.nickname} salió de la fiesta`);
  });

  return ok();
}

