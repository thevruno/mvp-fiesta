"use client";

/**
 * Consola del anfitrión: reproductor, votación en vivo, mazo de cartas y control
 * de la sala. Es la pantalla que se proyecta en el notebook de la fiesta.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { HostView } from "@/server/ports";
import {
  addHostCard,
  addManualTrack,
  addPlaylist,
  advance,
  endParty,
  getHostView,
  heartbeat,
  kickGuest,
  removePlaylist,
  reportPlayback,
  reviewCard,
  rotateCode,
  setLocked,
  startParty,
  updateSettings,
} from "@/server/actions";
import { formatClock, useCountdown, usePoll } from "@/lib/hooks";
import { ActionOverlay } from "./ActionOverlay";
import { PartyPlayer } from "./PartyPlayer";
import { Qr } from "./Qr";
import { Badge, Button, Card, Input, Notice } from "./ui";

const HEARTBEAT_MS = 10_000;

export function HostConsole({ partyId, hostToken }: { partyId: string; hostToken: string }) {
  const router = useRouter();
  const fetchView = useCallback(() => getHostView(partyId, hostToken), [partyId, hostToken]);
  const { data: view, error, refresh, loading } = usePoll<HostView | null>(fetchView, 1_500);

  const [message, setMessage] = useState<{ tone: "info" | "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const advancing = useRef(false);

  const state = view?.phase ?? "lobby";
  const deadline = view?.deadline ?? null;
  const remaining = useCountdown(deadline, view?.serverNow ?? null);
  const roundClosesAt = view?.round?.status === "open" ? view.round.closesAt : null;
  const roundRemaining = useCountdown(roundClosesAt, view?.serverNow ?? null);

  useEffect(() => {
    const id = window.setInterval(() => {
      void heartbeat({ partyId, hostToken });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [partyId, hostToken]);

  // El anfitrión es el que dispara las transiciones cuando vence un deadline.
  useEffect(() => {
    if (deadline === null || view?.hostLost) return;
    if (remaining > 0) return;
    if (advancing.current) return;

    advancing.current = true;
    void advance({ partyId, hostToken, expectedVersion: view?.version }).finally(() => {
      advancing.current = false;
      void refresh();
    });
  }, [remaining, deadline, partyId, hostToken, view?.hostLost, view?.version, refresh]);

  const run = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
      setBusy(true);
      try {
        const result = await fn();
        if (result.ok) {
          if (result.message) setMessage({ tone: "success", text: result.message });
          else setMessage(null);
        } else {
          setMessage({ tone: "error", text: result.error ?? "No se pudo completar la acción" });
        }
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Notice tone="error">{error}</Notice>
      </main>
    );
  }

  if (!view) {
    if (loading) {
      return (
        <main className="grid min-h-screen place-items-center p-6 text-white/60">
          Cargando la fiesta…
        </main>
      );
    }
    return (
      <main className="mx-auto grid min-h-screen max-w-md place-items-center p-6 text-center text-white/70">
        <div className="space-y-3">
          <p className="text-4xl">🌙</p>
          <p className="font-semibold text-white/80">Perdí el estado de esta fiesta</p>
          <p className="text-sm">
            En esta etapa el estado del servidor vive en memoria, así que se pierde cuando el
            servidor se reinicia o cambia de instancia. Creá la fiesta de nuevo.
          </p>
          <Button onClick={() => router.push("/host")}>Crear otra fiesta</Button>
        </div>
      </main>
    );
  }

  const joinUrl =
    typeof window === "undefined" ? "" : `${window.location.origin}/j/${view.code}`;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 text-white">
      {view.phase === "action" && view.activeAction && (
        <ActionOverlay action={view.activeAction} serverNow={view.serverNow} vibrate={false} />
      )}

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-white/40">Consola del anfitrión</p>
          <h1 className="text-2xl font-bold">{view.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={view.phase === "playing" ? "live" : "neutral"}>{view.phase}</Badge>
          {view.hostLost && <Badge tone="warn">señal perdida</Badge>}
          <Badge>v{view.version}</Badge>
          {view.phase === "lobby" && (
            <Button
              onClick={() => run(() => startParty({ partyId, hostToken }))}
              disabled={busy || view.playlists.length === 0}
              variant="success"
              size="lg"
            >
              ▶ Arrancar la fiesta
            </Button>
          )}
          {view.phase !== "ended" && view.phase !== "lobby" && (
            <Button onClick={() => run(() => endParty({ partyId, hostToken }))} variant="danger" disabled={busy}>
              Terminar fiesta
            </Button>
          )}
        </div>
      </header>

      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-4">
          <PartyPlayer
            videoId={view.currentTrack?.videoId ?? null}
            playing={view.phase === "playing" && !view.hostLost}
            onStarted={(videoId) => void reportPlayback({ partyId, hostToken, event: "started", videoId })}
            onEnded={(videoId) => void reportPlayback({ partyId, hostToken, event: "ended", videoId })}
            onFailed={(videoId) => {
              setMessage({ tone: "error", text: "Ese tema no se puede reproducir: se saltea." });
              void reportPlayback({ partyId, hostToken, event: "failed", videoId });
            }}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Suena ahora">
              {view.currentTrack ? (
                <>
                  <p className="truncate text-lg font-semibold">{view.currentTrack.title}</p>
                  <p className="text-xs text-white/50">
                    {view.currentTrack.playlistTitle} · tema {view.currentTrack.index + 1} de{" "}
                    {view.currentTrack.total}
                  </p>
                  <p className="mt-2 text-3xl font-bold tabular-nums text-fuchsia-300">
                    {formatClock(remaining)}
                  </p>
                  <p className="text-xs text-white/40">
                    {state === "voting"
                      ? "Votación abierta"
                      : state === "playing"
                        ? "Suena la música"
                        : state === "action"
                          ? "Carta en pantalla"
                          : "En pausa"}
                  </p>
                </>
              ) : (
                <p className="text-sm text-white/50">
                  {view.phase === "lobby"
                    ? "Agregá playlists y arrancá la fiesta."
                    : "Sin tema en curso."}
                </p>
              )}
            </Card>

            <Card title="Cola del bloque">
              {view.queue.length === 0 ? (
                <p className="text-sm text-white/50">Sin temas en cola.</p>
              ) : (
                <ol className="space-y-1 text-sm">
                  {view.queue.map((track, i) => (
                    <li
                      key={track.videoId}
                      className={`flex items-center justify-between gap-2 ${i === 0 ? "text-white" : "text-white/60"}`}
                    >
                      <span className="truncate">
                        {i === 0 ? "▶ " : `${i + 1}. `}
                        {track.title}
                      </span>
                      <span className="shrink-0 text-xs text-white/40">
                        {Math.floor(track.durationSec / 60)}:{String(track.durationSec % 60).padStart(2, "0")}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Entrada de invitados">
            <div className="flex items-center gap-4">
              <div className="rounded-xl bg-white p-1">
                <Qr value={joinUrl} size={132} />
              </div>
              <div className="min-w-0">
                <p className="text-3xl font-black tracking-[0.3em] text-fuchsia-300">{view.code}</p>
                <p className="mt-1 break-all text-[11px] text-white/40">{joinUrl}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge>{view.guests.length}/40 invitados</Badge>
                  {view.locked && <Badge tone="warn">sala bloqueada</Badge>}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => run(() => setLocked({ partyId, hostToken, locked: !view.locked }))}>
                {view.locked ? "Abrir la sala" : "Bloquear la sala"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => run(() => rotateCode({ partyId, hostToken }))}>
                Rotar código
              </Button>
            </div>
          </Card>

          {view.pendingWinner && (
            <Notice tone="success">
              Ya eligieron: <strong>{view.pendingWinner.title}</strong>. Arranca cuando termine
              el tema en curso.
            </Notice>
          )}

          {view.round && (
            <Card
              title={view.round.status === "open" ? "Votación abierta" : "Resultado de la votación"}
              action={
                view.round.status === "open" ? (
                  <span className="text-sm font-bold tabular-nums text-fuchsia-300">
                    {formatClock(roundRemaining)}
                  </span>
                ) : null
              }
            >
              <ul className="space-y-2">
                {view.round.options.map((option) => (
                  <li
                    key={option.id}
                    className={`rounded-xl border p-3 ${
                      view.round?.winnerOptionId === option.id
                        ? "border-emerald-400/60 bg-emerald-400/10"
                        : "border-white/10 bg-black/20"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {option.emoji} {option.title}
                      </span>
                      <span className="shrink-0 text-sm font-bold tabular-nums">
                        {option.votes} {option.votes === 1 ? "voto" : "votos"}
                      </span>
                    </div>
                    {option.subtitle && (
                      <p className="mt-1 line-clamp-2 text-xs text-white/50">{option.subtitle}</p>
                    )}
                    {option.voters.length > 0 && (
                      <p className="mt-1 text-[11px] text-white/40">{option.voters.join(", ")}</p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title={`Mazo de cartas (${view.approvedCards} listas)`}>
            {view.pendingCards.length > 0 && (
              <div className="mb-3 space-y-2">
                <p className="text-xs font-semibold text-amber-200">
                  Propuestas por invitados ({view.pendingCards.length})
                </p>
                {view.pendingCards.map((card) => (
                  <div key={card.id} className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
                    <p className="text-sm font-medium">
                      {card.emoji} {card.title}
                    </p>
                    <p className="text-xs text-white/50">{card.text}</p>
                    <p className="mt-1 text-[11px] text-white/40">la propuso {card.proposedBy ?? "alguien"}</p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        variant="success"
                        onClick={() => run(() => reviewCard({ partyId, hostToken, cardId: card.id, approve: true }))}
                      >
                        Aprobar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => run(() => reviewCard({ partyId, hostToken, cardId: card.id, approve: false }))}
                      >
                        Rechazar
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <HostCardForm onSubmit={(card) => run(() => addHostCard({ partyId, hostToken, ...card }))} busy={busy} />
          </Card>

          <Card title="Playlists">
            <PlaylistForm
              busy={busy}
              onImport={(url) => run(() => addPlaylist({ partyId, hostToken, url }))}
              onManual={(track) => run(() => addManualTrack({ partyId, hostToken, ...track }))}
            />
            <ul className="mt-3 space-y-2">
              {view.playlists.length === 0 && (
                <li className="text-sm text-white/50">Todavía no hay listas.</li>
              )}
              {view.playlists.map((playlist) => (
                <li key={playlist.id} className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{playlist.title}</p>
                    <p className="text-[11px] text-white/40">
                      {playlist.trackCount} temas · {playlist.totalMinutes} min
                      {playlist.unplayable > 0 && ` · ${playlist.unplayable} no reproducibles`}
                      {playlist.played && " · ya sonó"}
                    </p>
                  </div>
                  {(view.phase === "lobby" || view.phase === "ended") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => run(() => removePlaylist({ partyId, hostToken, playlistId: playlist.id }))}
                    >
                      Quitar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <SettingsCard
            busy={busy}
            settings={view.settings}
            onSave={(settings) => run(() => updateSettings({ partyId, hostToken, settings }))}
          />

          <Card title={`Invitados (${view.guests.length})`}>
            {view.guests.length === 0 ? (
              <p className="text-sm text-white/50">Nadie entró todavía. Compartí el QR o el código.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {view.guests.map((guest) => (
                  <li key={guest.id} className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-xs">
                    {guest.nickname}
                    <button
                      type="button"
                      className="text-white/40 hover:text-red-300"
                      title="Expulsar"
                      onClick={() => run(() => kickGuest({ partyId, hostToken, guestId: guest.id }))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Historial">
            <ul className="space-y-1 text-xs text-white/50">
              {view.log.slice(0, 12).map((entry, i) => (
                <li key={`${entry.at}-${i}`} className="flex gap-2">
                  <span className="shrink-0 text-white/30">
                    {new Date(entry.at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="truncate">{entry.detail}</span>
                </li>
              ))}
              {view.log.length === 0 && <li>Sin novedades todavía.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </main>
  );
}

function PlaylistForm({
  onImport,
  onManual,
  busy,
}: {
  onImport: (url: string) => void;
  onManual: (track: { url: string; title: string; durationSec: number; playlistTitle: string }) => void;
  busy: boolean;
}) {
  const [url, setUrl] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [manual, setManual] = useState({ url: "", title: "", minutes: "4", seconds: "0" });

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={url}
          onChange={setUrl}
          placeholder="https://www.youtube.com/playlist?list=…"
          onEnter={() => {
            if (!url.trim()) return;
            onImport(url);
            setUrl("");
          }}
        />
        <Button
          disabled={busy || !url.trim()}
          onClick={() => {
            onImport(url);
            setUrl("");
          }}
        >
          Importar
        </Button>
      </div>

      <button
        type="button"
        className="text-[11px] text-white/40 underline hover:text-white/70"
        onClick={() => setShowManual((value) => !value)}
      >
        {showManual ? "Ocultar carga manual" : "¿No se puede importar? Cargar un tema a mano"}
      </button>

      {showManual && (
        <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
          <Input
            value={manual.url}
            onChange={(value) => setManual({ ...manual, url: value })}
            placeholder="Link del video (o el id)"
          />
          <Input
            value={manual.title}
            onChange={(value) => setManual({ ...manual, title: value })}
            placeholder="Título"
          />
          <div className="flex items-center gap-2">
            <Input
              value={manual.minutes}
              type="number"
              min={0}
              max={60}
              onChange={(value) => setManual({ ...manual, minutes: value })}
              placeholder="min"
            />
            <Input
              value={manual.seconds}
              type="number"
              min={0}
              max={59}
              onChange={(value) => setManual({ ...manual, seconds: value })}
              placeholder="seg"
            />
            <Button
              disabled={busy || !manual.url.trim() || !manual.title.trim()}
              onClick={() => {
                onManual({
                  url: manual.url,
                  title: manual.title,
                  durationSec: Number(manual.minutes) * 60 + Number(manual.seconds),
                  playlistTitle: "Temas sueltos",
                });
                setManual({ url: "", title: "", minutes: "4", seconds: "0" });
              }}
            >
              Agregar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function HostCardForm({
  onSubmit,
  busy,
}: {
  onSubmit: (card: { title: string; text: string; emoji: string; durationSec: number }) => void;
  busy: boolean;
}) {
  const [form, setForm] = useState({ title: "", text: "", emoji: "🎉", seconds: "90" });

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={form.emoji}
          onChange={(value) => setForm({ ...form, emoji: value })}
          className="w-14 text-center"
          placeholder="🎉"
        />
        <Input
          value={form.title}
          onChange={(value) => setForm({ ...form, title: value })}
          placeholder="Tu carta (ej. Todos cantan el estribillo)"
        />
      </div>
      <div className="flex gap-2">
        <Input
          value={form.text}
          onChange={(value) => setForm({ ...form, text: value })}
          placeholder="Qué tiene que pasar"
        />
        <Input
          value={form.seconds}
          type="number"
          min={20}
          max={300}
          className="w-24"
          onChange={(value) => setForm({ ...form, seconds: value })}
        />
        <Button
          disabled={busy || !form.title.trim()}
          onClick={() => {
            onSubmit({
              title: form.title,
              text: form.text,
              emoji: form.emoji || "🎉",
              durationSec: Number(form.seconds),
            });
            setForm({ title: "", text: "", emoji: "🎉", seconds: "90" });
          }}
        >
          Sumar
        </Button>
      </div>
    </div>
  );
}

function SettingsCard({
  settings,
  onSave,
  busy,
}: {
  settings: HostView["settings"];
  onSave: (settings: HostView["settings"]) => void;
  busy: boolean;
}) {
  // Sin estado duplicado ni efectos: si hay cambios sin guardar se usa el borrador,
  // y si no, lo que dice el servidor.
  const [draftState, setDraftState] = useState<HostView["settings"] | null>(null);
  const draft = draftState ?? settings;
  const setDraft = (next: HostView["settings"]) => setDraftState(next);

  const field = (
    label: string,
    key: keyof HostView["settings"],
    min: number,
    max: number,
  ) => (
    <label className="flex items-center justify-between gap-2 text-xs text-white/60">
      {label}
      <Input
        value={draft[key] as number}
        type="number"
        min={min}
        max={max}
        className="w-20"
        onChange={(value) => setDraft({ ...draft, [key]: Number(value) })}
      />
    </label>
  );

  return (
    <Card title="Reglas de la fiesta">
      <div className="space-y-2">
        {field("Tope de cada bloque (min)", "blockMaxMinutes", 5, 180)}
        {field("Abrir votación con N temas", "voteLeadTracks", 0, 10)}
        {field("Abrir votación con N min restantes", "voteLeadMinutes", 0, 60)}
        {field("Duración de la votación (seg)", "voteWindowSeconds", 20, 300)}

        <label className="flex items-center justify-between gap-2 text-xs text-white/60">
          Cartas de acción
          <select
            value={draft.actionFrequency}
            onChange={(event) =>
              setDraft({
                ...draft,
                actionFrequency: event.target.value as HostView["settings"]["actionFrequency"],
              })
            }
            className="rounded-lg border border-white/15 bg-black/30 px-2 py-1 text-xs text-white"
          >
            <option value="never">Nunca</option>
            <option value="sometimes">A veces</option>
            <option value="always">Siempre</option>
          </select>
        </label>

        <label className="flex items-center justify-between gap-2 text-xs text-white/60">
          Aprobar solas las cartas de invitados
          <input
            type="checkbox"
            checked={draft.autoApproveCards}
            onChange={(event) => setDraft({ ...draft, autoApproveCards: event.target.checked })}

            className="size-4 accent-fuchsia-500"
          />
        </label>

        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            onSave(draft);
            setDraftState(null);
          }}
        >
          Guardar reglas
        </Button>
      </div>
    </Card>
  );
}
