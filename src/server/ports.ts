/**
 * Contrato entre la UI y la capa de datos.
 *
 * Hoy lo implementa un almacén en memoria (`src/server/store.ts`), pensado para
 * que el MVP se pueda jugar: el anfitrión abre la consola en el notebook y los
 * invitados votan desde el celular contra el mismo servidor.
 *
 * Cuando entre Supabase, se escribe otra implementación de `PartyStore` con las
 * mismas firmas (migraciones + RLS) sin tocar ni el dominio ni la UI.
 */

import type { Effect, PartyState } from "@/domain/types";

export interface Guest {
  id: string;
  nickname: string;
  joinedAt: number;
  lastSeenAt: number;
}

export interface Party {
  id: string;
  /** Código de 6 caracteres que se pasa por QR o link. */
  code: string;
  name: string;
  hostToken: string;
  locked: boolean;
  state: PartyState;
  guests: Record<string, Guest>;
  /** Últimas señales del anfitrión (para el "se desconectó"). */
  hostSeenAt: number;
  log: PlayLogEntry[];
  createdAt: number;
}

export interface PlayLogEntry {
  at: number;
  kind: "track" | "action" | "round" | "phase" | "error";
  detail: string;
}

export interface GuestView {
  partyId: string;
  partyName: string;
  phase: PartyState["phase"];
  locked: boolean;
  /** Milisegundos de desfase entre el reloj del servidor y el del cliente. */
  serverNow: number;
  version: number;
  deadline: number | null;
  /** Tema sonando: solo datos públicos. */
  currentTrack: { title: string; videoId: string; playlistTitle: string } | null;
  currentPlaylist: { id: string; title: string; playedCount: number; total: number } | null;
  blockProgress: { index: number; total: number } | null;
  round: {
    id: string;
    closesAt: number;
    status: "open" | "closed";
    options: {
      id: string;
      kind: "playlist" | "action";
      title: string;
      subtitle: string;
      emoji: string;
      votes: number;
      voters: string[];
    }[];
    myVote: string | null;
    winnerOptionId: string | null;
  } | null;
  activeAction: {
    title: string;
    text: string;
    emoji: string;
    durationSec: number;
    endsAt: number;
  } | null;
  guests: { nickname: string }[];
  cardQueue: { id: string; title: string; text: string; emoji: string; status: string }[];
  hostLost: boolean;
}

export interface HostView {
  partyId: string;
  code: string;
  joinUrl: string;
  name: string;
  phase: PartyState["phase"];
  serverNow: number;
  version: number;
  deadline: number | null;
  locked: boolean;
  settings: PartyState["settings"];
  currentTrack: {
    videoId: string;
    title: string;
    durationSec: number;
    playlistTitle: string;
    index: number;
    total: number;
    startedAt: number | null;
  } | null;
  queue: { index: number; videoId: string; title: string; durationSec: number }[];
  round: GuestView["round"];
  /** Ganador ya decidido que todavía no arrancó (la música está terminando el bloque). */
  pendingWinner: { optionId: string; title: string; kind: "playlist" | "action" } | null;
  activeAction: GuestView["activeAction"];
  playlists: {
    id: string;
    title: string;
    trackCount: number;
    unplayable: number;
    played: boolean;
    totalMinutes: number;
  }[];
  pendingCards: { id: string; title: string; text: string; emoji: string; proposedBy: string | null }[];
  approvedCards: number;
  guests: Guest[];
  hostLost: boolean;
  log: PlayLogEntry[];
}

export interface PartyStore {
  create(input: { name: string; settings?: Partial<PartyState["settings"]> }): Promise<{
    party: Party;
    hostToken: string;
  }>;
  get(partyId: string): Promise<Party | null>;
  getByCode(code: string): Promise<Party | null>;
  /** Aplica eventos al estado y devuelve los efectos que quedaron pendientes. */
  commit(partyId: string, mutate: (party: Party) => void): Promise<Party>;
  /** Lista de fiestas en vivo (para el tope de 3 simultáneas). */
  liveCount(): Promise<number>;
}

export type { Effect, PartyState };
