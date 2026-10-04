"use client";

/** Sesiones guardadas en el navegador: no hay cuentas en esta etapa. */

const HOST_KEY = (partyId: string) => `fiesta:host:${partyId}`;
const GUEST_KEY = (partyId: string) => `fiesta:guest:${partyId}`;
const LAST_HOST = "fiesta:ultimo-host";

export function saveHostSession(partyId: string, token: string) {
  localStorage.setItem(HOST_KEY(partyId), token);
  localStorage.setItem(LAST_HOST, partyId);
}

export function getHostSession(partyId: string): string | null {
  return localStorage.getItem(HOST_KEY(partyId));
}

export function lastHostParty(): string | null {
  return localStorage.getItem(LAST_HOST);
}

export function saveGuestSession(partyId: string, guestId: string) {
  localStorage.setItem(GUEST_KEY(partyId), guestId);
}

export function getGuestSession(partyId: string): string | null {
  return localStorage.getItem(GUEST_KEY(partyId));
}
