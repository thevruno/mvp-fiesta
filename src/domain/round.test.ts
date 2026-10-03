import { describe, expect, it } from "vitest";
import { mulberry32 } from "./random";
import {
  closeRound,
  composeRound,
  isPlayableRound,
  pickWinner,
  resolveVoteCloseAt,
  shouldOpenVoting,
  tallyVotes,
} from "./round";
import { MIN_VOTE_WINDOW_SECONDS, type ActionCard, type Playlist, type Round, type RoundOption } from "./types";

const playlist = (id: string, played = false): Playlist => ({
  id,
  title: id,
  tracks: [],
  maxMinutes: null,
  played,
});

const card = (id: string): ActionCard => ({
  id,
  title: id,
  text: "",
  durationSec: 90,
  emoji: "🎉",
  origin: "preset",
  status: "approved",
  proposedBy: null,
});

const option = (id: string): RoundOption => ({
  id,
  kind: "playlist",
  playlistId: id,
  actionCardId: null,
});

describe("shouldOpenVoting", () => {
  const base = { voteLeadMinutes: 10, voteLeadTracks: 3 };

  it("abre cuando quedan pocos temas", () => {
    expect(shouldOpenVoting({ ...base, remainingSec: 3000, remainingTracks: 3 })).toBe(true);
  });

  it("abre cuando queda poco tiempo, aunque queden muchos temas", () => {
    expect(shouldOpenVoting({ ...base, remainingSec: 600, remainingTracks: 20 })).toBe(true);
  });

  it("no abre si todavía falta bastante", () => {
    expect(shouldOpenVoting({ ...base, remainingSec: 1800, remainingTracks: 8 })).toBe(false);
  });
});

describe("resolveVoteCloseAt", () => {
  const now = 1_000_000;

  it("cierra dentro de la ventana si el bloque sigue", () => {
    const closes = resolveVoteCloseAt({ now, blockEndsAt: now + 600_000, voteWindowSeconds: 60 });
    expect(closes).toBe(now + 60_000);
  });

  it("acorta la ventana para cerrar antes del final del bloque", () => {
    const closes = resolveVoteCloseAt({ now, blockEndsAt: now + 90_000, voteWindowSeconds: 60 });
    expect(closes).toBe(now + 60_000);

    const tight = resolveVoteCloseAt({ now, blockEndsAt: now + 30_000, voteWindowSeconds: 60 });
    expect(tight).toBe(now + 30_000);
  });

  it("nunca deja la ventana por debajo del mínimo", () => {
    const closes = resolveVoteCloseAt({ now, blockEndsAt: now + 2_000, voteWindowSeconds: 60 });
    expect(closes).toBe(now + MIN_VOTE_WINDOW_SECONDS * 1000);
  });
});

