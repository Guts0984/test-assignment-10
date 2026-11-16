/** Whole seconds left until `untilIso` (never negative). Pure: the caller supplies "now". */
export function secondsLeft(untilIso: string | null, nowMs: number): number {
  if (!untilIso) return 0;
  return Math.max(0, Math.ceil((new Date(untilIso).getTime() - nowMs) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
