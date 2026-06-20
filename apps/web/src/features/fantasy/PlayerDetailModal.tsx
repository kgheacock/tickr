/**
 * Stock report — the detail behind an inventory row (waiver wire). Opens as a
 * newsprint modal: a trailing-3-month price chart (the shared SVG LineChart) over a
 * "previous scoring" ledger of the stock's recent per-week fantasy points. The
 * header carries a context buy/sell button (see useTradeButton) that hands off
 * to the parent's confirm dialog.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PlayerGroup } from '@tickr/shared-types';
import { client } from '../../api/client';
import { Modal } from '../../components/Modal';
import { CategoryChip } from '../../components/CategoryChip';
import { Button, Badge } from '../../components';
import {
  LineChart,
  type ChartSeries,
  type ChartMarker,
} from '../../components/LineChart';
import { SLOT_LABELS, specializationsOf } from './api';
import type { LeagueContext } from './useLeague';
import { StockMasthead } from './StockMasthead';
import { ShortBadge } from './ShortBadge';
import { SignedNumber } from './SignedNumber';
import { dailyCloses, weeklyMarkers } from './priceSeries';
import styles from './PlayerDetailModal.module.css';

const groupLabel = (g: PlayerGroup): string => SLOT_LABELS[g] ?? g;

export function PlayerDetailModal({
  ctx,
  symbol,
  isShort = false,
  onClose,
  onRequestBuy,
  onRequestSell,
}: {
  ctx: LeagueContext;
  symbol: string;
  /** Open in short (Defense) basis: the scoring ledger flips sign and the header
   *  carries the red band + "short" flag, matching the My Team roster row. */
  isShort?: boolean;
  onClose: () => void;
  /** Open the buy confirmation for this stock (the parent closes the report
   *  first). Omit where buying can't apply, e.g. an all-owned roster list. */
  onRequestBuy?: (symbol: string, name: string | null) => void;
  /** Open the sell confirmation for this stock (the parent closes the report
   *  first). */
  onRequestSell?: (symbol: string, name: string | null) => void;
}) {
  const { leagueId } = ctx;
  const detail = useQuery({
    queryKey: ['fantasy', 'player', leagueId, symbol],
    queryFn: () => client.getPlayerDetail(leagueId, symbol),
  });

  const d = detail.data;
  // A short (Defense) holding scores inverted, so every points figure in the
  // ledger reads with the sign flipped. The price chart below is left untouched —
  // it's the stock's real market move, not a score. `pctPositive` flips to its
  // complement: a week the stock fell is a positive week for a short.
  const sign = isShort ? -1 : 1;
  const flip = (v: number | null | undefined) => (v == null ? v : v * sign);
  // Most recent *completed* week. scoringHistory is newest-first and may lead
  // with the current, still-provisional week, which "last week" should skip.
  const lastWeek = d?.scoringHistory.find((w) => !w.provisional) ?? null;
  // The header buy/sell control. It doesn't trade here — it hands off to the
  // parent's confirm dialog, which opens once this report has closed.
  const actionButton = useTradeButton(
    ctx,
    symbol,
    d?.name ?? null,
    d?.ownership.owned ?? false,
    onRequestBuy,
    onRequestSell,
  );
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
                <SignedNumber value={m.changePct} />
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
      headerClassName={isShort ? styles.shortHeader : undefined}
      masthead={
        <div className={styles.headerRow}>
          <StockMasthead
            symbol={symbol}
            name={d?.name}
            tag={isShort ? <ShortBadge /> : undefined}
          />
          {d && actionButton}
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
              <dt>Last week</dt>
              <dd>
                <SignedNumber value={flip(lastWeek?.points ?? null)} />
              </dd>
            </div>
            <div className={styles.stat}>
              <dt>3-mo scoring total</dt>
              <dd>
                <SignedNumber value={flip(d.scoring3mo.totalPoints)} />
              </dd>
            </div>
            <div className={styles.stat}>
              <dt>Percent positive</dt>
              <dd>
                {d.scoring3mo.pctPositive == null
                  ? '—'
                  : `${isShort ? 100 - d.scoring3mo.pctPositive : d.scoring3mo.pctPositive}%`}
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
                    <th>Week starting</th>
                    <th className={styles.num}>Points</th>
                  </tr>
                </thead>
                <tbody>
                  {d.scoringHistory.map((w) => (
                    <tr key={w.weekEnd}>
                      <td>
                        {new Date(w.weekStart).toLocaleDateString()}
                        {w.provisional && (
                          <Badge className={styles.inProgress}>
                            In progress
                          </Badge>
                        )}
                      </td>
                      <td className={styles.num}>
                        <SignedNumber value={flip(w.points)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className={styles.footnote}>
              {isShort
                ? 'Points are the week’s return inverted (short basis), the score a Defense starter would have earned.'
                : 'Points are the week’s return (long basis), the score a starter would have earned.'}
            </p>
          </section>
        </div>
      )}
    </Modal>
  );
}

/**
 * The report's header-anchored buy/sell button. What it offers depends on
 * context — an unowned stock can be bought, a stock the caller owns can be sold
 * back to the wire, and one held by another manager offers nothing. Hidden
 * while the lineup is locked, matching the table gating. The button doesn't
 * trade: it asks the parent (`onRequestBuy` / `onRequestSell`) to open the
 * confirm dialog, which the parent does after closing this report. A branch
 * with no callback renders nothing, so an all-owned roster list can omit
 * `onRequestBuy` without ever showing a dead button.
 */
function useTradeButton(
  ctx: LeagueContext,
  symbol: string,
  name: string | null,
  owned: boolean,
  onRequestBuy?: (symbol: string, name: string | null) => void,
  onRequestSell?: (symbol: string, name: string | null) => void,
): ReactNode {
  // Buying/selling is a real-time roster mutation, so it follows the lineup
  // lock like every other roster move.
  const locked = ctx.lineup?.locked ?? false;

  // The caller's roster tells us whether this stock is theirs — there's no
  // ownerUserId on the wire. Shares the inventory/lineup query key, so it's
  // deduped.
  const rosterQuery = useQuery({
    queryKey: ['fantasy', 'roster', ctx.leagueId],
    queryFn: () => client.getRoster(ctx.leagueId),
    enabled: !locked,
  });
  const mine = (rosterQuery.data?.items ?? []).some((r) => r.symbol === symbol);

  if (locked) return null;
  // Wait for the roster before choosing buy vs sell — an unsettled roster reads
  // an owned-by-me stock as unavailable and would flash the wrong control.
  if (!rosterQuery.isSuccess) return null;
  // Held by another manager: nothing actionable from here.
  if (owned && !mine) return null;

  if (mine) {
    if (!onRequestSell) return null;
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onRequestSell(symbol, name)}
      >
        Sell {symbol}
      </Button>
    );
  }

  if (!onRequestBuy) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onRequestBuy(symbol, name)}
    >
      Buy {symbol}
    </Button>
  );
}
