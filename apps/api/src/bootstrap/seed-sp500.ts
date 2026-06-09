import { pool } from '../db/pool.js';

/**
 * Seed (or refresh) the `sp500` system ETF: an equal-weight basket over every
 * backfilled universe symbol. This is the default starting point every client
 * loads and forks from (item 18).
 *
 * Equal-weight mirrors the old built-in `index` basket: every member gets
 * `weight = 1`, normalized to sum to 1.0 at compute time (item 17 D2).
 * Market-cap weighting is a deliberate later refinement.
 *
 * `base_date` is chosen as the *latest* first-bar date across members, so every
 * member is guaranteed a bar at or before it (etfSeries throws UNDEFINED_BASE
 * otherwise). Consequence: a single young backfilled symbol drags base_date
 * recent and shortens the whole synthetic series — re-seed prunes/extends the
 * window as membership changes.
 *
 * Idempotent and refreshable: it UPSERTs the etf header and fully replaces the
 * weight set, so it is safe to run on every startup and again whenever the
 * backfilled membership changes. Skips gracefully when nothing is backfilled
 * yet (first boot, before the backfill cron has run).
 */
export async function seedSp500(): Promise<void> {
  const client = await pool.connect();
  try {
    // Backfilled, non-removed members and the date each one's history begins.
    const { rows: members } = await client.query<{
      symbol: string;
      first_bar: string;
    }>(
      `SELECT us.symbol, MIN(pb.ts)::date::text AS first_bar
         FROM universe_symbol us
         JOIN price_bar pb ON pb.symbol = us.symbol
        WHERE us.backfilled = true
          AND us.removed_at IS NULL
        GROUP BY us.symbol
        ORDER BY us.symbol`,
    );

    if (members.length === 0) {
      console.log(
        '[seed:sp500] no backfilled symbols with bars yet — skipping (will seed once backfill runs)',
      );
      return;
    }

    // Latest first-bar date so every member has a bar at or before base_date.
    const baseDate = members.reduce(
      (max, m) => (m.first_bar > max ? m.first_bar : max),
      members[0]!.first_bar,
    );

    await client.query('BEGIN');

    const { rows: etfRows } = await client.query<{ id: string }>(
      `INSERT INTO etf (key, name, base_date)
         VALUES ('sp500', 'S&P 500', $1)
       ON CONFLICT (key) DO UPDATE
         SET name = EXCLUDED.name, base_date = EXCLUDED.base_date
       RETURNING id`,
      [baseDate],
    );
    const etfId = etfRows[0]!.id;

    // Fully replace the weight set so membership changes are reflected.
    await client.query(`DELETE FROM etf_weight WHERE etf_id = $1`, [etfId]);
    for (const { symbol } of members) {
      await client.query(
        `INSERT INTO etf_weight (etf_id, symbol, weight) VALUES ($1, $2, 1)`,
        [etfId, symbol],
      );
    }

    await client.query('COMMIT');
    console.log(
      `[seed:sp500] seeded equal-weight S&P 500 ETF: members=${members.length} base_date=${baseDate}`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
