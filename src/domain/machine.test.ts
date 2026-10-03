import { describe, expect, it } from "vitest";
import { createPartyState, currentTrack, reduce } from "./machine";
import { mulberry32 } from "./random";
import { remainingSeconds } from "./block";
import {
  DEFAULT_SETTINGS,
  type ActionCard,
  type Effect,
  type PartyEvent,
  type PartySettings,
  type PartyState,
  type Playlist,
  type Round,
  type Track,
} from "./types";

/* ------------------------------------------------------------------ */
/* Banquillo de pruebas                                                */
/* ------------------------------------------------------------------ */

const track = (videoId: string, durationSec: number, embeddable = true): Track => ({
  videoId,
  title: videoId,
  durationSec,
  embeddable,
});

const playlist = (id: string, durations: number[], played = false): Playlist => ({
  id,
  title: id,
  tracks: durations.map((d, i) => track(`${id}-${i}`, d)),
  maxMinutes: null,
  played,
});

const card = (id: string, durationSec = 90): ActionCard => ({
  id,
  title: id,
  text: "Brindar con lo que tengas",
  durationSec,
  emoji: "🥂",
  origin: "preset",
  status: "approved",
  proposedBy: null,
});

interface Harness {
  state: PartyState;
  effects: Effect[];
  /** Corre la fiesta hasta el segundo indicado, ejecutando cada transición. */
  run(seconds: number, hook?: (h: Harness) => void): Harness;
  send(event: PartyEvent): Harness;
  /** Espera lo que tardaría el anfitrión en reportar el tema actual. */
  trackStartedAt(seconds: number): Harness;
}

function harness(
  playlists: Playlist[],
  cards: ActionCard[] = [],
  settings: Partial<PartySettings> = {},
  options: { autoHost?: boolean } = {},
): Harness {
  const autoHost = options.autoHost ?? true;
  const rand = mulberry32(20261002);
  let clock = 0;
  let state = createPartyState("p1", { ...DEFAULT_SETTINGS, ...settings }, playlists, cards);
  let effects: Effect[] = [];

  /** El anfitrión ideal: reproduce los temas y reporta lo que pasa. */
  const reportStart = () => {
    if (!autoHost) return;
    if (state.phase !== "playing" || !state.block) return;

    const trackNow = currentTrack(state);
    if (!trackNow) return;

    // Todavía no arrancó el tema en curso.
    if (state.trackStartedAt === null) {
      api.send({ type: "TRACK_STARTED", videoId: trackNow.videoId });
      return;
    }

    // El reproductor ya pasó al tema siguiente (o terminó el bloque).
    const endsAt = state.trackStartedAt + trackNow.durationSec * 1000;
    if (clock < endsAt) return;

    const nextVideoId = state.block.trackIds[state.block.index + 1];
    if (nextVideoId !== undefined) {
      api.send({ type: "TRACK_STARTED", videoId: nextVideoId });
    } else {
      api.send({ type: "TRACK_ENDED", videoId: trackNow.videoId });
    }
  };

  const api: Harness = {
    get state() {
      return state;
    },
    get effects() {
      return effects;
    },
    run(seconds, hook) {
      const target = seconds * 1000;
      let guard = 0;

      while (guard++ < 500) {
        reportStart();
        hook?.(api);
        const pending = state.phaseDeadline;
        if (pending === null || pending > target) break;
        clock = Math.max(clock, pending);
        api.send({ type: "ADVANCE", expectedVersion: state.version });
        hook?.(api);
      }

      clock = Math.max(clock, target);
      reportStart();
      hook?.(api);
      return api;
    },
    send(event) {
      const result = reduce(state, event, { now: clock, random: rand });
      state = result.state;
      effects = result.effects;
      return api;
    },
    trackStartedAt(seconds) {
      clock = seconds * 1000;
      reportStart();
      return api;
    },
  };

  return api;
}

interface RoundSnapshot {
  round: Round;
  index: number;
  total: number;
  remainingSec: number;
}

