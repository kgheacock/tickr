/**
 * Fantasy Street — merged daily-close resolver (single source of precedence).
 *
 * FS values every position at one daily close. Two stores hold closes:
 *   • session_close — the official regular-session close from Finnhub /quote
 *     (frozen after 16:00 ET), keyed by `session_date` (DATE). It leads at the
 *     edge: it carries a trading day's close hours-to-days before Massive's
 *     free-tier 15-min bars backfill it, but only accrues forward from when
 *     close-capture launched (no deep history) — see jobs/close-capture.ts.
 *   • price_bar — Massive's authoritative 15-min bars, keyed by `ts`. Full
 *     backfilled history, but a session's bars land the *next* trading day.
 *
 * FS prefers session_close — it is the official close (price_bar's regular-close
 * lookup lands on the 15:45 bar, not the auction print) and the only store that
 * carries the just-closed session early — and falls back to price_bar for any
 * close it lacks.
 *
 * This SUPERSEDES the price_bar-preferred recipe in migration
 * 1700000000023_session-close.sql. As implemented, the price_bar "at-or-before"
 * lookup is non-null on a Friday evening (it resolves to Thursday's bar), so a
 * price_bar-first COALESCE would short-circuit and never reach session_close —
 * defeating the very leading-edge settle the table exists for.
 *
 * SCOPED TO FS READERS ONLY. price_bar stays Massive-pure for eval/replay.ts
 * (backtests) and routes/prices.ts (charts), so their reproducibility is
 * untouched — this resolver is the only place that consults session_close.
 *
 * ADDITIVE INVARIANT: with session_close empty, this resolves byte-identically
 * to the prior price_bar-only lookup, so every existing FS test stays green.
 *
 * The anchor `at` is a point-in-time instant (e.g. 1ms before 16:00 ET from
 * nyseRegularCloseAnchor). The session it represents is its ET calendar date:
 * `at AT TIME ZONE 'America/New_York'` renders the ET wall clock and `::date`
 * takes that day. A holiday-Friday anchor keys to a non-trading date that has no
 * session_close row, so it falls through to the price_bar walk-back — matching
 * today's behavior.
 *
 * FOLLOW-UP (TODO): a sanity guard — reject a session_close that deviates beyond
 * a threshold from the nearby price_bar close — so one bad-but-positive Finnhub
 * print can't win unchecked. Deferred; capture already drops c <= 0.
 */

/**
 * A scalar SQL subquery (a COALESCE expression) resolving the merged daily close
 * for `symbolExpr` at the instant `atParam`. Both arguments are raw SQL
 * fragments — a column reference (e.g. `'us.symbol'`) or a bound placeholder
 * (e.g. `` `$${n + 1}` ``); a placeholder may be reused, so no param renumbering
 * is needed at call sites. session_close wins on the anchor's ET date; otherwise
 * the most recent price_bar at-or-before `atParam`.
 */
export function mergedCloseSql(symbolExpr: string, atParam: string): string {
  return `COALESCE(
    (SELECT close FROM session_close
      WHERE symbol = ${symbolExpr}
        AND session_date = (${atParam} AT TIME ZONE 'America/New_York')::date),
    (SELECT close FROM price_bar
      WHERE symbol = ${symbolExpr} AND ts <= ${atParam}
      ORDER BY ts DESC LIMIT 1)
  )`;
}

/**
 * SQL for one symbol's merged DAILY price series, one row per ET trading day,
 * oldest-first: `session_date`, a `ts` at 16:00 ET, daily `open/high/low/close`
 * and `volume`. price_bar is 15-min intraday bars (incl. extended hours), so it
 * is collapsed per ET session to a single regular-session bar — the close is the
 * last bar before 16:00 ET (the 15:45 print, matching mergedCloseSql's anchor),
 * NOT the after-hours print; the [09:30, 16:00) filter also keeps open/high/low
 * honest (no pre-market). The official `session_close` is then overlaid on the
 * close with the same precedence as mergedCloseSql. A session that exists only
 * in session_close (the most-recent day, before Massive backfills) appears with
 * null OHLC — callers that need non-null OHLC coalesce them to the close.
 *
 * Powers FS readers that need the whole series rather than a point close —
 * classify.ts (trailing returns / volatility over real trading-day windows) and
 * getPlayerDetail's chart. `symbolParam` is the symbol placeholder; `sinceExpr`,
 * when given, is a SQL timestamptz expression (e.g. a 3-month window) AND-ed into
 * BOTH the price_bar scan (`ts >= …`) and the session_close scan
 * (`session_date >= (…)::date`) so the window bounds both stores.
 */
export function mergedDailySeriesSql(
  symbolParam: string,
  sinceExpr?: string,
): string {
  const pbSince = sinceExpr ? `AND ts >= ${sinceExpr}` : '';
  const scSince = sinceExpr ? `AND session_date >= (${sinceExpr})::date` : '';
  return `WITH pb AS (
      SELECT
        (ts AT TIME ZONE 'America/New_York')::date AS session_date,
        (array_agg(open  ORDER BY ts ASC))[1]      AS open,
        max(high)                                  AS high,
        min(low)                                   AS low,
        (array_agg(close ORDER BY ts DESC))[1]     AS close,
        sum(volume)                                AS volume
      FROM price_bar
      WHERE symbol = ${symbolParam}
        AND (ts AT TIME ZONE 'America/New_York')::time >= time '09:30'
        AND (ts AT TIME ZONE 'America/New_York')::time <  time '16:00'
        ${pbSince}
      GROUP BY 1
    ),
    sc AS (
      SELECT session_date, close
      FROM session_close
      WHERE symbol = ${symbolParam}
        ${scSince}
    )
    SELECT
      COALESCE(pb.session_date, sc.session_date) AS session_date,
      ((COALESCE(pb.session_date, sc.session_date)::timestamp
        + interval '16 hours') AT TIME ZONE 'America/New_York') AS ts,
      pb.open,
      pb.high,
      pb.low,
      COALESCE(sc.close, pb.close)               AS close,
      pb.volume
    FROM pb
    FULL OUTER JOIN sc ON sc.session_date = pb.session_date
    ORDER BY 1 ASC`;
}
