/**
 * Máquina de estados de la fiesta.
 *
 * `reduce(state, event, ctx) → { state, effects }` es una función pura: no toca
 * la base, no toca la red, no mira el reloj global. Todas las transiciones se
 * deciden contra `ctx.now` (deadlines) y con `ctx.random` inyectado.
 *
 * Invariantes:
 *  - `version` se incrementa en cada transición: es el compare-and-swap que
 *    permite que varios clientes disparen `ADVANCE` sin pisarse.
 *  - `phaseDeadline` es "lo próximo que tiene que pasar". Si la votación cierra
 *    antes de que termine el bloque, el deadline apunta al cierre y la música
 *    sigue: el cierre se registra y se espera al final del tema.
 */

import { buildBlock, remainingSeconds, remainingTracks } from "./block";
import { makeSeed, mulberry32, shuffled } from "./random";
import {
  closeRound,
  composeRound,
  isPlayableRound,
  resolveVoteCloseAt,
  shouldOpenVoting,
} from "./round";
import {
  START_GRACE_MS,
  type ActionCard,
  type BlockState,
  type Effect,
  type PartyEvent,
  type PartyState,
  type Playlist,
  type ReduceContext,
  type ReduceResult,
  type Round,
  type Track,
} from "./types";

const MAX_BLOCK_ATTEMPTS = 10;

/* ------------------------------------------------------------------ */
/* Helpers de estado                                                   */
/* ------------------------------------------------------------------ */

export function tracksOf(state: PartyState, playlistId: string): Track[] {
  return state.playlists.find((p) => p.id === playlistId)?.tracks ?? [];
}

/** Tema que está sonando (o el próximo a sonar) según el bloque actual. */
export function currentTrack(state: PartyState): Track | null {
  if (!state.block) return null;
  const videoId = state.block.trackIds[state.block.index];
  if (!videoId) return null;
  return tracksOf(state, state.block.playlistId).find((t) => t.videoId === videoId) ?? null;
}

/** Fin del tema en curso, según lo que reportó el anfitrión. */
export function trackEndsAt(state: PartyState): number | null {
  const track = currentTrack(state);
  if (!track || state.trackStartedAt === null) return null;
  return state.trackStartedAt + track.durationSec * 1000;
}

/** Fin del bloque actual, asumiendo que el tema en curso termina a horario. */
export function blockEndsAt(state: PartyState): number | null {
  const track = currentTrack(state);
  if (!track || state.trackStartedAt === null) return null;
  const pending = remainingSeconds(tracksOf(state, state.block!.playlistId), state.block!.index);
  return state.trackStartedAt + pending * 1000;
}

/** ¿El bloque ya se quedó sin temas para sonar? */
function blockExhausted(state: PartyState): boolean {
  return !state.block || state.block.index >= state.block.trackIds.length;
}

function withVersion(state: PartyState, patch: Partial<PartyState>): PartyState {
  return { ...state, ...patch, version: state.version + 1 };
}

function ended(state: PartyState, now: number): ReduceResult {
  return {
    state: withVersion(state, {
      phase: "ended",
      endedAt: now,
      phaseDeadline: null,
      round: state.round ? { ...state.round, status: "closed" } : null,
      pendingWinnerOptionId: null,
      activeAction: null,
      hostLostSince: null,
    }),
    effects: [{ type: "PARTY_ENDED" }],
  };
}

/* ------------------------------------------------------------------ */
/* Pozo de listas                                                      */
/* ------------------------------------------------------------------ */

interface PoolLookup {
  playlist: Playlist | null;
  poolOrder: string[];
  poolCursor: number;
  /** true si hubo que volver a barajar (el pozo se había agotado). */
  recycled: boolean;
}

/**
 * Siguiente lista del pozo, en el orden barajado al arrancar. Si el pozo se
 * agotó, se baraja de nuevo excluyendo la última lista sonada.
 */