/** Índice, cantidad de temas y tiempo restante cuando se abrió la ronda. */
function whenRoundOpened(h: Harness, untilSeconds = 3600): RoundSnapshot | null {
  const box: { value: RoundSnapshot | null } = { value: null };
  h.send({ type: "START_PARTY" });

  h.run(untilSeconds, (s) => {
    if (box.value || s.state.phase !== "playing") return;
    const round = s.state.round;
    const block = s.state.block;
    if (!round || !block) return;

    const tracks = s.state.playlists.find((p) => p.id === block.playlistId)!.tracks;
    box.value = {
      round,
      index: block.index,
      total: block.trackIds.length,
      remainingSec: remainingSeconds(tracks, block.index),
    };
  });

  return box.value;
}

/** Corre la fiesta y devuelve la primera ronda que llegó a cerrarse. */
function firstClosedRound(
  h: Harness,
  untilSeconds = 3600,
  hook?: (h: Harness, round: Round) => void,
): Round | null {
  const box: { value: Round | null } = { value: null };
  h.send({ type: "START_PARTY" });

  h.run(untilSeconds, (s) => {
    const round = s.state.round;
    if (!round) return;
    if (round.status === "open") hook?.(s, round);
    else if (!box.value) box.value = round;
  });

  return box.value;
}

/* ------------------------------------------------------------------ */
/* Lobby y arranque                                                    */
/* ------------------------------------------------------------------ */

describe("lobby", () => {
  it("no arranca sin listas", () => {
    const h = harness([]).send({ type: "START_PARTY" });
    expect(h.state.phase).toBe("lobby");
    expect(h.effects).toHaveLength(0);
  });

  it("arranca la fiesta y manda a reproducir el primer bloque", () => {
    const h = harness([playlist("a", [200, 200, 200])]).send({ type: "START_PARTY" }).state;

    expect(h.phase).toBe("playing");
    expect(h.version).toBe(1);
    expect(h.block?.trackIds).toEqual(["a-0", "a-1", "a-2"]);
    expect(h.block?.roundOpened).toBe(false);
    expect(h.playlists.find((p) => p.id === "a")?.played).toBe(true);
  });

  it("respeta el tope de minutos al armar el primer bloque", () => {
    const h = harness([playlist("a", [600, 600, 600])], [], { blockMaxMinutes: 30 })
      .send({ type: "START_PARTY" }).state;

    // 30 min = 1800 s → entran 3 temas de 600 s.
    expect(h.block?.trackIds).toHaveLength(3);

    const ajustado = harness([playlist("a", [600, 600, 600])], [], { blockMaxMinutes: 15 })
      .send({ type: "START_PARTY" }).state;
    expect(ajustado.block?.trackIds).toEqual(["a-0"]); // 600 s de 900 s
  });
});

/* ------------------------------------------------------------------ */
/* Reproductor                                                        */
/* ------------------------------------------------------------------ */

