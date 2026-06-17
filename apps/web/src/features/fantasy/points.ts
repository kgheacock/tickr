/**
 * Fantasy points formatting. Points are r (long) / −r (short), already
 * rounded to 2 dp server-side; we render them with a sign and a fixed scale so
 * the scoreboard reads consistently. Percent returns get the same treatment.
 */
export function fmtPoints(points: number | null | undefined): string {
  if (points == null) return '—';
  const v = Math.round(points * 100) / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

export function fmtPercent(pct: number | null | undefined): string {
  if (pct == null) return '—';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}