export function nextFromPool(state: PartyState, ctx: ReduceContext): PoolLookup {
  const excluded = state.lastPlayedPlaylistId;

  // Candidatas: no sonadas y todavía no consumidas del orden actual.
  const pending = state.poolOrder
    .slice(state.poolCursor)
    .map((id) => state.playlists.find((p) => p.id === id))
    .filter((p): p is Playlist => Boolean(p) && !p!.played);

  if (pending.length > 0) {
    const playlist = pending[0];
    return {
      playlist,
      poolOrder: state.poolOrder,
      poolCursor: state.poolOrder.indexOf(playlist.id, state.poolCursor) + 1,
      recycled: false,
    };
  }

  const reshuffled = shuffled(
    state.playlists.filter((p) => !p.played && p.id !== excluded),
    mulberry32(makeSeed(ctx.random)),
  ).map((p) => p.id);

  if (reshuffled.length === 0) {
    // Último recurso: se afloja la exclusión de la última sonada para que una
    // fiesta con una sola lista siga sonando en loop en vez de cortarse.
    let fallback = state.playlists.filter((p) => p.id !== excluded).map((p) => p.id);
    if (fallback.length === 0) fallback = state.playlists.map((p) => p.id);
    if (fallback.length === 0) {
      return { playlist: null, poolOrder: [], poolCursor: 0, recycled: true };
    }
    return {
      playlist: state.playlists.find((p) => p.id === fallback[0]) ?? null,
      poolOrder: fallback,
      poolCursor: 1,
      recycled: true,
    };
  }

  return {
    playlist: state.playlists.find((p) => p.id === reshuffled[0]) ?? null,
    poolOrder: reshuffled,
    poolCursor: 1,
    recycled: true,
  };
}

/** Arranca un bloque para la lista dada, salteando listas sin temas reproducibles. */
function startBlock(state: PartyState, playlistId: string, ctx: ReduceContext): ReduceResult | null {
  let candidate: Playlist | undefined = state.playlists.find((p) => p.id === playlistId);
  let playlists = state.playlists;
  let attempts = 0;

  while (candidate && attempts < MAX_BLOCK_ATTEMPTS) {
    attempts++;
    const trackIds = buildBlock(candidate, state.settings.blockMaxMinutes);

    if (trackIds.length > 0) {
      const block: BlockState = { playlistId: candidate.id, trackIds, index: 0, roundOpened: false };
      const deadline = ctx.now + START_GRACE_MS;
      const next = withVersion(state, {
        phase: "playing",
        playlists: playlists.map((p) => (p.id === candidate!.id ? { ...p, played: true } : p)),
        block,
        trackStartedAt: null,
        phaseDeadline: deadline,
        pendingWinnerOptionId: null,
        round: null,
        activeAction: null,
      });

      const firstTrack = playlists
        .find((p) => p.id === candidate!.id)!
        .tracks.find((t) => t.videoId === trackIds[0])!;

      return {
        state: next,
        effects: [
          { type: "PLAY_TRACK", videoId: firstTrack.videoId, playlistId: candidate.id, index: 0 },
          { type: "SCHEDULE_ADVANCE", at: deadline },
        ],
      };
    }

    // La lista no tiene nada reproducible: se marca como sonada y se sigue.
    playlists = playlists.map((p) => (p.id === candidate!.id ? { ...p, played: true } : p));
    candidate = playlists.find((p) => !p.played && p.id !== state.lastPlayedPlaylistId);
    state = { ...state, playlists };
  }

  return null;
}

/** Termina la fiesta si no queda absolutamente nada para sonar. */
function advanceToNextBlock(state: PartyState, ctx: ReduceContext): ReduceResult {
  const lookup = nextFromPool(state, ctx);
  if (!lookup.playlist) return ended(state, ctx.now);

  const base: PartyState = {
    ...state,
    playlists: state.playlists.map((p) =>
      lookup.recycled ? { ...p, played: false } : p,
    ),
    poolOrder: lookup.poolOrder,
    poolCursor: lookup.poolCursor,
    lastPlayedPlaylistId: state.block?.playlistId ?? state.lastPlayedPlaylistId,
    round: null,
    pendingWinnerOptionId: null,
  };

  const result = startBlock(base, lookup.playlist.id, ctx);
  return result ?? ended(base, ctx.now);
}

/* ------------------------------------------------------------------ */
/* Votación                                                            */
/* ------------------------------------------------------------------ */

function approvedCards(state: PartyState) {
  return state.cards.filter((c) => c.status === "approved");
}