describe("reproductor", () => {
  it("el anfitrión reporta el inicio y se agenda el fin del tema", () => {
    const h = harness([playlist("a", [200, 200, 200])])
      .send({ type: "START_PARTY" })
      .trackStartedAt(0);

    expect(h.state.trackStartedAt).toBe(0);
    expect(h.state.phaseDeadline).toBe(200_000);
    expect(h.effects).toEqual([]); // no hay nada más que hacer todavía
  });

  it("avanza al tema siguiente del bloque al terminar", () => {
    const h = harness([playlist("a", [200, 200, 200])], [], { voteLeadTracks: 0, voteLeadMinutes: 0 });
    h.send({ type: "START_PARTY" });
    h.run(200);

    expect(h.state.block?.index).toBe(1);
    expect(h.state.trackStartedAt).toBe(200_000);
  });

  it("saltea un tema roto y avisa al anfitrión", () => {
    const h = harness([playlist("a", [200, 200])])
      .send({ type: "START_PARTY" })
      .send({ type: "TRACK_STARTED", videoId: "a-0" })
      .send({ type: "TRACK_FAILED", videoId: "a-0" });

    expect(h.state.block?.index).toBe(1);
    expect(h.state.playlists[0].tracks[0].embeddable).toBe(false);
    expect(h.effects[0]).toMatchObject({ type: "TRACK_ERROR", videoId: "a-0" });
    expect(h.effects.some((e) => e.type === "PLAY_TRACK" && e.videoId === "a-1")).toBe(true);
  });

  it("ignora reportes de temas que no son de este bloque", () => {
    const h = harness([playlist("a", [200, 200])])
      .send({ type: "START_PARTY" })
      .send({ type: "TRACK_STARTED", videoId: "de-otra-lista" });

    expect(h.state.trackStartedAt).toBeNull();
  });

  it("si el anfitrión salta a otro tema del bloque, el estado lo sigue", () => {
    const h = harness([playlist("a", [200, 200, 200])])
      .send({ type: "START_PARTY" })
      .send({ type: "TRACK_STARTED", videoId: "a-2" });

    expect(h.state.block?.index).toBe(2);
    expect(h.state.trackStartedAt).toBe(0);
    expect(h.state.phaseDeadline).toBe(200_000);
  });

  it("insiste con el tema si el anfitrión nunca reporta el inicio", () => {
    const h = harness([playlist("a", [200])], [], {}, { autoHost: false }).send({
      type: "START_PARTY",
    });
    h.run(21);

    expect(h.effects.some((e) => e.type === "PLAY_TRACK")).toBe(true);
    expect(h.state.block?.index).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Votación                                                            */
/* ------------------------------------------------------------------ */

describe("votación", () => {
  /** Tres listas de 5 temas de 3:20 → siempre hay bloque largo. */
  const largas = () => [
    playlist("a", [200, 200, 200, 200, 200]),
    playlist("b", [200, 200, 200, 200, 200]),
    playlist("c", [200, 200, 200, 200, 200]),
  ];

  it("abre la ronda cuando quedan 3 temas o menos", () => {
    const snapshot = whenRoundOpened(harness(largas(), [card("k1")], { actionFrequency: "never" }), 600);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.round.status).toBe("open");
    expect(snapshot!.total - snapshot!.index).toBe(3);
    expect(snapshot!.round.options.length).toBeGreaterThanOrEqual(2);
  });

  it("abre la ronda cuando queda poco tiempo aunque queden muchos temas", () => {
    // 3 temas de 100 s = 300 s de bloque; el disparo es por tiempo, no por temas.
    const cortas = [
      playlist("a", [100, 100, 100]),
      playlist("b", [100, 100, 100]),
      playlist("c", [100, 100, 100]),
    ];
    const snapshot = whenRoundOpened(
      harness(cortas, [], { voteLeadMinutes: 5, voteLeadTracks: 0 }),
      120,
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot!.remainingSec).toBeLessThanOrEqual(300);
    expect(snapshot!.total - snapshot!.index).toBe(3);
  });

  it("no abre la ronda por tiempo si falta más de lo configurado", () => {
    const h = harness(largas(), [], { voteLeadMinutes: 5, voteLeadTracks: 0 });
    h.send({ type: "START_PARTY" });
    h.run(100); // quedan 900 s y 5 temas

    expect(h.state.round).toBeNull();
  });

  it("usa la ventana completa cuando el bloque tiene resto", () => {
    const holgado = whenRoundOpened(harness(largas(), [], { voteWindowSeconds: 60 }), 600)!;
    expect(holgado.round.closesAt - holgado.round.opensAt).toBe(60_000);
  });

  it("acorta la ventana para que cierre antes del final del bloque", () => {
    // Bloques de 25 s: la ventana de 60 s se acorta a 25 s.
    const cortas = [
      playlist("a", [5, 5, 5, 5, 5]),
      playlist("b", [5, 5, 5, 5, 5]),
      playlist("c", [5, 5, 5, 5, 5]),
    ];
    const apretado = whenRoundOpened(harness(cortas, [], { voteWindowSeconds: 60 }), 60)!;
    expect(apretado.round.closesAt - apretado.round.opensAt).toBe(25_000);
  });

  it("nunca deja la ventana por debajo del mínimo de 20 s", () => {
    // Bloque de 10 s: la ventana cerraría antes del mínimo, así que se estira.
    const cortas = [playlist("a", [10]), playlist("b", [10]), playlist("c", [10])];
    const apretado = whenRoundOpened(harness(cortas, [], { voteWindowSeconds: 60 }), 60)!;
    expect(apretado.round.closesAt - apretado.round.opensAt).toBe(20_000);
  });

  it("un invitado puede cambiar el voto hasta el cierre", () => {
    const h = harness(largas(), [], { actionFrequency: "never" });
    h.send({ type: "START_PARTY" });

    let voted = false;
    h.run(600, (s) => {
      const round = s.state.round;
      if (voted || !round || round.status !== "open") return;
      const [o1, o2] = round.options;
      s.send({ type: "CAST_VOTE", guestId: "g1", optionId: o1.id });
      expect(s.state.round?.votes.g1).toBe(o1.id);
      s.send({ type: "CAST_VOTE", guestId: "g1", optionId: o2.id });
      expect(s.state.round?.votes.g1).toBe(o2.id);
      expect(Object.keys(s.state.round!.votes)).toHaveLength(1);
      voted = true;
    });

    expect(voted).toBe(true);
  });

  it("rechaza votos fuera de la ronda o después del cierre", () => {
    const h = harness(largas(), [], { actionFrequency: "never" });
    h.send({ type: "START_PARTY" });

    h.run(600, (s) => {
      const round = s.state.round;
      if (!round || round.status !== "open") return;
      const before = s.state.version;
      s.send({ type: "CAST_VOTE", guestId: "g1", optionId: "inventada" });
      expect(s.state.version).toBe(before);
      s.send({ type: "CAST_VOTE", guestId: "g1", optionId: round.options[0].id });
      expect(s.state.round?.votes.g1).toBe(round.options[0].id);
    });

    // Una vez cerrada, los votos nuevos se ignoran.
    const closed = h.state.round!;
    h.send({ type: "CAST_VOTE", guestId: "tarde", optionId: closed.options[0].id });
    expect(h.state.round?.votes.tarde).toBeUndefined();
  });

  it("el ganador se aplica recién cuando termina el bloque", () => {
    const h = harness(largas(), [], { actionFrequency: "never", voteWindowSeconds: 30 });
    h.send({ type: "START_PARTY" });

    const box: {
      elegida: string | null;
      elegidaPlaylist: string | null;
      alCerrar: { phase: string; playlistId: string | undefined; quedaba: boolean } | null;
      arrancoElGanador: { index: number; playlistId: string } | null;
    } = { elegida: null, elegidaPlaylist: null, alCerrar: null, arrancoElGanador: null };

    h.run(1200, (s) => {
      const round = s.state.round;

      if (round?.status === "open" && !box.elegida) {
        const opcion = round.options.find((o) => o.kind === "playlist")!;
        box.elegida = opcion.id;
        box.elegidaPlaylist = opcion.playlistId;
        s.send({ type: "CAST_VOTE", guestId: "g1", optionId: box.elegida });
      }

      if (round?.status === "closed" && !box.alCerrar) {
        box.alCerrar = {
          phase: s.state.phase,
          playlistId: s.state.block?.playlistId,
          quedaba: Boolean(s.state.block),
        };
      }

      // El bloque nuevo arranca recién cuando termina el actual.
      if (
        box.alCerrar &&
        !box.arrancoElGanador &&
        s.state.block &&
        s.state.block.playlistId !== box.alCerrar.playlistId
      ) {
        box.arrancoElGanador = {
          index: s.state.block.index,
          playlistId: s.state.block.playlistId,
        };
      }
    });

    expect(box.alCerrar).not.toBeNull();
    // La votación se cerró mientras la música seguía: misma lista, fase playing.
    expect(box.alCerrar!.phase).toBe("playing");
    expect(box.alCerrar!.quedaba).toBe(true);
    // Y el ganador se aplicó al terminar el bloque, arrancando por el tema 0.
    expect(box.arrancoElGanador).not.toBeNull();
    expect(box.arrancoElGanador!.index).toBe(0);
    expect(box.arrancoElGanador!.playlistId).toBe(box.elegidaPlaylist);
  });

  it("si la ventana sigue abierta al terminar el bloque, queda en fase voting", () => {
    // Un bloque de 10 s con ventana de 60 s: la votación no llega a cerrar antes.
    const cortas = [playlist("a", [10]), playlist("b", [10]), playlist("c", [10])];
    const h = harness(cortas, [], { actionFrequency: "never", voteWindowSeconds: 60 });
    h.send({ type: "START_PARTY" });

    let vioVoting = false;
    h.run(200, (s) => {
      if (s.state.phase === "voting") vioVoting = true;
      const round = s.state.round;
      if (round?.status === "open" && !round.votes.g1) {
        s.send({ type: "CAST_VOTE", guestId: "g1", optionId: round.options[0].id });
      }
    });

    expect(vioVoting).toBe(true);
    expect(h.state.phase).toBe("playing"); // ya eligió y arrancó el bloque siguiente
    expect(h.state.pendingWinnerOptionId).toBeNull();
  });

  it("empate se resuelve al azar, con la semilla guardada", () => {
    let empataron = false;
    const ronda = firstClosedRound(
      harness(largas(), [], { actionFrequency: "never", voteWindowSeconds: 30 }),
      3600,
      (s, round) => {
        if (empataron || round.options.length < 2) return;
        empataron = true;
        s.send({ type: "CAST_VOTE", guestId: "g1", optionId: round.options[0].id });
        s.send({ type: "CAST_VOTE", guestId: "g2", optionId: round.options[1].id });
      },
    )!;

    expect(empataron).toBe(true);
    expect(ronda.tiebreakSeed).not.toBeNull();
    expect([ronda.options[0].id, ronda.options[1].id]).toContain(ronda.winnerOptionId);
  });

  it("una ronda con cero votos igual elige ganador", () => {
    const ronda = firstClosedRound(
      harness(largas(), [], { actionFrequency: "never", voteWindowSeconds: 30 }),
    )!;

    expect(ronda.status).toBe("closed");
    expect(ronda.winnerOptionId).not.toBeNull();
  });

  it("nunca abre dos rondas en el mismo bloque", () => {
    const h = harness(largas(), [card("k1")], { actionFrequency: "always", voteWindowSeconds: 30 });
    h.send({ type: "START_PARTY" });

    const bloquesConRonda = new Set<string>();
    let rondas = 0;
    h.run(3600, (s) => {
      if (s.state.round && !bloquesConRonda.has(s.state.round.id)) {
        bloquesConRonda.add(s.state.round.id);
        rondas++;
      }
    });

    expect(rondas).toBeGreaterThan(0);
    expect(h.state.roundCount).toBe(rondas);
  });

  it("aguanta 40 invitados votando y se queda con el más votado", () => {
    let ganadora: string | null = null;
    const ronda = firstClosedRound(
      harness(largas(), [], { actionFrequency: "never", voteWindowSeconds: 30 }),
      3600,
      (s, round) => {
        if (ganadora) return;
        const [o1, o2] = round.options;
        ganadora = o1.id;
        for (let i = 0; i < 40; i++) {
          // 21 votos para la primera, 19 para la segunda.
          s.send({ type: "CAST_VOTE", guestId: `g${i}`, optionId: i < 21 ? o1.id : o2.id });
        }
        expect(Object.keys(s.state.round!.votes)).toHaveLength(40);
      },
    )!;

    // Gana la más votada: el desempate al azar no se usó, pero la semilla
    // queda guardada igual como registro de auditoría.
    expect(ronda.winnerOptionId).toBe(ganadora);
    expect(ronda.tiebreakSeed).not.toBeNull();
    const votos = Object.values(ronda.votes);
    const votosGanadora = votos.filter((v) => v === ganadora).length;
    expect(votosGanadora).toBe(21);
    expect(votos.filter((v) => v !== ganadora)).toHaveLength(19);
  });
});

/* ------------------------------------------------------------------ */
/* Cartas de acción                                                    */
/* ------------------------------------------------------------------ */

describe("cartas de acción", () => {
  const largas = () => [
    playlist("a", [200, 200, 200, 200, 200]),
    playlist("b", [200, 200]),
    playlist("c", [200, 200]),
  ];

  it("si gana una carta, se muestra con cuenta regresiva y después vuelve la música", () => {
    const h = harness(largas(), [card("k1", 90)], {
      actionFrequency: "always",
      voteWindowSeconds: 30,
    });
    h.send({ type: "START_PARTY" });

    const box: {
      cartaVotada: boolean;
      seMostro: { hasta: number | null } | null;
      volvioLaMusica: { index: number; videoId: string | null } | null;
    } = { cartaVotada: false, seMostro: null, volvioLaMusica: null };

    h.run(3600, (s) => {
      const round = s.state.round;
      if (round?.status === "open" && !box.cartaVotada) {
        const carta = round.options.find((o) => o.kind === "action");
        if (carta) {
          box.cartaVotada = true;
          s.send({ type: "CAST_VOTE", guestId: "g1", optionId: carta.id });
        }
      }

      if (s.state.phase === "action" && !box.seMostro) {
        box.seMostro = { hasta: s.state.phaseDeadline };
      }

      if (box.seMostro && s.state.phase === "playing" && !box.volvioLaMusica) {
        box.volvioLaMusica = {
          index: s.state.block?.index ?? -1,
          videoId: currentTrack(s.state)?.videoId ?? null,
        };
      }
    });

    expect(box.cartaVotada).toBe(true);
    expect(box.seMostro).not.toBeNull();
    expect(box.seMostro!.hasta).not.toBeNull();
    // Mostrada la carta, la música retomó sola por el tema 0 de un bloque nuevo.
    expect(box.volvioLaMusica).not.toBeNull();
    expect(box.volvioLaMusica!.index).toBe(0);
  });

  it("mientras la acción corre, la fase es action y el deadline es su fin", () => {
    const h = harness(largas(), [card("k1", 90)], {
      actionFrequency: "always",
      voteWindowSeconds: 30,
    });
    h.send({ type: "START_PARTY" });

    let accion: { deadline: number | null; endsAt: number | undefined } | null = null;
    h.run(3600, (s) => {
      if (s.state.phase === "action" && !accion) {
        accion = { deadline: s.state.phaseDeadline, endsAt: s.state.activeAction?.endsAt };
      }
      const round = s.state.round;
      if (round?.status === "open" && !round.votes.g1) {
        const carta = round.options.find((o) => o.kind === "action");
        s.send({ type: "CAST_VOTE", guestId: "g1", optionId: (carta ?? round.options[0]).id });
      }
    });

    expect(accion).not.toBeNull();
    expect(accion!.deadline).toBe(accion!.endsAt);
  });

  it("las cartas de invitados quedan pendientes hasta que el anfitrión las apruebe", () => {
    const h = harness([playlist("a", [200])], [], { autoApproveCards: false });
    h.send({ type: "PROPOSE_CARD", card: { ...card("nueva"), origin: "guest" } });
    expect(h.state.cards[0].status).toBe("pending");

    h.send({ type: "REVIEW_CARD", cardId: "nueva", approve: true });
    expect(h.state.cards[0].status).toBe("approved");
  });

  it("las cartas rechazadas no entran al mazo", () => {
    const h = harness([playlist("a", [200])], [], { autoApproveCards: false });
    h.send({ type: "PROPOSE_CARD", card: { ...card("mala"), origin: "guest" } })
      .send({ type: "REVIEW_CARD", cardId: "mala", approve: false });

    expect(h.state.cards[0].status).toBe("rejected");
  });

  it("con auto-aprobación las cartas de invitados entran directo", () => {
    const h = harness([playlist("a", [200])], [], { autoApproveCards: true });
    h.send({ type: "PROPOSE_CARD", card: { ...card("nueva"), origin: "guest" } });
    expect(h.state.cards[0].status).toBe("approved");
  });

  it("con frecuencia 'never' nunca aparece una carta en la ronda", () => {
    const h = harness(largas(), [card("k1")], { actionFrequency: "never" });
    h.send({ type: "START_PARTY" });

    const kinds = new Set<string>();
    h.run(600, (s) => {
      s.state.round?.options.forEach((o) => kinds.add(o.kind));
    });

    // Mientras haya al menos 2 listas en el pozo nunca entra una carta.
    expect(kinds.has("playlist")).toBe(true);
    expect(kinds.has("action")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Concurrencia y robustez                                             */
/* ------------------------------------------------------------------ */

describe("transiciones concurrentes", () => {
  it("doble advance: el segundo cliente no rompe nada", () => {
    const h = harness([playlist("a", [200, 200, 200]), playlist("b", [200]), playlist("c", [200])], [], {
      voteLeadTracks: 0,
      voteLeadMinutes: 0,
    })
      .send({ type: "START_PARTY" })
      .trackStartedAt(0);

    const versionVieja = h.state.version;
    h.run(200);
    const despues = h.state;

    h.send({ type: "ADVANCE", expectedVersion: versionVieja });

    expect(h.state.version).toBe(despues.version);
    expect(h.state.block?.index).toBe(despues.block?.index);
  });

  it("no avanza antes del deadline", () => {
    const h = harness([playlist("a", [200, 200])]).send({ type: "START_PARTY" });
    const before = h.state.version;
    h.send({ type: "ADVANCE", expectedVersion: h.state.version });

    expect(h.state.version).toBe(before);
    expect(h.state.phase).toBe("playing");
  });

  it("registra cada transición en version (para el compare-and-swap)", () => {
    const h = harness([playlist("a", [200, 200, 200])], [], { voteLeadTracks: 0, voteLeadMinutes: 0 });
    h.send({ type: "START_PARTY" });
    const v1 = h.state.version;
    h.trackStartedAt(0);
    expect(h.state.version).toBeGreaterThan(v1);
  });

  it("ignora eventos de avance cuando el anfitrión está caído", () => {
    const h = harness([playlist("a", [200, 200])], [], {}, { autoHost: false })
      .send({ type: "START_PARTY" })
      .send({ type: "TRACK_STARTED", videoId: "a-0" })
      .send({ type: "HOST_LOST" });

    const antes = h.state.version;
    h.run(600);

    expect(h.state.version).toBe(antes);
    expect(h.state.block?.index).toBe(0);
  });

  it("al volver el anfitrión, corre los deadlines por el tiempo perdido", () => {
    const h = harness([playlist("a", [200, 200])])
      .send({ type: "START_PARTY" })
      .trackStartedAt(0);

    const deadline = h.state.phaseDeadline!;
    h.send({ type: "HOST_LOST" }); // a los 0 s
    h.send({ type: "HOST_BACK" }); // volvió enseguida
    expect(h.state.phaseDeadline).toBe(deadline);

    // Ahora se cae a los 60 s y vuelve a los 180 s: la fiesta estuvo 120 s congelada.
    h.run(60).send({ type: "HOST_LOST" });
    h.run(180).send({ type: "HOST_BACK" });

    expect(h.state.phaseDeadline).toBe(deadline + 120_000);
    expect(h.state.hostLostSince).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Fin de fiesta                                                       */
/* ------------------------------------------------------------------ */

describe("fin de fiesta", () => {
  it("el anfitrión termina la fiesta", () => {
    const h = harness([playlist("a", [200])])
      .send({ type: "START_PARTY" })
      .send({ type: "END_PARTY" });

    expect(h.state.phase).toBe("ended");
    expect(h.state.endedAt).toBe(0);
    expect(h.state.phaseDeadline).toBeNull();
    expect(h.effects).toEqual([{ type: "PARTY_ENDED" }]);
  });

  it("una fiesta terminada no procesa más eventos", () => {
    const h = harness([playlist("a", [200])])
      .send({ type: "START_PARTY" })
      .send({ type: "END_PARTY" })
      .send({ type: "START_PARTY" })
      .send({ type: "CAST_VOTE", guestId: "g1", optionId: "x" });

    expect(h.state.phase).toBe("ended");
  });

  it("sin votación posible, sigue sonando en loop con el pozo", () => {
    // Una sola lista y sin cartas: nunca hay 2 opciones para votar.
    const h = harness([playlist("a", [10, 10])], [], { voteLeadTracks: 3 });
    h.send({ type: "START_PARTY" });

    const bloques = new Set<string>();
    h.run(120, (s) => {
      if (s.state.block) bloques.add(`${s.state.block.playlistId}-${s.state.block.index}`);
    });

    expect(h.state.phase).toBe("playing");
    expect(h.state.round).toBeNull();
    expect(h.state.playlists[0].played).toBe(true);
    expect(bloques.size).toBeGreaterThan(1);
  });
});
