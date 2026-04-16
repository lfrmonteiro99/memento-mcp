// src/lib/decay.ts
export function daysSince(timestampIso: string | undefined): number {
  if (!timestampIso) return 999;
  try {
    const ts = new Date(timestampIso).getTime();
    return (Date.now() - ts) / 86_400_000;
  } catch {
    return 999;
  }
}

export function getDecayFactor(days: number): number {
  if (days > 30) return 0.5;
  if (days > 14) return 0.75;
  return 1.0;
}

export function applyDecay(baseScore: number, lastAccessed: string | undefined): number {
  return baseScore * getDecayFactor(daysSince(lastAccessed));
}
