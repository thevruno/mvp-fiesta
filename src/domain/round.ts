/**
 * Reglas de la votación: cuándo se abre, cómo se compone la ronda, cómo se
 * cuenta y cómo se desempata.
 */

import { mulberry32, shuffled } from "./random";
import { MIN_VOTE_WINDOW_SECONDS, type ActionCard, type Playlist, type RoundOption, type Round } from "./types";

export interface RoundTriggerInput {
  /** Segundos que faltan para que termine el bloque. */
  remainingSec: number;
  /** Temas que quedan por delante, incluido el que suena. */
  remainingTracks: number;
  voteLeadMinutes: number;
  voteLeadTracks: number;
}

/** ¿Ya hay que abrir la votación? Se dispara con lo que ocurra primero. */
export function shouldOpenVoting(input: RoundTriggerInput): boolean {
  return (
    input.remainingTracks <= input.voteLeadTracks ||
    input.remainingSec <= input.voteLeadMinutes * 60
  );
}

/**
 * Cuándo cierra la ventana: lo normal es que cierre antes del final del bloque.
 * Si no queda tiempo suficiente se acorta, pero nunca por debajo del mínimo,
 * y en ese caso la votación sigue viva unos segundos con la música ya parada.
 */
export function resolveVoteCloseAt(input: {
  now: number;
  blockEndsAt: number;
  voteWindowSeconds: number;
}): number {
  const { now, blockEndsAt, voteWindowSeconds } = input;
  const natural = now + voteWindowSeconds * 1000;
  const closesAt = Math.min(natural, blockEndsAt);
  const floor = now + MIN_VOTE_WINDOW_SECONDS * 1000;
  return Math.max(closesAt, floor);
}

export interface ComposeRoundInput {
  playlists: Playlist[];
  cards: ActionCard[];
  /** Lista que está sonando ahora: no puede volver a salir. */
  currentPlaylistId: string | null;
  lastPlayedPlaylistId: string | null;
  actionFrequency: "never" | "sometimes" | "always";
  /** Se usa si el pozo quedó vacío y hay que volver a barajar. */
  allPlaylists: Playlist[];
  maxOptions?: number;
  random: () => number;
}

export interface ComposedRound {
  options: RoundOption[];
  /** Lista de la que hay que agarrar los temas, si el pozo se recicló. */
  recycledPlaylists: boolean;
}

/**
 * Compone una ronda: 2–3 opciones entre listas no sonadas y (según la
 * frecuencia configurada) una carta de acción al azar.
 */
export function composeRound(input: ComposeRoundInput): ComposedRound {
  const maxOptions = input.maxOptions ?? 3;
  const { random } = input;

  const exclude = new Set(
    [input.currentPlaylistId, input.lastPlayedPlaylistId].filter(
      (id): id is string => Boolean(id),
    ),
  );

  let available = input.playlists.filter((p) => !p.played && !exclude.has(p.id));
  let recycled = false;

  if (available.length === 0) {
    // Pozo agotado: se barajan de nuevo las listas, sin repetir la última sonada.
    available = input.allPlaylists.filter((p) => !exclude.has(p.id));
    recycled = available.length > 0;
  }

  const actionAvailable = input.cards.length > 0;
  const actionRoll = random();
  let includeAction =
    actionAvailable &&
    (input.actionFrequency === "always" ||
      (input.actionFrequency === "sometimes" && actionRoll < 0.5));

  // Si no hay listas suficientes, la carta entra igual para poder llegar a 2 opciones.
  if (!includeAction && actionAvailable && available.length < 2) {
    includeAction = true;
  }

  const playlistSlots = includeAction
    ? Math.min(2, available.length)
    : Math.min(maxOptions, available.length);

  const pickedPlaylists = shuffled(available, random).slice(0, playlistSlots);
  const pickedCards = includeAction && actionAvailable ? shuffled(input.cards, random).slice(0, 1) : [];

  const options: RoundOption[] = pickedPlaylists.map((playlist) => ({
    id: `pl:${playlist.id}`,
    kind: "playlist" as const,
    playlistId: playlist.id,
    actionCardId: null,
  }));

  for (const card of pickedCards) {
    options.push({
      id: `card:${card.id}`,
      kind: "action",
      playlistId: null,
      actionCardId: card.id,
    });
  }

  return { options: shuffled(options, random), recycledPlaylists: recycled };
}

/** Una ronda es válida solo si tiene al menos dos opciones entre las que elegir. */
export function isPlayableRound(options: readonly RoundOption[]): boolean {
  return options.length >= 2;
}

export interface TallyResult {
  counts: Record<string, number>;
  /** Opciones con más votos (puede haber empate, o ser todas con 0). */
  top: string[];
  totalVotes: number;
}

export function tallyVotes(
  options: readonly RoundOption[],
  votes: Record<string, string>,
): TallyResult {
  const counts: Record<string, number> = {};
  for (const option of options) counts[option.id] = 0;

  let totalVotes = 0;
  for (const optionId of Object.values(votes)) {
    if (!(optionId in counts)) continue; // voto viejo de una opción que ya no está
    counts[optionId] += 1;
    totalVotes += 1;
  }

  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((id) => counts[id] === max);

  return { counts, top, totalVotes };
}

/**
 * Gana la opción más votada. Empate (o cero votos) se resuelve al azar con la
 * semilla guardada, para que el resultado sea auditable.
 */
export function pickWinner(
  options: readonly RoundOption[],
  votes: Record<string, string>,
  seed: number,
): string | null {
  if (options.length === 0) return null;

  const { top } = tallyVotes(options, votes);
  if (top.length === 0) return null;
  if (top.length === 1) return top[0];

  top.sort();
  const rand = mulberry32(seed);
  return top[Math.floor(rand() * top.length)];
}

/** Cierra una ronda: deja el ganador y la semilla del desempate guardados. */
export function closeRound(round: Round, tiebreakSeed: number): Round {
  return {
    ...round,
    status: "closed",
    winnerOptionId: pickWinner(round.options, round.votes, tiebreakSeed),
    tiebreakSeed,
  };
}
