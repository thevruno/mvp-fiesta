/**
 * Tipos del dominio de "Elegí tu propia fiesta".
 *
 * Todo el dominio es TypeScript puro: sin I/O, sin Supabase, sin React.
 * Los tiempos se representan como epoch en milisegundos (number) para que las
 * cuentas sean exactas y testeables; la capa de datos traduce a timestamptz.
 */

export type Phase = "lobby" | "playing" | "voting" | "action" | "ended";

export type ActionFrequency = "never" | "sometimes" | "always";
export type CardOrigin = "preset" | "host" | "guest";
export type CardStatus = "pending" | "approved" | "rejected";
export type RoundStatus = "open" | "closed";
export type OptionKind = "playlist" | "action";

export interface PartySettings {
  /** Tope de duración de cada bloque (lista), en minutos. */
  blockMaxMinutes: number;
  /** Abrir votación cuando queden estos temas o menos. */
  voteLeadTracks: number;
  /** Abrir votación cuando quede este tiempo o menos. */
  voteLeadMinutes: number;
  /** Cuánto dura la ventana de votación. */
  voteWindowSeconds: number;
  /** Cada cuánto aparece una carta de acción en una ronda. */
  actionFrequency: ActionFrequency;
  /** Si las cartas propuestas por invitados se aprueban solas. */
  autoApproveCards: boolean;
}

export const DEFAULT_SETTINGS: PartySettings = {
  blockMaxMinutes: 30,
  voteLeadTracks: 3,
  voteLeadMinutes: 10,
  voteWindowSeconds: 60,
  actionFrequency: "sometimes",
  autoApproveCards: false,
};

/** La ventana de votación nunca se acorta por debajo de esto. */
export const MIN_VOTE_WINDOW_SECONDS = 20;

/** Margen que se le da al anfitrión para arrancar un tema antes de insistirle. */
export const START_GRACE_MS = 20_000;

export interface Track {
  videoId: string;
  title: string;
  durationSec: number;
  /** `status.embeddable` de la Data API: si es false, no se puede reproducir embebido. */
  embeddable: boolean;
}

export interface Playlist {
  id: string;
  title: string;
  tracks: Track[];
  /** Tope propio de la lista; si falta, se usa `settings.blockMaxMinutes`. */
  maxMinutes: number | null;
  played: boolean;
}

export interface ActionCard {
  id: string;
  title: string;
  text: string;
  durationSec: number;
  emoji: string;
  origin: CardOrigin;
  status: CardStatus;
  proposedBy: string | null;
}

export interface RoundOption {
  id: string;
  kind: OptionKind;
  playlistId: string | null;
  actionCardId: string | null;
}

export interface Round {
  id: string;
  /** Número de ronda dentro de la fiesta (1-based). */
  idx: number;
  opensAt: number;
  closesAt: number;
  status: RoundStatus;
  options: RoundOption[];
  /** guestId → optionId. Un voto por persona, se puede cambiar hasta el cierre. */
  votes: Record<string, string>;
  winnerOptionId: string | null;
  /** Semilla del azar usada para componer la ronda (reproducible). */
  seed: number;
  /** Semilla del desempate al azar, guardada para poder auditarlo. */
  tiebreakSeed: number | null;
}

export interface BlockState {
  playlistId: string;
  /** Orden de temas ya recortado al tope del bloque. */
  trackIds: string[];
  index: number;
  /** Una ronda de votación por bloque: este flag evita abrir dos. */
  roundOpened: boolean;
}

export interface ActiveAction {
  cardId: string;
  startedAt: number;
  endsAt: number;
}

export interface PartyState {
  partyId: string;
  phase: Phase;
  /** Versión optimista: cada transición la incrementa. */
  version: number;
  settings: PartySettings;
  playlists: Playlist[];
  cards: ActionCard[];
  block: BlockState | null;
  /** Cuándo arrancó realmente el tema en curso (lo reporta el anfitrión). */
  trackStartedAt: number | null;
  /** Marca de hora de la próxima transición. `null` = no hay deadline activo. */
  phaseDeadline: number | null;
  activeAction: ActiveAction | null;
  round: Round | null;
  /** Ganador de la ronda que todavía no se aplicó (ej. la música sigue sonando). */
  pendingWinnerOptionId: string | null;
  roundCount: number;
  /** Orden barajado del pozo de listas; marca el pulso de la fiesta. */
  poolOrder: string[];
  /** Índice del próximo bloque a jugar cuando no decide una votación. */
  poolCursor: number;
  lastPlayedPlaylistId: string | null;
  /** Si el anfitrión dejó de dar señales, acá queda el momento: congela deadlines. */
  hostLostSince: number | null;
  endedAt: number | null;
}

export type PartyEvent =
  | { type: "START_PARTY" }
  | { type: "TRACK_STARTED"; videoId: string }
  | { type: "TRACK_ENDED"; videoId: string }
  | { type: "TRACK_FAILED"; videoId: string }
  | { type: "CAST_VOTE"; guestId: string; optionId: string }
  | { type: "ADVANCE"; expectedVersion: number }
  | { type: "PROPOSE_CARD"; card: ActionCard }
  | { type: "REVIEW_CARD"; cardId: string; approve: boolean }
  | { type: "END_PARTY" }
  | { type: "HOST_LOST" }
  | { type: "HOST_BACK" };

/** Lo que el dominio pide al mundo exterior (el "effect" de reduce). */
export type Effect =
  | { type: "PLAY_TRACK"; videoId: string; playlistId: string; index: number }
  | { type: "SCHEDULE_ADVANCE"; at: number }
  | { type: "OPEN_ROUND"; roundId: string; optionIds: string[]; closesAt: number }
  | { type: "CLOSE_ROUND"; roundId: string; winnerOptionId: string }
  | { type: "SHOW_ACTION"; cardId: string; endsAt: number }
  | { type: "TRACK_ERROR"; videoId: string; reason: "unplayable" | "failed" }
  | { type: "PARTY_ENDED" };

export interface ReduceContext {
  /** Reloj del servidor. */
  now: number;
  /** Fuente de azar inyectada, para que los tests sean deterministas. */
  random: () => number;
}

export interface ReduceResult {
  state: PartyState;
  effects: Effect[];
}
