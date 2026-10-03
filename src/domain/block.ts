/**
 * Armado de bloques: tomar temas de una lista, en orden, mientras la suma de
 * duraciones no supere el tope. Los temas no reproducibles se descartan (no se
 * "pierde" tiempo de bloque con ellos).
 */

import type { Playlist, Track } from "./types";

export function isPlayable(track: Track): boolean {
  return track.embeddable && track.durationSec > 0;
}

/**
 * Devuelve los `videoId` del bloque, en orden, recortados al tope de minutos.
 * Los temas no embebibles o inválidos se saltean.
 */
export function buildBlock(playlist: Playlist, blockMaxMinutes: number): string[] {
  const maxSeconds =
    (playlist.maxMinutes && playlist.maxMinutes > 0
      ? playlist.maxMinutes
      : blockMaxMinutes) * 60;

  const trackIds: string[] = [];
  let total = 0;

  for (const track of playlist.tracks) {
    if (!isPlayable(track)) continue;
    if (total + track.durationSec > maxSeconds) break;
    trackIds.push(track.videoId);
    total += track.durationSec;
  }

  return trackIds;
}

/** Segundos que faltan para terminar el bloque desde el tema `index`. */
export function remainingSeconds(
  tracks: readonly Track[],
  index: number,
  elapsedOfCurrent = 0,
): number {
  const pending = tracks
    .slice(index)
    .filter(isPlayable)
    .reduce((acc, track) => acc + track.durationSec, 0);
  return Math.max(0, pending - elapsedOfCurrent);
}

/** Cuántos temas quedan por delante (incluyendo el que está sonando). */
export function remainingTracks(tracks: readonly Track[], index: number): number {
  return Math.max(0, tracks.slice(index).filter(isPlayable).length);
}
