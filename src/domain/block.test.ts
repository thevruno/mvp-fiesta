import { describe, expect, it } from "vitest";
import { buildBlock, isPlayable, remainingSeconds, remainingTracks } from "./block";
import type { Playlist, Track } from "./types";

const track = (videoId: string, durationSec: number, embeddable = true): Track => ({
  videoId,
  title: videoId,
  durationSec,
  embeddable,
});

const playlist = (id: string, tracks: Track[]): Playlist => ({
  id,
  title: id,
  tracks,
  maxMinutes: null,
  played: false,
});

describe("buildBlock", () => {
  it("suma temas en orden sin pasarse del tope", () => {
    const pl = playlist("p1", [track("a", 200), track("b", 200), track("c", 200)]);
    // 30 min = 1800 s → entran 9 temas de 200 s, acá entran los 3.
    expect(buildBlock(pl, 30)).toEqual(["a", "b", "c"]);
    expect(buildBlock(pl, 7)).toEqual(["a", "b"]); // 420 s
  });

  it("corta antes de pasarse del tope, sin partir un tema", () => {
    const pl = playlist("p1", [track("a", 300), track("b", 300), track("c", 300)]);
    expect(buildBlock(pl, 11)).toEqual(["a", "b"]); // 600 s + 300 s supera 660? no: 900 > 660
    expect(buildBlock(pl, 10)).toEqual(["a", "b"]);
    expect(buildBlock(pl, 4)).toEqual([]);
  });

  it("saltea los temas no reproducibles", () => {
    const pl = playlist("p1", [
      track("a", 200),
      track("roto", 200, false),
      track("b", 200),
    ]);
    expect(buildBlock(pl, 30)).toEqual(["a", "b"]);
  });

  it("usa el tope propio de la lista si lo tiene", () => {
    const pl: Playlist = { ...playlist("p1", [track("a", 300), track("b", 300)]), maxMinutes: 5 };
    expect(buildBlock(pl, 30)).toEqual(["a"]);
  });

  it("ignora temas con duración desconocida", () => {
    expect(isPlayable(track("x", 0))).toBe(false);
    expect(buildBlock(playlist("p1", [track("x", 0), track("a", 100)]), 30)).toEqual(["a"]);
  });
});

describe("remaining", () => {
  const tracks = [track("a", 100), track("b", 200), track("c", 300)];

  it("cuenta los segundos que faltan, incluido el tema en curso", () => {
    expect(remainingSeconds(tracks, 0)).toBe(600);
    expect(remainingSeconds(tracks, 0, 40)).toBe(560);
    expect(remainingSeconds(tracks, 2)).toBe(300);
  });

  it("cuenta los temas que faltan", () => {
    expect(remainingTracks(tracks, 0)).toBe(3);
    expect(remainingTracks(tracks, 3)).toBe(0);
  });
});
