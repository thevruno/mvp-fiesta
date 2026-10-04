/**
 * Vistas: traducción del estado interno a lo que ve el anfitrión y a lo que ven
 * los invitados. Nada de tokens ni datos privados, y sin cálculos en el cliente.
 */

import { z } from "zod";
import { currentTrack, tracksOf } from "@/domain/machine";
import type { GuestView, HostView, Party } from "@/server/ports";

export const settingsSchema = z.object({
  blockMaxMinutes: z.number().int().min(5).max(180),
  voteLeadTracks: z.number().int().min(0).max(10),
  voteLeadMinutes: z.number().int().min(0).max(60),
  voteWindowSeconds: z.number().int().min(20).max(300),
  actionFrequency: z.enum(["never", "sometimes", "always"]),
  autoApproveCards: z.boolean(),
});

export function mergeMarkers(current: GuestView, incoming: GuestView): GuestView {
  if (!current.round || !incoming.round || current.round.id !== incoming.round.id) {
    return incoming;
  }
  return {
    ...incoming,
    round: {
      ...incoming.round,
      myVote: incoming.round.myVote ?? current.round.myVote,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Lecturas                                                            */
/* ------------------------------------------------------------------ */

export function toGuestView(party: Party, guestId?: string): GuestView {
  const state = party.state;
  const track = currentTrack(state);
  const playlist = state.block
    ? state.playlists.find((p) => p.id === state.block!.playlistId) ?? null
    : null;
  const round = state.round ?? null;

  const roundView = round
    ? {
        id: round.id,
        closesAt: round.closesAt,
        status: round.status,
        options: round.options.map((option) => {
          const voters = Object.entries(round.votes)
            .filter(([, optionId]) => optionId === option.id)
            .map(([voterId]) => party.guests[voterId]?.nickname ?? "?");
          const card = option.actionCardId
            ? state.cards.find((c) => c.id === option.actionCardId) ?? null
            : null;
          const list = option.playlistId
            ? state.playlists.find((p) => p.id === option.playlistId) ?? null
            : null;

          return {
            id: option.id,
            kind: option.kind,
            title: list?.title ?? card?.title ?? "?",
            subtitle:
              option.kind === "playlist"
                ? `${list?.tracks.length ?? 0} temas`
                : card?.text ?? "",
            emoji: card?.emoji ?? "🎵",
            votes: voters.length,
            voters,
          };
        }),
        myVote: guestId ? round.votes[guestId] ?? null : null,
        winnerOptionId: round.winnerOptionId,
      }
    : null;

  return {
    partyId: party.id,
    partyName: party.name,
    phase: state.phase,
    locked: party.locked,
    serverNow: Date.now(),
    version: state.version,
    deadline: state.phaseDeadline,
    currentTrack: track
      ? { title: track.title, videoId: track.videoId, playlistTitle: playlist?.title ?? "" }
      : null,
    currentPlaylist: playlist
      ? {
          id: playlist.id,
          title: playlist.title,
          playedCount: state.block ? state.block.index : 0,
          total: state.block ? state.block.trackIds.length : 0,
        }
      : null,
    blockProgress: state.block
      ? { index: state.block.index, total: state.block.trackIds.length }
      : null,
    round: roundView,
    activeAction: state.activeAction
      ? (() => {
          const card = state.cards.find((c) => c.id === state.activeAction!.cardId);
          if (!card) return null;
          return {
            title: card.title,
            text: card.text,
            emoji: card.emoji,
            durationSec: card.durationSec,
            endsAt: state.activeAction!.endsAt,
          };
        })()
      : null,
    guests: Object.values(party.guests).map((g) => ({ nickname: g.nickname })),
    cardQueue: state.cards
      .filter((c) => c.origin === "guest")
      .map((c) => ({
        id: c.id,
        title: c.title,
        text: c.text,
        emoji: c.emoji,
        status: c.status,
      })),
    hostLost: state.hostLostSince !== null,
  };
}

export function toHostView(party: Party): HostView {
  const state = party.state;
  const track = currentTrack(state);
  const playlist = state.block
    ? state.playlists.find((p) => p.id === state.block!.playlistId) ?? null
    : null;
  const guestView = toGuestView(party);

  const queue = state.block
    ? state.block.trackIds.slice(state.block.index).map((videoId, i) => {
        const t = tracksOf(state, state.block!.playlistId).find((x) => x.videoId === videoId);
        return {
          index: state.block!.index + i,
          videoId,
          title: t?.title ?? videoId,
          durationSec: t?.durationSec ?? 0,
        };
      })
    : [];

  return {
    partyId: party.id,
    code: party.code,
    joinUrl: "",
    name: party.name,
    phase: state.phase,
    serverNow: Date.now(),
    version: state.version,
    deadline: state.phaseDeadline,
    locked: party.locked,
    settings: state.settings,
    currentTrack:
      track && state.block
        ? {
            videoId: track.videoId,
            title: track.title,
            durationSec: track.durationSec,
            playlistTitle: playlist?.title ?? "",
            index: state.block.index,
            total: state.block.trackIds.length,
            startedAt: state.trackStartedAt,
          }
        : null,
    queue,
    round: guestView.round,
    pendingWinner: (() => {
      const optionId = state.pendingWinnerOptionId;
      if (!optionId) return null;
      const option = state.round?.options.find((o) => o.id === optionId);
      if (!option) return null;
      const title =
        guestView.round?.options.find((o) => o.id === optionId)?.title ?? "";
      return { optionId, title, kind: option.kind };
    })(),
    activeAction: guestView.activeAction,
    playlists: state.playlists.map((p) => ({
      id: p.id,
      title: p.title,
      trackCount: p.tracks.length,
      unplayable: p.tracks.filter((t) => !t.embeddable).length,
      played: p.played,
      totalMinutes: Math.round(p.tracks.reduce((acc, t) => acc + t.durationSec, 0) / 60),
    })),
    pendingCards: state.cards
      .filter((c) => c.status === "pending")
      .map((c) => ({
        id: c.id,
        title: c.title,
        text: c.text,
        emoji: c.emoji,
        proposedBy: c.proposedBy,
      })),
    approvedCards: state.cards.filter((c) => c.status === "approved").length,
    guests: Object.values(party.guests),
    hostLost: state.hostLostSince !== null,
    log: party.log,
  };
}

