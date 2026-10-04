"use client";

/** Carta de acción en pantalla completa, con cuenta regresiva y vibración. */

import { useEffect } from "react";
import { formatClock, useCountdown } from "@/lib/hooks";

export interface ActionOverlayProps {
  action: { title: string; text: string; emoji: string; durationSec: number; endsAt: number };
  serverNow: number | null;
  /** El anfitrión controla el reproductor: no vibra por su cuenta. */
  vibrate?: boolean;
}

export function ActionOverlay({ action, serverNow, vibrate = true }: ActionOverlayProps) {
  const remaining = useCountdown(action.endsAt, serverNow);
  const progress = Math.max(0, Math.min(1, remaining / (action.durationSec * 1000)));

  useEffect(() => {
    if (!vibrate) return;
    navigator.vibrate?.([120, 80, 120, 80, 240]);
  }, [vibrate, action.title]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-gradient-to-br from-fuchsia-600 via-purple-700 to-indigo-800 p-6 text-center text-white">
      <div className="text-7xl">{action.emoji}</div>
      <h2 className="text-4xl font-black tracking-tight sm:text-5xl">{action.title}</h2>
      <p className="max-w-2xl text-lg text-white/90 sm:text-xl">{action.text}</p>

      <div className="w-full max-w-2xl">
        <div className="h-3 w-full overflow-hidden rounded-full bg-white/25">
          <div
            className="h-full rounded-full bg-white transition-[width] duration-300"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <p className="mt-3 text-3xl font-bold tabular-nums">{formatClock(remaining)}</p>
      </div>

      <p className="text-xs uppercase tracking-widest text-white/60">
        Cuando termine, sigue la música
      </p>
    </div>
  );
}
