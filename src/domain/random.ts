/**
 * Azar reproducible.
 *
 * Todo el azar del dominio pasa por acá: se guarda la semilla en la fila de la
 * ronda, así que una votación se puede volver a calcular igual (auditoría).
 */

/** PRNG chico y determinista (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Semilla a partir de una fuente de azar (en producción, `Date.now()` + azar). */
export function makeSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0xffffffff) >>> 0;
}

/** Fisher–Yates sin mutar el array original. */
export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Elige `count` elementos al azar sin repetir. */
export function sample<T>(items: readonly T[], count: number, rand: () => number): T[] {
  return shuffled(items, rand).slice(0, Math.max(0, count));
}
