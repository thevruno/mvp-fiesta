"use client";

/** Vista del invitado: pensada para el celular, sin cuenta. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { GuestView } from "@/server/ports";
import { advance, castVote, getGuestView, joinParty, proposeCard } from "@/server/actions";
import { getGuestSession, saveGuestSession } from "@/lib/session";
import { formatClock, useCountdown, usePoll } from "@/lib/hooks";
import { ActionOverlay } from "./ActionOverlay";
import { Badge, Button, Card, Input, Notice } from "./ui";

const CARD_PRESETS = ["🎤", "🥂", "💃", "📸", "🎭", "🤫", "🪑", "❓"];

export function GuestClient({ code, initialPartyId }: { code: string; initialPartyId?: string }) {
  const [partyId, setPartyId] = useState<string | null>(initialPartyId ?? null);
  const [guestId, setGuestId] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const stored = partyId ? getGuestSession(partyId) : null;
      if (!alive) return;
      setGuestId(stored);
      setBooting(false);
    })();
    return () => {
      alive = false;
    };
  }, [partyId]);

  if (booting) {
    return <Centered>Cargando…</Centered>;
  }

  if (!partyId || !guestId) {
    return (
      <JoinForm
        code={code}
        onJoined={(joined) => {
          saveGuestSession(joined.partyId, joined.guestId);
          setPartyId(joined.partyId);
          setGuestId(joined.guestId);
        }}
      />
    );
  }

  return <GuestRoom partyId={partyId} guestId={guestId} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-neutral-950 p-6 text-center text-white/70">
      {children}
    </main>
  );
}

function JoinForm({
  code,
  onJoined,
}: {
  code: string;
  onJoined: (joined: { partyId: string; guestId: string; partyName: string }) => void;
}) {
  const [nickname, setNickname] = useState("");
  const [partyCode, setPartyCode] = useState(code);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const join = async () => {
    setBusy(true);
    const result = await joinParty({ code: partyCode, nickname });
    setBusy(false);
    if (result.ok) onJoined(result);
    else setError(result.error);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 bg-neutral-950 p-6 text-white">
      <div className="text-center">
        <p className="text-5xl">🎉</p>
        <h1 className="mt-2 text-2xl font-bold">Entrá a la fiesta</h1>
        <p className="mt-1 text-sm text-white/50">Elegí un apodo y listo, sin cuenta.</p>
      </div>

      <Card>
        <div className="space-y-3">
          <label className="block text-xs uppercase tracking-widest text-white/40">Código</label>
          <Input
            value={partyCode}
            onChange={(value) => setPartyCode(value.toUpperCase())}
            placeholder="ABC123"
            className="text-center text-2xl uppercase tracking-[0.3em]"
          />
          <label className="block text-xs uppercase tracking-widest text-white/40">Tu apodo</label>
          <Input value={nickname} onChange={setNickname} placeholder="Vale" onEnter={join} />
          {error && <Notice tone="error">{error}</Notice>}
          <Button onClick={join} disabled={busy || !nickname.trim() || partyCode.length < 4} size="lg" className="w-full">
            Entrar
          </Button>
        </div>
      </Card>

      <p className="text-center text-xs text-white/30">
        Con tu apodo nomás. No pedimos email, ni teléfono, ni nada más.
      </p>
    </main>
  );
}

function GuestRoom({ partyId, guestId }: { partyId: string; guestId: string }) {
  const fetcher = useCallback(() => getGuestView(partyId, guestId), [partyId, guestId]);
  const { data: view, error, refresh, loading } = usePoll<GuestView | null>(fetcher, 1_500);

  const [message, setMessage] = useState<{ tone: "info" | "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const nudging = useRef(false);

  const deadline = view?.phase === "voting" ? view?.round?.closesAt ?? null : view?.deadline ?? null;
  const remaining = useCountdown(deadline, view?.serverNow ?? null);
  const roundRemaining = useCountdown(
    view?.round?.status === "open" ? view?.round?.closesAt ?? null : null,
    view?.serverNow ?? null,
  );

  // Fallback del plan: si el anfitrión no aparece, cualquier invitado empuja la
  // transición vencida (con un retraso al azar para no pisarse entre todos).
  useEffect(() => {
    if (!view || view.hostLost) return;
    if (view.deadline === null || view.phase === "lobby" || view.phase === "ended") return;
    if (remaining > 0 || nudging.current) return;

    const delay = 2_000 + Math.random() * 4_000;
    const timer = window.setTimeout(() => {
      nudging.current = true;
      void advance({ partyId, guestId, expectedVersion: view.version })
        .then(() => refresh())
        .finally(() => {
          nudging.current = false;
        });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [remaining, view, partyId, guestId, refresh]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    setBusy(true);
    const result = await fn();
    setBusy(false);
    setMessage(
      result.ok
        ? result.message
          ? { tone: "success", text: result.message }
          : null
        : { tone: "error", text: result.error ?? "No se pudo" },
    );
    await refresh();
  };

  if (error) {
    return (
      <Centered>
        <div className="space-y-2">
          <p>{error}</p>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reintentar
          </Button>
        </div>
      </Centered>
    );
  }

  if (!view) {
    if (loading) return <Centered>Cargando la fiesta…</Centered>;
    return (
      <Centered>
        <div className="space-y-3">
          <p className="text-4xl">🤔</p>
          <p className="font-semibold text-white/80">No encontré la fiesta</p>
          <p className="text-sm">
            Puede que el servidor se haya reiniciado (en esta etapa el estado vive en memoria) o
            que el anfitrión haya rotado el código.
          </p>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reintentar
          </Button>
        </div>
      </Centered>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-neutral-950 p-4 pb-8 text-white">
      {view.phase === "action" && view.activeAction && (
        <ActionOverlay action={view.activeAction} serverNow={view.serverNow} />
      )}

      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{view.partyName}</p>
          <p className="text-xs text-white/40">
            {view.guests.length} invitados · {view.locked ? "sala bloqueada" : "sala abierta"}
          </p>
        </div>
        <Badge tone={view.phase === "playing" ? "live" : "neutral"}>{view.phase}</Badge>
      </header>

      {view.hostLost && (
        <Notice tone="error">
          El anfitrión se desconectó. La fiesta está en pausa hasta que vuelva.
        </Notice>
      )}

      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <Card title="Suena ahora">
        {view.currentTrack ? (
          <>
            <p className="truncate text-lg font-semibold">{view.currentTrack.title}</p>
            <p className="text-xs text-white/50">
              {view.currentTrack.playlistTitle}
              {view.blockProgress && ` · tema ${view.blockProgress.index + 1} de ${view.blockProgress.total}`}
            </p>
          </>
        ) : (
          <p className="text-sm text-white/50">
            {view.phase === "lobby" ? "La fiesta todavía no arrancó." : "Sin tema en curso."}
          </p>
        )}
        {deadline !== null && view.phase !== "lobby" && (
          <p className="mt-2 text-3xl font-bold tabular-nums text-fuchsia-300">{formatClock(remaining)}</p>
        )}
      </Card>

      {view.round && (
        <Card
          title={view.round.status === "open" ? "Votá qué sigue" : "Resultado"}
          action={
            view.round.status === "open" ? (
              <span className="text-sm font-bold tabular-nums text-fuchsia-300">{formatClock(roundRemaining)}</span>
            ) : null
          }
        >
          <ul className="space-y-2">
            {view.round.options.map((option) => {
              const mine = view.round?.myVote === option.id;
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    disabled={busy || view.round?.status !== "open" || view.locked}
                    onClick={() => run(() => castVote({ partyId, guestId, optionId: option.id }))}
                    className={`w-full rounded-xl border p-3 text-left transition disabled:opacity-60 ${
                      mine ? "border-fuchsia-400 bg-fuchsia-500/20" : "border-white/15 bg-black/30 hover:border-white/30"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">
                        {option.emoji} {option.title}
                      </span>
                      <span className="shrink-0 text-xs text-white/60">
                        {option.votes} {option.votes === 1 ? "voto" : "votos"}
                      </span>
                    </div>
                    {option.subtitle && <p className="mt-1 text-xs text-white/50">{option.subtitle}</p>}
                    {mine && <p className="mt-1 text-[11px] font-semibold text-fuchsia-200">tu voto</p>}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[11px] text-white/40">
            Podés cambiar tu voto hasta que se cierre la votación.
          </p>
        </Card>
      )}

      <ProposeCard partyId={partyId} guestId={guestId} locked={view.locked} onSend={run} busy={busy} />

      <Card title="En la fiesta">
        <p className="text-xs text-white/50">
          {view.guests.map((guest) => guest.nickname).join(" · ") || "Todavía no hay nadie más."}
        </p>
      </Card>
    </main>
  );
}

function ProposeCard({
  partyId,
  guestId,
  locked,
  onSend,
  busy,
}: {
  partyId: string;
  guestId: string;
  locked: boolean;
  onSend: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", text: "", emoji: "🎉" });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-2xl border border-dashed border-white/20 p-3 text-sm text-white/60 hover:border-white/40 hover:text-white"
      >
        ✨ Proponer una carta de acción para la fiesta
      </button>
    );
  }

  return (
    <Card title="Proponer una carta">
      <div className="space-y-2">
        <div className="flex gap-2">
          <select
            value={draft.emoji}
            onChange={(event) => setDraft({ ...draft, emoji: event.target.value })}
            className="rounded-lg border border-white/15 bg-black/30 px-2 text-xl"
          >
            {CARD_PRESETS.map((emoji) => (
              <option key={emoji} value={emoji}>
                {emoji}
              </option>
            ))}
          </select>
          <Input
            value={draft.title}
            onChange={(value) => setDraft({ ...draft, title: value })}
            placeholder="Título (ej. Todos al centro)"
          />
        </div>
        <Input
          value={draft.text}
          onChange={(value) => setDraft({ ...draft, text: value })}
          placeholder="Qué tiene que pasar"
        />
        <div className="flex gap-2">
          <Button
            disabled={busy || locked || draft.title.trim().length < 3}
            onClick={() => {
              onSend(() => proposeCard({ partyId, guestId, ...draft }));
              setDraft({ title: "", text: "", emoji: "🎉" });
              setOpen(false);
            }}
          >
            Enviar al anfitrión
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
        </div>
      </div>
    </Card>
  );
}