/** Abre la ronda si corresponde; si no, devuelve `null`. */
function tryOpenRound(state: PartyState, ctx: ReduceContext): ReduceResult | null {
  if (state.round?.status === "open") return null;
  if (!state.block || state.block.roundOpened) return null;

  const endsAt = blockEndsAt(state);
  if (endsAt === null) return null;

  const playlist = state.block ? state.playlists.find((p) => p.id === state.block!.playlistId) : null;
  const seed = makeSeed(ctx.random);
  const rand = mulberry32(seed);

  const { options } = composeRound({
    playlists: state.playlists,
    cards: approvedCards(state),
    currentPlaylistId: playlist?.id ?? null,
    lastPlayedPlaylistId: state.lastPlayedPlaylistId,
    actionFrequency: state.settings.actionFrequency,
    allPlaylists: state.playlists,
    random: rand,
  });

  if (!isPlayableRound(options)) return null;

  const closesAt = resolveVoteCloseAt({
    now: ctx.now,
    blockEndsAt: endsAt,
    voteWindowSeconds: state.settings.voteWindowSeconds,
  });

  const round: Round = {
    id: `r${state.roundCount + 1}`,
    idx: state.roundCount + 1,
    opensAt: ctx.now,
    closesAt,
    status: "open",
    options,
    votes: {},
    winnerOptionId: null,
    seed,
    tiebreakSeed: null,
  };

  // El próximo hito es el que ocurra primero: cierre de votación o fin del bloque.
  const deadline = Math.min(closesAt, endsAt);

  return {
    state: withVersion(state, {
      round,
      roundCount: state.roundCount + 1,
      phaseDeadline: deadline,
      block: { ...state.block!, roundOpened: true },
    }),
    effects: [
      { type: "OPEN_ROUND", roundId: round.id, optionIds: options.map((o) => o.id), closesAt },
      { type: "SCHEDULE_ADVANCE", at: deadline },
    ],
  };
}

/**
 * Se llama mientras la música suena: abre la votación cuando el bloque está
 * por terminar. No corta nada.
 */
function maybeOpenRound(state: PartyState, ctx: ReduceContext): ReduceResult {
  const block = state.block;
  const track = currentTrack(state);
  if (!block || !track || state.trackStartedAt === null) return { state, effects: [] };

  const tracks = tracksOf(state, block.playlistId);
  const elapsed = Math.max(0, (ctx.now - state.trackStartedAt) / 1000);

  const should = shouldOpenVoting({
    remainingSec: remainingSeconds(tracks, block.index, elapsed),
    remainingTracks: remainingTracks(tracks, block.index),
    voteLeadMinutes: state.settings.voteLeadMinutes,
    voteLeadTracks: state.settings.voteLeadTracks,
  });

  if (!should) return { state, effects: [] };

  const opened = tryOpenRound(state, ctx);
  return opened ?? { state, effects: [] };
}

/** Cierra la ronda y deja el ganador pendiente de aplicar. */
function closeCurrentRound(state: PartyState, ctx: ReduceContext): ReduceResult {
  const round = state.round;
  if (!round || round.status === "closed") return { state, effects: [] };

  const seed = round.tiebreakSeed ?? makeSeed(ctx.random);
  const closed = closeRound(round, seed);

  const next = withVersion(state, {
    round: closed,
    pendingWinnerOptionId: closed.winnerOptionId,
  });

  return {
    state: next,
    effects: [
      {
        type: "CLOSE_ROUND",
        roundId: closed.id,
        winnerOptionId: closed.winnerOptionId ?? "",
      },
    ],
  };
}

