/**
 * Test de integración de la capa de servidor: acciones + almacén + dominio,
 * con el reloj controlado. No toca red ni base de datos.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addManualTrack,
  advance,
  castVote,
  createParty,
  endParty,
  getGuestView,
  getHostView,
  heartbeat,
  joinParty,
  proposeCard,
  reportPlayback,
  reviewCard,
  startParty,
  updateSettings,
} from "./actions";

const BASE = new Date("2026-10-03T02:00:00.000Z").getTime();

let clock = BASE;

/** Avanza el reloj de la fiesta (sin dar señales de vida del anfitrión). */
function travel(ms: number) {
  clock = BASE + ms;
  vi.setSystemTime(new Date(clock));
}

/** Avanza el reloj mientras el anfitrión sigue dando señales (heartbeat cada 10 s). */
async function travelAlive(partyId: string, hostToken: string, ms: number) {
  const step = 10_000;
  let remaining = ms;

  while (remaining > 0) {
    const chunk = Math.min(step, remaining);
    clock += chunk;
    vi.setSystemTime(new Date(clock));
    await heartbeat({ partyId, hostToken });
    remaining -= chunk;
  }
}

async function makeParty(tracksPerPlaylist = 3, durationSec = 60) {
  travel(0);
  const created = await createParty({ name: "Fiesta de prueba" });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("no se creó");

  const { partyId, hostToken, code } = created;

  for (const [listIndex, name] of ["Lista A", "Lista B", "Lista C"].entries()) {
    for (let i = 0; i < tracksPerPlaylist; i++) {
      // Ids de 11 caracteres, como los de YouTube.
      const videoId = `test${listIndex}${String(i).padStart(6, "0")}`;
      const result = await addManualTrack({
        partyId,
        hostToken,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: `${name} tema ${i + 1}`,
        durationSec,
        playlistTitle: name,
      });
      expect(result).toBeTruthy();
      expect(result.ok).toBe(true);
    }
  }

  return { partyId, hostToken, code };
}

