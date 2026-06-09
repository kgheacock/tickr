/**
 * Tiny in-process metric registry (item 10). Lives in the api process and is
 * only meaningful for that process's own HTTP counters — the api and worker
 * run as separate processes, so cross-process numbers (Massive calls/429s,
 * EOD run, backfill) live in Redis instead (see metrics/redis.ts).
 *
 * No Prometheus client in v1.
 */

export type Labels = Record<string, string | number>;

function keyOf(name: string, labels?: Labels): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(',')}}`;
}

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const durations = new Map<string, number[]>();

// Last-N observations per series for p50/p95. Bounded so memory stays flat.
const DURATION_BUFFER = 500;

export function incrCounter(name: string, labels?: Labels, by = 1): void {
  const k = keyOf(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

export function getCounter(name: string, labels?: Labels): number {
  return counters.get(keyOf(name, labels)) ?? 0;
}

export function setGauge(name: string, value: number, labels?: Labels): void {
  gauges.set(keyOf(name, labels), value);
}

export function observe(name: string, value: number, labels?: Labels): void {
  const k = keyOf(name, labels);
  let buf = durations.get(k);
  if (!buf) {
    buf = [];
    durations.set(k, buf);
  }
  buf.push(value);
  if (buf.length > DURATION_BUFFER) buf.shift();
}

export function getObservationCount(name: string, labels?: Labels): number {
  return durations.get(keyOf(name, labels))?.length ?? 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))] ?? 0;
}

export interface DurationStats {
  count: number;
  p50: number;
  p95: number;
}

export function snapshot(): {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  durations: Record<string, DurationStats>;
} {
  const durStats: Record<string, DurationStats> = {};
  for (const [k, buf] of durations) {
    const sorted = [...buf].sort((a, b) => a - b);
    durStats[k] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
    };
  }
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
    durations: durStats,
  };
}

/** Test helper — wipe all series. */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
  durations.clear();
}