/** Aplica el ganador pendiente: arranca un bloque o lanza la carta de acción. */
function applyPendingWinner(state: PartyState, ctx: ReduceContext): ReduceResult {
  const round = state.round;
  const optionId = state.pendingWinnerOptionId;
  const option = round?.options.find((o) => o.id === optionId) ?? null;

  if (!option) {
    return advanceToNextBlock(
      { ...state, pendingWinnerOptionId: null, round: null, activeAction: null },
      ctx,
    );
  }

  if (option.kind === "playlist" && option.playlistId) {
    const base: PartyState = {
      ...state,
      pendingWinnerOptionId: null,
      round: null,
      activeAction: null,
      lastPlayedPlaylistId: state.block?.playlistId ?? state.lastPlayedPlaylistId,
    };
    return startBlock(base, option.playlistId, ctx) ?? ended(base, ctx.now);
  }

  const card = state.cards.find((c) => c.id === option.actionCardId);
  if (!card) {
    return advanceToNextBlock({ ...state, pendingWinnerOptionId: null, round: null }, ctx);
  }

  const endsAt = ctx.now + card.durationSec * 1000;

  return {
    state: withVersion(state, {
      phase: "action",
      activeAction: { cardId: card.id, startedAt: ctx.now, endsAt },
      phaseDeadline: endsAt,
      pendingWinnerOptionId: null,
      round: null,
    }),
    effects: [
      { type: "SHOW_ACTION", cardId: card.id, endsAt },
      { type: "SCHEDULE_ADVANCE", at: endsAt },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Transiciones                                                        */
/* ------------------------------------------------------------------ */

function advancePlaying(state: PartyState, ctx: ReduceContext): ReduceResult {
  // 1) ¿Cerró la ventana de votación? Se registra el ganador y la música sigue.
  if (state.round?.status === "open" && ctx.now >= state.round.closesAt) {
    const closed = closeCurrentRound(state, ctx);
    const endsAt = trackEndsAt(closed.state);

    if (endsAt !== null && !blockExhausted(closed.state) && endsAt > ctx.now) {
      const next = withVersion(closed.state, { phaseDeadline: endsAt });
      return {
        state: next,
        effects: [...closed.effects, { type: "SCHEDULE_ADVANCE", at: endsAt }],
      };
    }

    // La música ya terminó: se aplica el ganador de una vez.
    return applyPendingWinner(closed.state, ctx);
  }

  // 2) El anfitrión todavía no arrancó el tema: se le insiste.
  if (state.block && !blockExhausted(state) && state.trackStartedAt === null) {
    const track = currentTrack(state);
    const deadline = ctx.now + START_GRACE_MS;
    return {
      state: withVersion(state, { phaseDeadline: deadline }),
      effects: [
        ...(track
          ? ([
              {
                type: "PLAY_TRACK",
                videoId: track.videoId,
                playlistId: state.block.playlistId,
                index: state.block.index,
              },
            ] as Effect[])
          : []),
        { type: "SCHEDULE_ADVANCE", at: deadline },
      ],
    };
  }

  // 3) Se terminó el bloque.
  if (blockExhausted(state)) {
    if (state.pendingWinnerOptionId) return applyPendingWinner(state, ctx);

    if (state.round?.status === "open") {
      const endsAt = state.round.closesAt;
      return {
        state: withVersion(state, { phase: "voting", phaseDeadline: endsAt }),
        effects: [{ type: "SCHEDULE_ADVANCE", at: endsAt }],
      };
    }

    return advanceToNextBlock(state, ctx);
  }

  // 4) Paso al tema siguiente del bloque.
  const block = state.block!;
  const index = block.index + 1;
  const tracks = tracksOf(state, block.playlistId);

  if (index >= block.trackIds.length) {
    // Último tema del bloque: misma lógica que "bloque agotado".
    const nextState = withVersion(state, { block: { ...block, index } });
    return advancePlaying({ ...nextState }, ctx);
  }

  const videoId = block.trackIds[index];
  const track = tracks.find((t) => t.videoId === videoId);
  const startedAt = ctx.now;
  const deadline = startedAt + (track?.durationSec ?? 0) * 1000;

  const nextState = withVersion(state, {
    block: { ...block, index },
    trackStartedAt: startedAt,
    phaseDeadline: deadline,
  });

  const opened = maybeOpenRound(nextState, ctx);

  return {
    state: opened.state,
    effects: [
      { type: "PLAY_TRACK", videoId, playlistId: block.playlistId, index },
      ...opened.effects,
    ],
  };
}

function advanceVoting(state: PartyState, ctx: ReduceContext): ReduceResult {
  if (state.round?.status === "open") {
    if (ctx.now < state.round.closesAt) return { state, effects: [] };
    const closed = closeCurrentRound(state, ctx);
    return applyPendingWinner(closed.state, ctx);
  }

  return applyPendingWinner(state, ctx);
}

function advanceAction(state: PartyState, ctx: ReduceContext): ReduceResult {
  const action = state.activeAction;
  if (action && ctx.now < action.endsAt) return { state, effects: [] };

  return advanceToNextBlock({ ...state, activeAction: null, phase: "playing" }, ctx);
}

/** Ejecuta UNA transición pendiente según el reloj. Idempotente vía `version`. */
function advance(state: PartyState, expectedVersion: number, ctx: ReduceContext): ReduceResult {
  if (state.version !== expectedVersion) return { state, effects: [] };
  if (state.hostLostSince !== null) return { state, effects: [] };
  if (state.phaseDeadline === null || state.phaseDeadline > ctx.now) {
    return { state, effects: [] };
  }

  switch (state.phase) {
    case "playing":
      return advancePlaying(state, ctx);
    case "voting":
      return advanceVoting(state, ctx);
    case "action":
      return advanceAction(state, ctx);
    default:
      return { state, effects: [] };
  }
}

/* ------------------------------------------------------------------ */
/* reduce                                                              */
/* ------------------------------------------------------------------ */

export function reduce(
  state: PartyState,
  event: PartyEvent,
  ctx: ReduceContext,
): ReduceResult {
  const noop: ReduceResult = { state, effects: [] };

  switch (event.type) {
    /* ---------------- Lobby ---------------- */
    case "START_PARTY": {
      if (state.phase !== "lobby") return noop;
      if (state.playlists.length === 0) return noop;

      const seed = makeSeed(ctx.random);
      const poolOrder = shuffled(state.playlists, mulberry32(seed)).map((p) => p.id);
      const prepared: PartyState = {
        ...state,
        poolOrder,
        poolCursor: 0,
        lastPlayedPlaylistId: null,
      };

      const lookup = nextFromPool(prepared, { now: ctx.now, random: mulberry32(seed) });
      if (!lookup.playlist) return noop;

      const started =
        startBlock(
          { ...prepared, poolOrder: lookup.poolOrder, poolCursor: lookup.poolCursor },
          lookup.playlist.id,
          ctx,
        ) ?? null;

      return started ?? noop;
    }

    /* ---------------- Reproductor (reporta el anfitrión) ---------------- */
    case "TRACK_STARTED": {
      const block = state.block;
      if (!block || state.phase !== "playing") return noop;
      if (state.hostLostSince !== null) return noop;

      // El anfitrión manda: el tema que reporta pasa a ser el actual del bloque.
      const index = block.trackIds.indexOf(event.videoId);
      if (index === -1) return noop;

      const track = tracksOf(state, block.playlistId).find((t) => t.videoId === event.videoId);
      const startedAt = ctx.now;
      const deadline = startedAt + (track?.durationSec ?? 0) * 1000;

      const next = withVersion(state, {
        block: { ...block, index },
        trackStartedAt: startedAt,
        phaseDeadline: deadline,
      });

      // Al entrar en la recta final del bloque se abre la votación.
      const opened = maybeOpenRound(next, ctx);
      return { state: opened.state, effects: opened.effects };
    }

    case "TRACK_ENDED":
    case "TRACK_FAILED": {
      const block = state.block;
      const track = currentTrack(state);
      if (!block || !track || track.videoId !== event.videoId) return noop;
      if (state.phase !== "playing") return noop;
      if (state.hostLostSince !== null) return noop;

      if (event.type === "TRACK_FAILED") {
        // Queda marcado como no reproducible para los próximos bloques.
        const playlists = state.playlists.map((p) => ({
          ...p,
          tracks: p.tracks.map((t) =>
            t.videoId === event.videoId ? { ...t, embeddable: false } : t,
          ),
        }));
        const index = block.index + 1;

        if (index >= block.trackIds.length) {
          return advancePlaying(
            { ...state, playlists, block: { ...block, index }, trackStartedAt: ctx.now },
            ctx,
          );
        }

        const tracks = tracksOf(state, block.playlistId);
        const nextTrack = tracks.find((t) => t.videoId === block.trackIds[index]);
        const deadline = ctx.now + (nextTrack?.durationSec ?? 0) * 1000;
        const nextState = withVersion({ ...state, playlists }, {
          block: { ...block, index },
          trackStartedAt: ctx.now,
          phaseDeadline: deadline,
        });
        const opened = maybeOpenRound(nextState, ctx);

        return {
          state: opened.state,
          effects: [
            { type: "TRACK_ERROR", videoId: event.videoId, reason: "unplayable" },
            {
              type: "PLAY_TRACK",
              videoId: block.trackIds[index],
              playlistId: block.playlistId,
              index,
            },
            ...opened.effects,
          ],
        };
      }

      // Fin normal del tema: el deadline ya venció o el reproductor avisó antes.
      return advancePlaying(
        withVersion(state, { phaseDeadline: Math.min(state.phaseDeadline ?? ctx.now, ctx.now) }),
        ctx,
      );
    }

    /* ---------------- Votación ---------------- */
    case "CAST_VOTE": {
      const round = state.round;
      if (!round || round.status !== "open") return noop;
      if (state.phase !== "playing" && state.phase !== "voting") return noop;
      if (ctx.now >= round.closesAt) return noop;
      if (!round.options.some((o) => o.id === event.optionId)) return noop;

      const next = withVersion(state, {
        round: { ...round, votes: { ...round.votes, [event.guestId]: event.optionId } },
      });

      return { state: next, effects: [] };
    }

    case "ADVANCE":
      return advance(state, event.expectedVersion, ctx);

    /* ---------------- Cartas ---------------- */
    case "PROPOSE_CARD": {
      const approved = state.settings.autoApproveCards;
      // No se pisa el id ni el autor: los pone la capa de datos.
      const card: ActionCard = {
        ...event.card,
        origin: "guest",
        status: approved ? "approved" : "pending",
      };
      return { state: withVersion(state, { cards: [...state.cards, card] }), effects: [] };
    }

    case "REVIEW_CARD": {
      const exists = state.cards.some((c) => c.id === event.cardId);
      if (!exists) return noop;
      return {
        state: withVersion(state, {
          cards: state.cards.map((c) =>
            c.id === event.cardId
              ? { ...c, status: event.approve ? ("approved" as const) : ("rejected" as const) }
              : c,
          ),
        }),
        effects: [],
      };
    }

    /* ---------------- Anfitrión / fin ---------------- */
    case "HOST_LOST": {
      if (state.hostLostSince !== null || state.phase === "ended") return noop;
      return { state: withVersion(state, { hostLostSince: ctx.now }), effects: [] };
    }

    case "HOST_BACK": {
      if (state.hostLostSince === null) return noop;

      // Se corre todo lo agendado por el tiempo que la fiesta estuvo congelada.
      const delta = ctx.now - state.hostLostSince;
      const shift = (value: number | null) => (value === null ? null : value + delta);

      const round = state.round ? { ...state.round, closesAt: state.round.closesAt + delta } : null;
      const activeAction = state.activeAction
        ? { ...state.activeAction, endsAt: state.activeAction.endsAt + delta }
        : null;

      return {
        state: withVersion(state, {
          hostLostSince: null,
          phaseDeadline: shift(state.phaseDeadline),
          trackStartedAt: shift(state.trackStartedAt),
          round,
          activeAction,
        }),
        effects: [],
      };
    }

    case "END_PARTY": {
      if (state.phase === "ended") return noop;
      return ended(state, ctx.now);
    }

    default:
      return noop;
  }
}

/* ------------------------------------------------------------------ */
/* Estado inicial                                                      */
/* ------------------------------------------------------------------ */

export function createPartyState(
  partyId: string,
  settings: PartyState["settings"],
  playlists: Playlist[] = [],
  cards: PartyState["cards"] = [],
): PartyState {
  return {
    partyId,
    phase: "lobby",
    version: 0,
    settings,
    playlists,
    cards,
    block: null,
    trackStartedAt: null,
    phaseDeadline: null,
    activeAction: null,
    round: null,
    pendingWinnerOptionId: null,
    roundCount: 0,
    poolOrder: [],
    poolCursor: 0,
    lastPlayedPlaylistId: null,
    hostLostSince: null,
    endedAt: null,
  };
}
