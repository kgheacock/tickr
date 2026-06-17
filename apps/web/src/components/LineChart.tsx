import { useMemo, type ReactNode } from 'react';
import { formatCents } from '../lib/format';
import { Tooltip } from './Tooltip';
import styles from './LineChart.module.css';

export interface ChartSeries {
  label: string;
  color: string;
  /** Points share a common ascending `ts` spine across series. */
  points: { ts: string; equity: number }[];
}

/**
 * A vertical "signpost" dropped at a point on the time axis — a dashed rule
 * topped with a direction arrow (up/down). Hovering the rule reveals `tooltip`.
 */
export interface ChartMarker {
  ts: string;
  /** Arrow points up for a gain, down for a loss. */
  up: boolean;
  /** Arrow fill colour. */
  color: string;
  /** Muted date label centred at the base of the rule. */
  dateLabel: string;
  /** Hover content — the date and the numeric move. */
  tooltip: ReactNode;
}

interface LineChartProps {
  series: ChartSeries[];
  markers?: ChartMarker[];
  height?: number;
}

// Internal SVG coordinate space; the SVG scales to its container width.
const VIEW_W = 800;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 22;
const Y_TICKS = 4;

/**
 * Dependency-free SVG line chart. Hand-rolled rather than using
 * lightweight-charts so item 18's performance plot carries no third-party
 * attribution requirement (see TODO/11 for migrating the market chart too).
 */
export function LineChart({ series, markers, height = 320 }: LineChartProps) {
  const model = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    if (all.length === 0) return null;

    let minT = Infinity;
    let maxT = -Infinity;
    let minE = Infinity;
    let maxE = -Infinity;
    for (const p of all) {
      const t = Date.parse(p.ts);
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
      if (p.equity < minE) minE = p.equity;
      if (p.equity > maxE) maxE = p.equity;
    }
    // Pad the value range so lines don't sit on the frame; guard a flat series.
    const span = maxE - minE || Math.max(1, Math.abs(maxE));
    minE -= span * 0.05;
    maxE += span * 0.05;
    const tSpan = maxT - minT || 1;

    const x = (ts: string) =>
      PAD_L + ((Date.parse(ts) - minT) / tSpan) * (VIEW_W - PAD_L - PAD_R);
    const y = (equity: number) =>
      PAD_T + (1 - (equity - minE) / (maxE - minE)) * (height - PAD_T - PAD_B);

    const lines = series
      .filter((s) => s.points.length > 0)
      .map((s) => ({
        color: s.color,
        path: s.points.map((p) => `${x(p.ts)},${y(p.equity)}`).join(' '),
      }));

    const yTicks = Array.from({ length: Y_TICKS + 1 }, (_, i) => {
      const value = minE + ((maxE - minE) * i) / Y_TICKS;
      return { value, yPos: y(value) };
    });

    // Signposts: a dashed vertical rule at each marker's time, topped with an
    // up/down arrow. An HTML hit-strip per signpost (positioned by leftPct)
    // carries the shared Tooltip.
    const marks = (markers ?? []).map((m) => {
      const mx = x(m.ts);
      const dateAnchor =
        mx > VIEW_W - 24 ? 'end' : mx < 24 ? 'start' : 'middle';
      return {
        x: mx,
        leftPct: (mx / VIEW_W) * 100,
        up: m.up,
        color: m.color,
        dateLabel: m.dateLabel,
        dateAnchor,
        tooltip: m.tooltip,
      } as const;
    });

    return {
      lines,
      marks,
      yTicks,
      startLabel: new Date(minT).toLocaleDateString(),
      endLabel: new Date(maxT).toLocaleDateString(),
    };
  }, [series, markers, height]);

  if (!model) {
    return <div className={styles.empty}>No data to plot</div>;
  }

  const label = series.map((s) => s.label).join(' vs ');

  return (
    <div className={styles.wrap}>
      <div className={styles.plot}>
        <svg
          className={styles.svg}
          viewBox={`0 0 ${VIEW_W} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Performance chart: ${label}`}
        >
          {model.yTicks.map((t) => (
            <g key={t.yPos}>
              <line
                x1={PAD_L}
                x2={VIEW_W - PAD_R}
                y1={t.yPos}
                y2={t.yPos}
                className={styles.grid}
              />
              <text x={PAD_L + 2} y={t.yPos - 3} className={styles.axisLabel}>
                {formatCents(t.value)}
              </text>
            </g>
          ))}
          {model.marks.map((m, i) => {
            const ah = 9; // arrow height/width in view units
            const arrow = m.up
              ? `${m.x},${PAD_T} ${m.x - ah / 2},${PAD_T + ah} ${m.x + ah / 2},${PAD_T + ah}`
              : `${m.x - ah / 2},${PAD_T} ${m.x + ah / 2},${PAD_T} ${m.x},${PAD_T + ah}`;
            return (
              <g key={`mark-${i}`}>
                <line
                  x1={m.x}
                  x2={m.x}
                  y1={PAD_T + ah}
                  y2={height - PAD_B}
                  className={styles.marker}
                />
                <polygon points={arrow} fill={m.color} />
                <text
                  x={m.x}
                  y={height - PAD_B + 14}
                  textAnchor={m.dateAnchor}
                  className={styles.markerDate}
                >
                  {m.dateLabel}
                </text>
              </g>
            );
          })}
          {model.lines.map((l, i) => (
            <polyline
              key={i}
              points={l.path}
              fill="none"
              stroke={l.color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {/* HTML hit-strips over each signpost, carrying the shared Tooltip. */}
        {model.marks.map((m, i) => (
          <div
            key={`hit-${i}`}
            className={styles.hitSlot}
            style={{ left: `${m.leftPct}%` }}
          >
            <Tooltip content={m.tooltip} className={styles.hitTrigger}>
              <span className={styles.hitFill} aria-hidden="true" />
            </Tooltip>
          </div>
        ))}
      </div>
      <div className={styles.xAxis}>
        <span>{model.startLabel}</span>
        <span>{model.endLabel}</span>
      </div>
      <div className={styles.legend}>
        {series.map((s) => (
          <span key={s.label} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
