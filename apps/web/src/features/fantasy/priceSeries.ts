/**
 * Shaping for the stock-report price chart. The corpus stores daily EOD bars,
 * so the daily-close line is already smooth; `dailyCloses` just guards against
 * any duplicate same-day bars by keeping the last close per calendar day.
 * `weeklyMarkers` turns those into one signpost per Monday-aligned week, placed
 * at the week's last bar, captioned with that week's move (in percent units, to
 * match points.ts) — the change since the previous signpost (or, for the first
 * week, since the start of the window).
 */
export interface ClosePoint {
  ts: string;
  close: number;
}

export interface WeekMarker {
  /** Time of the week's last bar — where the vertical rule is drawn. */
  ts: string;
  /** Week-over-week move in percent units (e.g. 3.2 for +3.2%). */
  changePct: number;
}

const DAY_MS = 86_400_000;

/** Last close per calendar (UTC) day, ascending — collapses duplicate bars. */
export function dailyCloses(bars: ClosePoint[]): ClosePoint[] {
  const byDay = new Map<number, ClosePoint>();
  for (const b of bars) {
    byDay.set(Math.floor(Date.parse(b.ts) / DAY_MS), b);
  }
  return [...byDay.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
}

/** Unix epoch day 0 is a Thursday; +3 shifts the bucket boundary to Monday. */
const weekKey = (ts: string): number =>
  Math.floor((Date.parse(ts) / DAY_MS + 3) / 7);

/** Last close of each Monday-aligned week, ascending. */
function weeklyCloses(bars: ClosePoint[]): ClosePoint[] {
  const byWeek = new Map<number, ClosePoint>();
  for (const b of dailyCloses(bars)) {
    byWeek.set(weekKey(b.ts), b);
  }
  return [...byWeek.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
}

/**
 * One signpost per week, captioned with the move since the previous week's
 * close. The first week anchors to the first close in the window, so every week
 * present gets a marker.
 */
export function weeklyMarkers(bars: ClosePoint[]): WeekMarker[] {
  const weekly = weeklyCloses(bars);
  if (weekly.length === 0) return [];

  // Anchor the first week to the window's opening close (its own first bar);
  // thereafter each week references the prior week's close.
  let prev = dailyCloses(bars)[0]?.close ?? weekly[0]?.close ?? 0;
  const out: WeekMarker[] = [];
  for (const w of weekly) {
    const changePct = prev === 0 ? 0 : ((w.close - prev) / prev) * 100;
    out.push({ ts: w.ts, changePct });
    prev = w.close;
  }
  return out;
}
