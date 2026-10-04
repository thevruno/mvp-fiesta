"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Polling con pausa inteligente.
 *
 * En esta etapa el estado se refresca por polling (simple y suficiente para el
 * MVP). El plan prevé Realtime de Supabase: cuando entre, este hook se
 * reemplaza por una suscripción sin tocar las vistas.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
): { data: T | null; error: string | null; refresh: () => Promise<void>; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const alive = useRef(true);
  const fetcherRef = useRef(fetcher);

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const refresh = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (!alive.current) return;
      setData(result);
      setError(null);
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : "Error de conexión");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;

    const tick = () => {
      // No gastar datos si la pestaña está en segundo plano.
      if (document.visibilityState === "visible") void refresh();
    };

    const first = window.setTimeout(() => void refresh(), 0);
    const id = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);

    return () => {
      alive.current = false;
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, intervalMs]);

  return { data, error, refresh, loading };
}

/**
 * Cuenta regresiva contra un deadline del servidor.
 *
 * El desfase entre el reloj del servidor y el del celular se guarda en estado y
 * se aplica sobre la última hora conocida, para que todos los dispositivos
 * muestren el mismo número.
 */
export function useCountdown(deadline: number | null, serverNow: number | null): number {
  const [clock, setClock] = useState<{ now: number; skew: number } | null>(null);

  // El desfase se recalcula cuando llega una respuesta nueva del servidor.
  useEffect(() => {
    if (serverNow === null) return;
    const id = window.setTimeout(
      () => setClock({ now: Date.now(), skew: serverNow - Date.now() }),
      0,
    );
    return () => window.clearTimeout(id);
  }, [serverNow]);

  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => {
      setClock((previous) => ({ now: Date.now(), skew: previous?.skew ?? 0 }));
    }, 250);
    return () => window.clearInterval(id);
  }, [deadline]);

  if (deadline === null) return 0;
  // Antes del primer tick se usa la hora que vino con la respuesta.
  if (!clock) return serverNow === null ? 0 : Math.max(0, deadline - serverNow);
  return Math.max(0, deadline - (clock.now + clock.skew));
}

export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
