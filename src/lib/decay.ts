// src/lib/decay.ts
// R10: expose an injectable clock so tests can freeze time.
let currentClock: () => number = () => Date.now();

/** Override the clock (tests only). Pass a function returning epoch ms. */
export function setClock(fn: () => number): void {
  currentClock = fn;
}

/** Restore the clock to Date.now (call in afterEach). */
export function resetClock(): void {
  currentClock = () => Date.now();
}

export function daysSince(timestampIso: string | undefined): number {
  if (!timestampIso) return 999;
  try {
    const ts = new Date(timestampIso).getTime();
    return (currentClock() - ts) / 86_400_000;
  } catch {
    return 999;
  }
}

// v1 step function (kept for backward compat and config option type="step")
export function getDecayFactor(days: number): number {
  if (days > 30) return 0.5;
  if (days > 14) return 0.75;
  return 1.0;
}

export function applyDecay(baseScore: number, lastAccessed: string | undefined): number {
  return baseScore * getDecayFactor(daysSince(lastAccessed));
}

// v2 exponential decay.
// NOTE (N3): computeExponentialDecay approaches but never reaches exactly 0.
// At 999 days it is ~1.3e-21 — effectively zero for all ranking purposes, but
// tests should assert `.toBeLessThan(0.001)` rather than `.toBe(0)`.
export function computeExponentialDecay(days: number, halfLife: number = 14): number {
  return Math.exp(-Math.LN2 * days / halfLife);
}

export function applyDecayV2(baseScore: number, lastAccessed: string | undefined, halfLife: number = 14): number {
  const days = daysSince(lastAccessed);
  return baseScore * computeExponentialDecay(days, halfLife);
}
