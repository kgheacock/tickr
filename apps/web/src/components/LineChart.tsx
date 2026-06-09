import { useMemo } from 'react';
import { formatCents } from '../lib/format';
import styles from './LineChart.module.css';

export interface ChartSeries {
  label: string;
  color: string;
  /** Points share a common ascending `ts` spine across series. */
  points: { ts: string; equity: number }[];
}

interface LineChartProps {
  series: ChartSeries[];
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
export function LineChart({ series, height = 320 }: LineChartProps) {
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

    return {
      lines,
      yTicks,
      startLabel: new Date(minT).toLocaleDateString(),
      endLabel: new Date(maxT).toLocaleDateString(),
    };
  }, [series, height]);

  if (!model) {
    return <div className={styles.empty}>No data to plot</div>;
  }

  const label = series.map((s) => s.label).join(' vs ');

  return (
    <div className={styles.wrap}>
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
