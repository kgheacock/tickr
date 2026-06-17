/**
 * Stock report — the detail behind an inventory row (waiver wire). Opens as a
 * newsprint modal: a trailing-3-month price chart (the shared SVG LineChart) over a
 * "previous scoring" ledger of the stock's recent per-week fantasy points. Pure
 * read; waiver claims are a later item.
 */
import { useQuery } from '@tanstack/react-query';
import type { PlayerGroup } from '@tickr/shared-types';
import { client } from '../../api/client';
import { Modal } from '../../components/Modal';
import { CategoryChip } from '../../components/CategoryChip';
import {
  LineChart,
  type ChartSeries,
  type ChartMarker,
} from '../../components/LineChart';
import { formatPercent } from '../../lib/format';
import { SLOT_LABELS, specializationsOf } from './api';
import { StockLogo } from './StockCell';
import { fmtPercent, fmtPoints } from './points';
import { dailyCloses, weeklyMarkers } from './priceSeries';
import styles from './PlayerDetailModal.module.css';

const groupLabel = (g: PlayerGroup): string => SLOT_LABELS[g] ?? g;

export function PlayerDetailModal({
  leagueId,
  symbol,
  onClose,
}: {
  leagueId: string;
  symbol: string;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['fantasy', 'player', leagueId, symbol],
    queryFn: () => client.getPlayerDetail(leagueId, symbol),
  });

  const d = detail.data;
  // Daily close is already smooth (corpus stores one EOD bar per day). Each week
  // gets a dashed signpost at its close, captioned with that week's move.
  const daily = d ? dailyCloses(d.prices) : [];
  const series: ChartSeries[] = d
    ? [
        {
          label: `${symbol} close`,
          color: 'var(--color-accent)',
          points: daily.map((p) => ({ ts: p.ts, equity: p.close })),
        },
      ]
    : [];
  // Drop the first signpost: its move is anchored to the window open (a partial
  // week), so omitting it leaves a clean week-over-week arrow at each week's
  // close — green up, red down, with the date + figure on hover.
  const markers: ChartMarker[] = d
    ? weeklyMarkers(d.prices)
        .slice(1)
        .map((m) => {
          const up = m.changePct >= 0;
          const color = up ? 'var(--color-success)' : 'var(--color-danger)';
          const date = new Date(m.ts);
          return {
            ts: m.ts,
            up,
            color,
            dateLabel: date.toLocaleDateString(undefined, {
              month: 'numeric',
              day: 'numeric',
            }),
            tooltip: (
              <>
                {date.toLocaleDateString()}
                {'  '}
                {fmtPercent(m.changePct)}{' '}
                <span style={{ color }}>{up ? '▲' : '▼'}</span>
              </>
            ),
          };
        })
    : [];

  return (
    <Modal
      onClose={onClose}
      kicker="Stock report"
      label={symbol}
      width="720px"
      masthead={
        <div className={styles.masthead}>
          <StockLogo symbol={symbol} size="lg" />
          <div className={styles.titleText}>
            <span className={styles.ticker}>{symbol}</span>
            {d?.name && <span className={styles.companyName}>{d.name}</span>}
          </div>
        </div>
      }
    >
      {detail.isLoading ? (
        <p className={styles.muted}>Loading…</p>
      ) : detail.error || !d ? (
        <p className={styles.muted}>Couldn’t load this stock.</p>
      ) : (
        <div className={styles.body}>
          <div className={styles.meta}>
            <span
              className={
                d.ownership.owned ? styles.heldTag : styles.availableTag
              }
            >
              {d.ownership.owned
                ? `Held by ${d.ownership.ownerTeam ?? 'a manager'}`
                : 'Available'}
            </span>
            <div className={styles.chips}>
              {specializationsOf(d.groups).length === 0 ? (
                <span className={styles.chipMuted}>No specialization</span>
              ) : (
                specializationsOf(d.groups).map((g) => (
                  <CategoryChip key={g} group={g}>
                    {groupLabel(g)}
                  </CategoryChip>
                ))
              )}
            </div>
          </div>

          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt>3-mo return</dt>
              <dd>{fmtPercent(d.metrics.ret3mPct)}</dd>
            </div>
            <div className={styles.stat}>
              <dt>12-mo return</dt>
              <dd>{fmtPercent(d.metrics.ret12mPct)}</dd>
            </div>
            <div className={styles.stat}>
              <dt>Volatility</dt>
              <dd>
                {d.metrics.sigma == null ? '—' : formatPercent(d.metrics.sigma)}
              </dd>
            </div>
          </dl>

          <section>
            <h3 className={styles.sectionHead}>Price · last 3 months</h3>
            <LineChart series={series} markers={markers} height={240} />
          </section>

          <section>
            <h3 className={styles.sectionHead}>Previous scoring</h3>
            {d.scoringHistory.length === 0 ? (
              <p className={styles.muted}>No completed weeks yet.</p>
            ) : (
              <table className={styles.scoreTable}>
                <thead>
                  <tr>
                    <th>Week ending</th>
                    <th className={styles.num}>Return</th>
                    <th className={styles.num}>Points</th>
                  </tr>
                </thead>
                <tbody>
                  {d.scoringHistory.map((w) => (
                    <tr key={w.weekEnd}>
                      <td>{new Date(w.weekEnd).toLocaleDateString()}</td>
                      <td className={styles.num}>{fmtPercent(w.returnPct)}</td>
                      <td
                        className={`${styles.num} ${
                          w.points == null
                            ? ''
                            : w.points >= 0
                              ? styles.pos
                              : styles.neg
                        }`}
                      >
                        {fmtPoints(w.points)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className={styles.footnote}>
              Points are the week’s return (long basis), the score a starter
              would have earned.
            </p>
          </section>
        </div>
      )}
    </Modal>
  );
}
