"use client";

/**
 * Reproductor de YouTube (IFrame Player API).
 *
 * Reglas que salen del plan (sección 7):
 *  - El reproductor queda siempre visible (mínimo 200×200 px); no se oculta
 *    para "sólo audio".
 *  - Los temas se cargan uno por uno con `loadVideoById`, no la playlist entera.
 *  - `onError` avisa al servidor: el dominio marca el tema como no reproducible
 *    y salta al siguiente.
 */

import { useEffect, useRef, useState } from "react";

type PlayerState = -1 | 0 | 1 | 2 | 3 | 5;

interface YTPlayer {
  loadVideoById: (videoId: string) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getPlayerState: () => PlayerState;
  destroy: () => void;
}

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId?: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: PlayerState }) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("sin ventana"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.appendChild(script);
  });

  return apiPromise;
}

export interface PartyPlayerProps {
  videoId: string | null;
  /** Cada cuántos ms se considera que el tema empezó a sonar de verdad. */
  onStarted: (videoId: string) => void;
  onEnded: (videoId: string) => void;
  onFailed: (videoId: string, code: number) => void;
  /** Estado de la fiesta, para saber si hay que dejar sonar o pausar. */
  playing: boolean;
}

export function PartyPlayer({ videoId, onStarted, onEnded, onFailed, playing }: PartyPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const loadedRef = useRef<string | null>(null);
  const reportedRef = useRef<{ videoId: string | null; ended: boolean }>({ videoId: null, ended: false });
  const [ready, setReady] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const callbacks = useRef({ onStarted, onEnded, onFailed });

  useEffect(() => {
    callbacks.current = { onStarted, onEnded, onFailed };
  }, [onStarted, onEnded, onFailed]);

  useEffect(() => {
    let cancelled = false;

    void loadYouTubeApi().then((YT) => {
      if (cancelled || !containerRef.current || playerRef.current) return;

      playerRef.current = new YT.Player(containerRef.current, {
        width: "100%",
        height: "100%",
        playerVars: {
          // No se manda referrer vacío: con no-referrer YouTube devuelve error 153.
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          controls: 1,
        },
        events: {
          onReady: () => {
            if (cancelled) return;
            setReady(true);
          },
          onStateChange: (event) => {
            const current = loadedRef.current;
            if (!current) return;

            if (event.data === 1) {
              // PLAYING
              setNeedsGesture(false);
              if (reportedRef.current.videoId !== current) {
                reportedRef.current = { videoId: current, ended: false };
                callbacks.current.onStarted(current);
              }
            }
            if (event.data === 0 && !reportedRef.current.ended) {
              // ENDED
              reportedRef.current.ended = true;
              callbacks.current.onEnded(current);
            }
          },
          onError: (event) => {
            const current = loadedRef.current;
            if (!current) return;
            setLastError(describeError(event.data));
            reportedRef.current = { videoId: current, ended: true };
            callbacks.current.onFailed(current, event.data);
          },
        },
      });
    });

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  // Cargar el tema que el servidor dice que va.
  useEffect(() => {
    if (!ready || !videoId || !playerRef.current) return;
    if (loadedRef.current === videoId) return;

    loadedRef.current = videoId;
    reportedRef.current = { videoId: null, ended: false };
    setLastError(null);
    playerRef.current.loadVideoById(videoId);

    // Los navegadores bloquean el audio sin interacción: se ofrece un botón.
    window.setTimeout(() => {
      const state = playerRef.current?.getPlayerState?.();
      if (state === -1 || state === 5 || state === 2) setNeedsGesture(true);
    }, 1200);
  }, [ready, videoId]);

  useEffect(() => {
    if (!ready || !playing || !playerRef.current) return;
    if (playerRef.current.getPlayerState?.() === 2) playerRef.current.playVideo();
  }, [ready, playing]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
      <div ref={containerRef} className="h-full w-full" title="Reproductor de YouTube" />

      {(!ready || needsGesture) && (
        <button
          type="button"
          onClick={() => {
            playerRef.current?.playVideo();
            setNeedsGesture(false);
          }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-center text-white"
        >
          <span className="text-3xl">▶</span>
          <span className="text-sm font-medium">
            {ready ? "Tocá para arrancar el audio" : "Cargando reproductor…"}
          </span>
          <span className="max-w-xs text-xs text-white/60">
            El navegador pide un toque para dejar sonar el audio.
          </span>
        </button>
      )}

      {lastError && (
        <div className="absolute inset-x-0 bottom-0 bg-red-600/90 px-3 py-2 text-xs text-white">
          {lastError} — se saltea el tema.
        </div>
      )}
    </div>
  );
}

function describeError(code: number): string {
  switch (code) {
    case 2:
      return "Link inválido";
    case 5:
      return "Error del reproductor HTML5";
    case 100:
      return "El video no existe o es privado";
    case 101:
    case 150:
      return "El dueño no permite reproducirlo fuera de YouTube";
    case 153:
      return "Falta el referrer en el pedido";
    default:
      return `Error ${code} de YouTube`;
  }
}
