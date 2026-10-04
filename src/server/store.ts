/**
 * Almacén de fiestas en memoria.
 *
 * Suficiente para jugar el MVP (una instancia, 3 fiestas por vez, 40 invitados
 * por fiesta — los mismos topes del plan, aplicados del lado del servidor).
 *
 * Limitaciones conocidas y esperadas en esta etapa:
 *  - Se pierde al reiniciar el proceso o al redesplegar.
 *  - Con varias instancias serverless cada una tendría su propio estado.
 * Se reemplaza por Supabase implementando la misma interfaz `PartyStore`.
 */

import { randomUUID } from "node:crypto";
import { createPartyState } from "@/domain/machine";
import { DEFAULT_SETTINGS, type PartyState } from "@/domain/types";
import type { Guest, Party, PartyStore, PlayLogEntry } from "./ports";
import { PRESET_CARDS } from "./seed";

export const MAX_GUESTS_PER_PARTY = 40;
export const MAX_LIVE_PARTIES = 3;
const MAX_LOG = 60;

/** Sin caracteres que se confundan al dictarlos (0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function makeCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function makeToken(): string {
  return randomUUID().replace(/-/g, "");
}

declare global {
  var __mvpFiestaStore: Map<string, Party> | undefined;
}

function parties(): Map<string, Party> {
  if (!globalThis.__mvpFiestaStore) globalThis.__mvpFiestaStore = new Map();
  return globalThis.__mvpFiestaStore;
}

export function logEntry(party: Party, kind: PlayLogEntry["kind"], detail: string) {
  party.log.unshift({ at: Date.now(), kind, detail });
  if (party.log.length > MAX_LOG) party.log.length = MAX_LOG;
}

export function newParty(input: { name: string; settings?: Partial<PartyState["settings"]> }): Party {
  const id = randomUUID();
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };
  const state = createPartyState(
    id,
    settings,
    [],
    PRESET_CARDS.map((card) => ({
      ...card,
      origin: "preset" as const,
      status: "approved" as const,
      proposedBy: null,
    })),
  );

  return {
    id,
    code: makeCode(),
    name: input.name,
    hostToken: makeToken(),
    locked: false,
    state,
    guests: {},
    hostSeenAt: Date.now(),
    log: [],
    createdAt: Date.now(),
  };
}

export const memoryStore: PartyStore = {
  async create(input) {
    const party = newParty(input);
    parties().set(party.id, party);
    return { party, hostToken: party.hostToken };
  },

  async get(partyId) {
    return parties().get(partyId) ?? null;
  },

  async getByCode(code) {
    const wanted = code.trim().toUpperCase();
    for (const party of parties().values()) {
      if (party.code === wanted) return party;
    }
    return null;
  },

  async commit(partyId, mutate) {
    const party = parties().get(partyId);
    if (!party) throw new Error("Fiesta no encontrada");
    mutate(party);
    return party;
  },

  async liveCount() {
    let count = 0;
    for (const party of parties().values()) {
      if (party.state.phase !== "ended" && party.state.phase !== "lobby") count++;
    }
    return count;
  },
};

/** El anfitrión da señales cada pocos segundos; sin señales, se considera caído. */
export const HOST_TIMEOUT_MS = 30_000;

export function hostIsLost(party: Party, now = Date.now()): boolean {
  return now - party.hostSeenAt > HOST_TIMEOUT_MS;
}

export function addGuest(party: Party, nickname: string): Guest {
  const clean = nickname.trim().slice(0, 24);
  const existing = Object.values(party.guests).find(
    (g) => g.nickname.toLowerCase() === clean.toLowerCase(),
  );
  if (existing) {
    existing.lastSeenAt = Date.now();
    return existing;
  }

  const guest: Guest = {
    id: randomUUID(),
    nickname: clean,
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  party.guests[guest.id] = guest;
  return guest;
}

export function guestCount(party: Party): number {
  return Object.keys(party.guests).length;
}