beforeEach(() => {
  vi.useFakeTimers();
  travel(0);
  // Cada test arranca con el almacén limpio: si no, se acumulan fiestas en vivo
  // y el tope de 3 simultáneas (regla del plan) bloquea las siguientes.
  globalThis.__mvpFiestaStore?.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("crear y arrancar una fiesta", () => {
  it("valida el nombre", async () => {
    const result = await createParty({ name: "   " });
    expect(result.ok).toBe(false);
  });

  it("devuelve código y token, y el invitado entra con el código", async () => {
    const { partyId, code } = await makeParty();

    const joined = await joinParty({ code: code.toLowerCase(), nickname: "Vale" });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    const view = await getGuestView(partyId, joined.guestId);
    expect(view?.partyName).toBe("Fiesta de prueba");
    expect(view?.guests).toHaveLength(1);
  });

  it("rechaza apodos repetidos por la puerta de atrás", async () => {
    const { code } = await makeParty();
    const first = await joinParty({ code, nickname: "Vale" });
    const second = await joinParty({ code, nickname: "vale" });

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.guestId).toBe(first.guestId);
  });

  it("no arranca sin listas y arranca con temas", async () => {
    const empty = await createParty({ name: "Vacía" });
    if (!empty.ok) throw new Error("no se creó");
    expect((await startParty({ partyId: empty.partyId, hostToken: empty.hostToken })).ok).toBe(false);

    const { partyId, hostToken } = await makeParty();
    const started = await startParty({ partyId, hostToken });
    expect(started.ok).toBe(true);

    const view = await getHostView(partyId, hostToken);
    expect(view?.phase).toBe("playing");
    expect(view?.currentTrack?.index).toBe(0);
    expect(view?.queue.length).toBeGreaterThan(1);
  });

  it("rechaza tokens que no son del anfitrión", async () => {
    const { partyId } = await makeParty();
    expect(await getHostView(partyId, "token-trucho")).toBeNull();
    expect((await startParty({ partyId, hostToken: "token-trucho" })).ok).toBe(false);
  });
});

/** Ajustes sin votación: el bloque se reproduce entero, tema por tema. */
const NO_VOTING = {
  voteLeadTracks: 0,
  voteLeadMinutes: 0,
  actionFrequency: "never" as const,
};

describe("reproducción", () => {
  it("el anfitrión reporta el tema y el reloj avanza", async () => {
    const { partyId, hostToken } = await makeParty();
    await startParty({ partyId, hostToken });

    const before = await getHostView(partyId, hostToken);
    const videoId = before!.currentTrack!.videoId;

    await reportPlayback({ partyId, hostToken, event: "started", videoId });

    const after = await getHostView(partyId, hostToken);
    expect(after?.currentTrack?.startedAt).toBe(BASE);
    expect(after?.deadline).toBe(BASE + 60_000);
  });

  it("pasa al tema siguiente cuando se cumple el deadline", async () => {
    const { partyId, hostToken } = await makeParty();
    await updateSettings({ partyId, hostToken, settings: NO_VOTING });
    await startParty({ partyId, hostToken });

    const first = await getHostView(partyId, hostToken);
    await reportPlayback({
      partyId,
      hostToken,
      event: "started",
      videoId: first!.currentTrack!.videoId,
    });

    await travelAlive(partyId, hostToken, 61_000);
    const second = await getHostView(partyId, hostToken);

    // Sigue dentro del mismo bloque, un tema más adelante.
    expect(second?.currentTrack?.index).toBe(1);
    expect(second?.currentTrack?.playlistTitle).toBe(first?.currentTrack?.playlistTitle);
    expect(second?.currentTrack?.videoId).not.toBe(first?.currentTrack?.videoId);
  });

  it("ignora un tema que no pertenece al bloque", async () => {
    const { partyId, hostToken } = await makeParty();
    await updateSettings({ partyId, hostToken, settings: NO_VOTING });
    await startParty({ partyId, hostToken });

    const before = await getHostView(partyId, hostToken);
    await reportPlayback({ partyId, hostToken, event: "started", videoId: "noexiste123" });
    const after = await getHostView(partyId, hostToken);

    expect(after?.version).toBe(before?.version);
  });

  it("un tema roto se marca y se saltea", async () => {
    const { partyId, hostToken } = await makeParty();
    await updateSettings({ partyId, hostToken, settings: NO_VOTING });
    await startParty({ partyId, hostToken });

    const before = await getHostView(partyId, hostToken);
    const videoId = before!.currentTrack!.videoId;
    await reportPlayback({ partyId, hostToken, event: "started", videoId });
    await reportPlayback({ partyId, hostToken, event: "failed", videoId });

    const after = await getHostView(partyId, hostToken);
    expect(after?.currentTrack?.videoId).not.toBe(videoId);
    expect(after?.playlists.some((p) => p.unplayable > 0)).toBe(true);
  });
});

describe("votación de punta a punta", () => {
  it("se abre sola, votan los invitados y el ganador arranca el bloque siguiente", async () => {
    // Bloques de 3 temas de 60 s y votación cuando queda 1 tema o 1 minuto.
    const { partyId, hostToken, code } = await makeParty(3, 60);

    const created = await getHostView(partyId, hostToken);
    expect(created).toBeTruthy();

    // Los invitados entran antes de arrancar.
    const vale = await joinParty({ code, nickname: "Vale" });
    const nacho = await joinParty({ code, nickname: "Nacho" });
    const sol = await joinParty({ code, nickname: "Sol" });
    if (!vale.ok || !nacho.ok || !sol.ok) throw new Error("no entraron");

    const settings = {
      voteLeadTracks: 1,
      voteLeadMinutes: 1,
      voteWindowSeconds: 30,
      actionFrequency: "never" as const,
    };
    expect((await updateSettings({ partyId, hostToken, settings })).ok).toBe(true);

    expect((await startParty({ partyId, hostToken })).ok).toBe(true);

    // El bloque tiene 3 temas y la votación se dispara con 1 tema restante:
    // arranca el primer tema y a los pocos segundos ya hay ronda.
    const opening = await getHostView(partyId, hostToken);
    await reportPlayback({
      partyId,
      hostToken,
      event: "started",
      videoId: opening!.currentTrack!.videoId,
    });

    let sawRound = false;
    for (let step = 0; step < 16 && !sawRound; step++) {
      clock += 10_000;
      vi.setSystemTime(new Date(clock));
      await heartbeat({ partyId, hostToken });
      const after = await getHostView(partyId, hostToken);
      if (after?.round) sawRound = true;
    }

    expect(sawRound).toBe(true);

    // Votan: 2 para una opción, 1 para otra.
    const withRound = await getHostView(partyId, hostToken);
    const options = withRound!.round!.options;
    expect(options.length).toBeGreaterThanOrEqual(2);

    const guestIds = [vale.guestId, nacho.guestId, sol.guestId];
    expect((await castVote({ partyId, guestId: guestIds[0], optionId: options[0].id })).ok).toBe(true);
    expect((await castVote({ partyId, guestId: guestIds[1], optionId: options[0].id })).ok).toBe(true);
    expect((await castVote({ partyId, guestId: guestIds[2], optionId: options[1].id })).ok).toBe(true);

    // Vale cambia el voto: ahora empatan.
    expect((await castVote({ partyId, guestId: guestIds[0], optionId: options[1].id })).ok).toBe(true);

    const voted = await getHostView(partyId, hostToken);
    const counted = new Map(voted!.round!.options.map((option) => [option.id, option]));
    // Vale se pasó a la segunda opción: queda 2 a 1 (antes era 2 a 1 al revés).
    expect(counted.get(options[0].id)!.votes).toBe(1);
    expect(counted.get(options[1].id)!.votes).toBe(2);
    expect([...counted.get(options[0].id)!.voters].sort()).toEqual(["Nacho"]);
    expect([...counted.get(options[1].id)!.voters].sort()).toEqual(["Sol", "Vale"]);

    // Se cierra la ventana: el ganador queda decidido pero la música sigue.
    const closesAt = voted!.round!.closesAt;
    const wait = Math.max(0, closesAt - Date.now());
    await travelAlive(partyId, hostToken, wait + 1_000);

    const closed = await getHostView(partyId, hostToken);
    expect(closed?.round?.status).toBe("closed");

    const ganadora = closed!.pendingWinner;
    expect(ganadora).not.toBeNull();
    expect(ganadora!.optionId).toBe(options[1].id); // la que juntó 2 votos
    expect(closed?.currentTrack?.playlistTitle).not.toBe(ganadora!.title); // sigue sonando la anterior

    // Al terminar el bloque arranca lo que eligieron.
    await travelAlive(partyId, hostToken, 180_000);
    const settled = await getHostView(partyId, hostToken);

    expect(settled?.phase).toBe("playing");
    expect(settled?.currentTrack?.index).toBe(0);
    expect(settled?.currentTrack?.playlistTitle).toBe(ganadora!.title);
    expect(settled?.pendingWinner).toBeNull();
    expect(settled?.log.some((entry) => entry.detail.includes("Se cerró la votación"))).toBe(true);
  });

  it("rechaza votos de gente que no está en la fiesta o después del cierre", async () => {
    const { partyId, hostToken, code } = await makeParty(3, 60);
    const vale = await joinParty({ code, nickname: "Vale" });
    if (!vale.ok) throw new Error("no entró");

    await updateSettings({
      partyId,
      hostToken,
      settings: { voteLeadTracks: 3, voteLeadMinutes: 30, voteWindowSeconds: 30, actionFrequency: "never" },
    });
    await startParty({ partyId, hostToken });

    // Con el disparo tan temprano, la votación se abre en el primer tema.
    const view = await getHostView(partyId, hostToken);
    await reportPlayback({
      partyId,
      hostToken,
      event: "started",
      videoId: view!.currentTrack!.videoId,
    });

    const withRound = await getHostView(partyId, hostToken);
    expect(withRound?.round?.status).toBe("open");

    const option = withRound!.round!.options[0].id;
    const intruder = await castVote({ partyId, guestId: "no-existe", optionId: option });
    expect(intruder.ok).toBe(false);

    travel(60_000);
    const late = await castVote({ partyId, guestId: vale.guestId, optionId: option });
    expect(late.ok).toBe(false);
  });
});

describe("cartas propuestas por invitados", () => {
  it("quedan pendientes y el anfitrión las aprueba", async () => {
    const { partyId, hostToken, code } = await makeParty();
    const vale = await joinParty({ code, nickname: "Vale" });
    if (!vale.ok) throw new Error("no entró");

    const proposed = await proposeCard({
      partyId,
      guestId: vale.guestId,
      title: "Todos al centro",
      text: "Baile obligatorio",
      emoji: "💃",
    });
    expect(proposed.ok).toBe(true);

    const host = await getHostView(partyId, hostToken);
    expect(host?.pendingCards).toHaveLength(1);
    expect(host?.pendingCards[0].proposedBy).toBe("Vale");

    expect(
      (await reviewCard({ partyId, hostToken, cardId: host!.pendingCards[0].id, approve: true })).ok,
    ).toBe(true);

    const approved = await getHostView(partyId, hostToken);
    expect(approved?.pendingCards).toHaveLength(0);
    expect(approved!.approvedCards).toBeGreaterThan(host!.approvedCards);
  });

  it("valida el texto de la propuesta", async () => {
    const { partyId, code } = await makeParty();
    const vale = await joinParty({ code, nickname: "Vale" });
    if (!vale.ok) throw new Error("no entró");

    const tooShort = await proposeCard({
      partyId,
      guestId: vale.guestId,
      title: "ok",
      text: "",
      emoji: "🎉",
    });
    expect(tooShort.ok).toBe(false);
  });
});

describe("fin de fiesta", () => {
  it("el anfitrión termina y los invitados lo ven", async () => {
    const { partyId, hostToken, code } = await makeParty();
    const vale = await joinParty({ code, nickname: "Vale" });
    if (!vale.ok) throw new Error("no entró");

    await startParty({ partyId, hostToken });
    expect((await endParty({ partyId, hostToken })).ok).toBe(true);

    const host = await getHostView(partyId, hostToken);
    const guest = await getGuestView(partyId, vale.guestId);
    expect(host?.phase).toBe("ended");
    expect(guest?.phase).toBe("ended");
  });

  it("no deja entrar a una fiesta terminada", async () => {
    const { partyId, hostToken, code } = await makeParty();
    await endParty({ partyId, hostToken });

    const late = await joinParty({ code, nickname: "Tarde" });
    expect(late.ok).toBe(false);
  });
});

describe("anfitrión caído", () => {
  it("la fiesta se congela y sigue cuando vuelve", async () => {
    const { partyId, hostToken } = await makeParty();
    await updateSettings({ partyId, hostToken, settings: NO_VOTING });
    await startParty({ partyId, hostToken });

    const view = await getHostView(partyId, hostToken);
    await reportPlayback({
      partyId,
      hostToken,
      event: "started",
      videoId: view!.currentTrack!.videoId,
    });

    // 40 s sin señales del anfitrión: se marca perdido y no avanza.
    clock = BASE + 40_000;
    vi.setSystemTime(new Date(clock));
    const lost = await getHostView(partyId, hostToken);
    expect(lost?.hostLost).toBe(true);
    const frozenIndex = lost?.currentTrack?.index ?? -1;

    // Pasa el tiempo y la fiesta sigue congelada en el mismo tema.
    clock = BASE + 400_000;
    vi.setSystemTime(new Date(clock));
    const stillFrozen = await getHostView(partyId, hostToken);
    expect(stillFrozen?.hostLost).toBe(true);
    expect(stillFrozen?.currentTrack?.index ?? -1).toBe(frozenIndex);

    // Vuelve: se destrabó.
    await heartbeat({ partyId, hostToken });
    const back = await getHostView(partyId, hostToken);
    expect(back?.hostLost).toBe(false);
  });
});

describe("avance desde el celular de un invitado", () => {
  it("un invitado empuja la transición vencida si el anfitrión no aparece", async () => {
    const { partyId, hostToken, code } = await makeParty();
    const vale = await joinParty({ code, nickname: "Vale" });
    if (!vale.ok) throw new Error("no entró");

    await updateSettings({ partyId, hostToken, settings: NO_VOTING });
    await startParty({ partyId, hostToken });

    const view = await getHostView(partyId, hostToken);
    const firstTitle = view!.currentTrack!.title;
    await reportPlayback({
      partyId,
      hostToken,
      event: "started",
      videoId: view!.currentTrack!.videoId,
    });

    // La consola del anfitrión sigue viva (late cada 10 s) pero su timer no disparó:
    // el invitado empuja la transición vencida.
    await travelAlive(partyId, hostToken, 55_000);
    clock = BASE + 61_000;
    vi.setSystemTime(new Date(clock));

    const pushed = await advance({ partyId, guestId: vale.guestId });
    expect(pushed.ok).toBe(true);

    const after = await getGuestView(partyId, vale.guestId);
    expect(after?.currentTrack?.title).not.toBe(firstTitle);
  });

  it("si el anfitrión desaparece de verdad, los invitados no pueden avanzar", async () => {
    const { partyId, hostToken, code } = await makeParty();
    const vale = await joinParty({ code, nickname: "Vale" });
    if (!vale.ok) throw new Error("no entró");

    await updateSettings({ partyId, hostToken, settings: NO_VOTING });
    await startParty({ partyId, hostToken });

    const view = await getHostView(partyId, hostToken);
    await reportPlayback({
      partyId,
      hostToken,
      event: "started",
      videoId: view!.currentTrack!.videoId,
    });

    // 90 s sin señales: la fiesta queda congelada (regla de la sección 6).
    clock = BASE + 90_000;
    vi.setSystemTime(new Date(clock));

    const pushed = await advance({ partyId, guestId: vale.guestId });
    expect(pushed.ok).toBe(true); // la acción se acepta…

    const after = await getGuestView(partyId, vale.guestId);
    expect(after?.hostLost).toBe(true);
    expect(after?.currentTrack?.title).toBe(view!.currentTrack!.title); // …pero no avanza
  });
});
