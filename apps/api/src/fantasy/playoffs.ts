/**
 * Fantasy Street item 08 — the playoff bracket.
 *
 * A short regular season seeds a single-elimination bracket from fs_standings;
 * the bracket advances round by round to a champion. The bracket shape is pure
 * (seedOrder / computeBracket — unit-tested in test/fantasy/playoffs.test.ts);
 * `materializeBracket` is the idempotent DB projection: it recomputes the whole
 * bracket from the settled playoff matchups so far and inserts whatever round's
 * matchups don't exist yet, crowning the champion once the final settles.
 *
 * Playoff games reuse fs_matchup (is_playoff=true, round=tier, week =
 * regular_weeks + round); the higher seed is home. settle.ts settles them
 * through the same path as regular games and calls this after each week.
 */
import type { Pool, PoolClient } from 'pg';
import type { SeasonRow } from './season.js';

/** A seeded entrant — `seed` is its 1-based standings rank (1 = best). */
export interface Entrant {
  userId: string;
  seed: number;
}

/** One bracket game; `away` null is a bye (the home entrant auto-advances). */
export interface Pairing {
  home: Entrant;
  away: Entrant | null;
}

export interface BracketResult {
  /** Rounds 1..final in bracket order; only rounds derivable from results so far. */
  rounds: Pairing[][];
  /** Set once the final settles; null while the bracket is unresolved. */
  champion: Entrant | null;
}

/** Smallest power of two ≥ n (min 2) — the padded bracket size. */
export function nextPow2(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

/**
 * Standard single-elimination seeding order for a power-of-two bracket: the
 * positions such that seed 1 and seed 2 can only meet in the final, and each
 * consecutive pair (i, i+1) is a first-round game with the better seed first.
 * seedOrder(4) = [1,4,2,3]; seedOrder(8) = [1,8,4,5,2,7,3,6].
 */
export function seedOrder(n: number): number[] {
  let order = [1];
  while (order.length < n) {
    const span = order.length * 2 + 1;
    const next: number[] = [];
    for (const s of order) {
      next.push(s, span - s);
    }
    order = next;
  }
  return order;
}

/**
 * Build the bracket from the seeded standings and the results known so far.
 * `winnerOf(a, b)` returns the (tie-resolved) winner of a played game, or null
 * when that game hasn't settled yet — so the returned `rounds` only extend as
 * deep as results allow, and the next unplayed round is always the last entry.
 * Pure: no DB, so the bracket shape and advancement are unit-testable.
 */
export function computeBracket(
  ranked: Entrant[],
  seeds: number,
  winnerOf: (a: string, b: string) => string | null,
): BracketResult {
  const k = Math.min(seeds, ranked.length);
  if (k < 2) return { rounds: [], champion: ranked[0] ?? null };

  const n = nextPow2(k);
  const order = seedOrder(n);
  // slot[pos] is the entrant in that bracket position, or null for a bye seat.
  const slot = order.map((s) => (s <= k ? ranked[s - 1]! : null));

  const round1: Pairing[] = [];
  for (let i = 0; i < n; i += 2) {
    // order puts the better seed first, so slot[i] is never the null seat;
    // slot[i + 1] may be a bye (null).
    round1.push({ home: slot[i]!, away: slot[i + 1]! });
  }

  const rounds: Pairing[][] = [round1];
  let current = round1;
  for (;;) {
    const advancers: (Entrant | null)[] = current.map((p) => {
      if (p.away === null) return p.home; // bye
      const w = winnerOf(p.home.userId, p.away.userId);
      if (w == null) return null; // not settled yet
      return w === p.home.userId ? p.home : p.away;
    });
    if (advancers.some((a) => a === null)) return { rounds, champion: null };

    const adv = advancers as Entrant[];
    if (adv.length === 1) return { rounds, champion: adv[0]! };

    const next: Pairing[] = [];
    for (let i = 0; i < adv.length; i += 2) {
      const a = adv[i]!;
      const b = adv[i + 1]!;
      const higher = a.seed <= b.seed ? a : b;
      const lower = a.seed <= b.seed ? b : a;
      next.push({ home: higher, away: lower });
    }
    rounds.push(next);
    current = next;
  }
}

/** Standings in rank order — the bracket seeds (seed = rank). */
async function seededEntrants(
  db: Pool | PoolClient,
  leagueId: string,
  season: number,
): Promise<Entrant[]> {
  const { rows } = await db.query<{ user_id: string; rank: number }>(
    `SELECT user_id, rank FROM fs_standings
      WHERE league_id = $1 AND season = $2
      ORDER BY rank`,
    [leagueId, season],
  );
  return rows.map((r) => ({ userId: r.user_id, seed: r.rank }));
}

/**
 * Recompute the bracket from the settled playoff matchups and insert any round
 * whose matchups don't exist yet; crown the champion when the final settles.
 * Idempotent — safe to call after every playoff-week settle (and on the
 * regular→playoffs flip, where it seeds round 1). Returns the champion's user
 * id when this call crowned one, else null.
 */
export async function materializeBracket(
  db: PoolClient,
  leagueId: string,
  season: SeasonRow,
): Promise<string | null> {
  const ranked = await seededEntrants(db, leagueId, season.season_number);
  if (ranked.length < 2) return null;
  const seedOf = new Map(ranked.map((e) => [e.userId, e.seed]));

  // Settled playoff results so far, tie-resolved toward the higher seed.
  const { rows: played } = await db.query<{
    home_user_id: string;
    away_user_id: string | null;
    winner_user_id: string | null;
  }>(
    `SELECT home_user_id, away_user_id, winner_user_id
       FROM fs_matchup
      WHERE league_id = $1 AND season = $2 AND is_playoff = true
        AND status = 'final' AND away_user_id IS NOT NULL`,
    [leagueId, season.season_number],
  );
  const winners = new Map<string, string>();
  for (const m of played) {
    const away = m.away_user_id!;
    const resolved =
      m.winner_user_id ??
      ((seedOf.get(m.home_user_id) ?? Infinity) <=
      (seedOf.get(away) ?? Infinity)
        ? m.home_user_id
        : away);
    winners.set(pairKey(m.home_user_id, away), resolved);
  }
  const winnerOf = (a: string, b: string): string | null =>
    winners.get(pairKey(a, b)) ?? null;

  const bracket = computeBracket(ranked, season.playoff_seeds, winnerOf);

  // Insert any matchup the bracket calls for that isn't already on the board.
  for (let r = 0; r < bracket.rounds.length; r++) {
    const round = r + 1;
    const week = season.regular_weeks + round;
    for (const p of bracket.rounds[r]!) {
      await db.query(
        `INSERT INTO fs_matchup
           (league_id, season, season_id, week, home_user_id, away_user_id,
            status, is_playoff, round)
         VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', true, $7)
         ON CONFLICT (league_id, season, week, home_user_id) DO NOTHING`,
        [
          leagueId,
          season.season_number,
          season.id,
          week,
          p.home.userId,
          p.away?.userId ?? null,
          round,
        ],
      );
    }
  }

  if (bracket.champion) {
    const { rowCount } = await db.query(
      `UPDATE fs_season
          SET champion_user_id = $2, status = 'archived', ended_at = now()
        WHERE id = $1 AND status <> 'archived'`,
      [season.id, bracket.champion.userId],
    );
    if (rowCount && rowCount > 0) {
      await db.query(`UPDATE fs_league SET status = 'archived' WHERE id = $1`, [
        leagueId,
      ]);
      return bracket.champion.userId;
    }
  }
  return null;
}

/** Order-independent key for a played pair (winner lookup ignores home/away). */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
