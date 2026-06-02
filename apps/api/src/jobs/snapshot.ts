import type { Redis } from 'ioredis';
import { pool } from '../db/pool.js';
import { writeLeaderboardCache, TOP_N } from '../cache/leaderboard.js';
import { publishLeaderboardUpdated } from '../events/publisher.js';
import type {
  LeaderboardResponse,
  LeaderboardRowItem,
} from '@tickr/shared-types';

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  console[level](
    JSON.stringify({ level, component: 'snapshot', msg, ...extra }),
  );
}

/**
 * Returns the snapshot taken_at timestamp — midnight UTC on the current day.
 * Idempotent per calendar day so a second run for the same day is a no-op.
 */
export function snapshotTakenAt(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export async function runSnapshot(redis: Redis): Promise<void> {
  const takenAt = snapshotTakenAt().toISOString();

  // 1. Compute and insert valuation_snapshot rows (one per portfolio).
  const { rowCount: snapCount } = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (symbol) symbol, ts, close
       FROM price_bar
       ORDER BY symbol, ts DESC
     ),
     eq AS (
       SELECT p.id AS portfolio_id,
              p.cash,
              COALESCE(SUM(pos.quantity * latest.close), 0)::BIGINT
                AS positions_value,
              (p.cash + COALESCE(SUM(pos.quantity * latest.close), 0))::BIGINT
                AS equity
       FROM portfolio p
       LEFT JOIN position pos ON pos.portfolio_id = p.id
       LEFT JOIN latest      ON latest.symbol     = pos.symbol
       GROUP BY p.id, p.cash
     )
     INSERT INTO valuation_snapshot (id, portfolio_id, taken_at, cash,
                                     positions_value, equity)
     SELECT gen_random_uuid(), portfolio_id, $1, cash,
            positions_value, equity
     FROM eq
     ON CONFLICT (portfolio_id, taken_at) DO NOTHING`,
    [takenAt],
  );

  log('info', 'valuation_snapshot upsert', {
    inserted: snapCount ?? 0,
    takenAt,
  });

  // 2. Rank portfolios into leaderboard_row.
  await pool.query(
    `INSERT INTO leaderboard_row (taken_at, portfolio_id, rank, equity,
                                  return_pct)
     SELECT taken_at,
            portfolio_id,
            RANK() OVER (ORDER BY equity DESC) AS rank,
            equity,
            (equity::FLOAT - 100000000) / 100000000 AS return_pct
     FROM valuation_snapshot
     WHERE taken_at = $1
     ON CONFLICT (taken_at, portfolio_id) DO NOTHING`,
    [takenAt],
  );

  // 3. Warm Redis cache with top-N rows (joins to get displayName / isBot).
  const { rows } = await pool.query<{
    rank: number;
    portfolio_id: string;
    display_name: string;
    is_bot: boolean;
    equity: number;
    return_pct: number;
  }>(
    `SELECT lr.rank,
            lr.portfolio_id,
            CASE WHEN p.algo_id IS NOT NULL THEN a.name
                 ELSE u.display_name
            END AS display_name,
            (p.algo_id IS NOT NULL) AS is_bot,
            lr.equity,
            lr.return_pct
     FROM leaderboard_row lr
     JOIN portfolio  p ON p.id    = lr.portfolio_id
     JOIN app_user   u ON u.id    = p.user_id
     LEFT JOIN algo  a ON a.id    = p.algo_id
     WHERE lr.taken_at = $1
     ORDER BY lr.rank, lr.portfolio_id
     LIMIT $2`,
    [takenAt, TOP_N],
  );

  const leaderboardRows: LeaderboardRowItem[] = rows.map((r) => ({
    rank: r.rank,
    portfolioId: r.portfolio_id,
    displayName: r.display_name,
    isBot: r.is_bot,
    equity: r.equity,
    returnPct: r.return_pct,
  }));

  const payload: LeaderboardResponse = {
    takenAt,
    rows: leaderboardRows,
    nextCursor: rows.length === TOP_N ? encodeCursor(rows[TOP_N - 1]!) : null,
  };

  await writeLeaderboardCache(redis, payload);

  // 4. Record metric for ops endpoint (item 10).
  await redis.set('metric:lastSnapshotAt', takenAt);

  // 5. Notify the WS gateway (item 09) so it can fan out to subscribed clients.
  await publishLeaderboardUpdated(redis, payload);

  log('info', 'snapshot complete', {
    takenAt,
    portfolios: leaderboardRows.length,
  });
}

export function encodeCursor(row: {
  rank: number;
  portfolio_id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ rank: row.rank, portfolioId: row.portfolio_id }),
  ).toString('base64url');
}

export function decodeCursor(cursor: string): {
  rank: number;
  portfolioId: string;
} {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
    rank: number;
    portfolioId: string;
  };
}