describe("composeRound", () => {
  const playlists = [playlist("a"), playlist("b"), playlist("c"), playlist("d")];

  it("con acciones desactivadas propone hasta 3 listas", () => {
    const { options } = composeRound({
      playlists,
      cards: [card("k1")],
      currentPlaylistId: null,
      lastPlayedPlaylistId: null,
      actionFrequency: "never",
      allPlaylists: playlists,
      random: mulberry32(1),
    });
    expect(options).toHaveLength(3);
    expect(options.every((o) => o.kind === "playlist")).toBe(true);
    expect(new Set(options.map((o) => o.playlistId)).size).toBe(3);
  });

  it("con acciones en 'always' propone 2 listas + 1 carta", () => {
    const { options } = composeRound({
      playlists,
      cards: [card("k1")],
      currentPlaylistId: null,
      lastPlayedPlaylistId: null,
      actionFrequency: "always",
      allPlaylists: playlists,
      random: mulberry32(1),
    });
    expect(options.filter((o) => o.kind === "playlist")).toHaveLength(2);
    expect(options.filter((o) => o.kind === "action")).toHaveLength(1);
  });

  it("no repite la lista que está sonando", () => {
    const { options } = composeRound({
      playlists,
      cards: [],
      currentPlaylistId: "a",
      lastPlayedPlaylistId: "a",
      actionFrequency: "never",
      allPlaylists: playlists,
      random: mulberry32(7),
    });
    expect(options.some((o) => o.playlistId === "a")).toBe(false);
  });

  it("recicla el pozo cuando no queda ninguna lista sin sonar", () => {
    const played = [playlist("a", true), playlist("b", true), playlist("c", true)];
    const { options, recycledPlaylists } = composeRound({
      playlists: played,
      cards: [card("k1")],
      currentPlaylistId: "c",
      lastPlayedPlaylistId: "c",
      actionFrequency: "always",
      allPlaylists: played,
      random: mulberry32(3),
    });
    expect(recycledPlaylists).toBe(true);
    // No puede volver a salir la última sonada.
    expect(options.some((o) => o.playlistId === "c")).toBe(false);
    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  it("usa la carta como comodín si no hay listas suficientes", () => {
    const only = [playlist("a"), playlist("b")];
    const { options } = composeRound({
      playlists: only,
      cards: [card("k1")],
      currentPlaylistId: "a",
      lastPlayedPlaylistId: "a",
      actionFrequency: "never",
      allPlaylists: only,
      random: mulberry32(9),
    });
    // Solo queda "b" en el pozo: sin la carta la ronda quedaría con 1 opción.
    expect(options).toHaveLength(2);
    expect(options.some((o) => o.kind === "action")).toBe(true);
  });

  it("da la misma ronda con la misma semilla (auditable)", () => {
    const input = {
      playlists,
      cards: [card("k1")],
      currentPlaylistId: null,
      lastPlayedPlaylistId: null,
      actionFrequency: "sometimes" as const,
      allPlaylists: playlists,
    };
    const first = composeRound({ ...input, random: mulberry32(42) });
    const second = composeRound({ ...input, random: mulberry32(42) });
    expect(first.options).toEqual(second.options);
  });

  it("considera jugable solo una ronda con 2+ opciones", () => {
    expect(isPlayableRound([option("a")])).toBe(false);
    expect(isPlayableRound([option("a"), option("b")])).toBe(true);
  });
});

describe("tallyVotes", () => {
  const options = [option("a"), option("b"), option("c")];

  it("cuenta un voto por invitado y suma el total", () => {
    const { counts, top, totalVotes } = tallyVotes(options, { g1: "a", g2: "a", g3: "b" });
    expect(counts).toEqual({ a: 2, b: 1, c: 0 });
    expect(top).toEqual(["a"]);
    expect(totalVotes).toBe(3);
  });

  it("devuelve empate con las opciones más votadas", () => {
    const { top } = tallyVotes(options, { g1: "a", g2: "b" });
    expect(top.sort()).toEqual(["a", "b"]);
  });

  it("con cero votos todas las opciones empatan", () => {
    const { top, totalVotes } = tallyVotes(options, {});
    expect(top).toHaveLength(3);
    expect(totalVotes).toBe(0);
  });

  it("ignora votos a opciones que ya no están en la ronda", () => {
    const { totalVotes } = tallyVotes(options, { g1: "a", g2: "fantasma" });
    expect(totalVotes).toBe(1);
  });
});

describe("pickWinner", () => {
  const options = [option("a"), option("b"), option("c")];

  it("gana la más votada", () => {
    expect(pickWinner(options, { g1: "b", g2: "b", g3: "a" }, 1)).toBe("b");
  });

  it("desempata al azar y el resultado es reproducible con la misma semilla", () => {
    const votes = { g1: "a", g2: "b" };
    const one = pickWinner(options, votes, 12345);
    const two = pickWinner(options, votes, 12345);
    expect(one).toBe(two);
    expect(["a", "b"]).toContain(one);
  });

  it("con cero votos también elige al azar", () => {
    const winner = pickWinner(options, {}, 7);
    expect(options.map((o) => o.id)).toContain(winner);
  });

  it("devuelve null si no hay opciones", () => {
    expect(pickWinner([], {}, 1)).toBeNull();
  });
});

describe("closeRound", () => {
  const round: Round = {
    id: "r1",
    idx: 1,
    opensAt: 0,
    closesAt: 60_000,
    status: "open",
    options: [option("a"), option("b")],
    votes: { g1: "a" },
    winnerOptionId: null,
    seed: 99,
    tiebreakSeed: null,
  };

  it("guarda ganador y semilla del desempate", () => {
    const closed = closeRound(round, 555);
    expect(closed.status).toBe("closed");
    expect(closed.winnerOptionId).toBe("a");
    expect(closed.tiebreakSeed).toBe(555);
    expect(closed.seed).toBe(99); // la semilla de composición no se pisa
  });
});
