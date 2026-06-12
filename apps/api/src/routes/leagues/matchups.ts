/**
 * Fantasy Street item 06 — schedule, matchup & standings read routes, mounted
 * under /api/v1.
 *   GET /leagues/:id/schedule?season=        full-season round-robin
 *   GET /leagues/:id/matchups?week=&season=   one week's head-to-heads (live overlay)
 *   GET /leagues/:id/standings?season=        ranked standings + tiebreaker fields
 *
 * Thin glue over fs_matchup / fs_standings (written by schedule.ts on
 * draft.complete and settle.ts after each Friday score). For a week that hasn't
 * settled yet, /matchups overlays provisional points from the FS-05 live-scoring
 * path so an in-progress scoreboard reads correctly before the Friday close.
 */
import type { FastifyInstance } from 'fastify';
import type {
  Matchup,
  ScheduleResponse,
  MatchupsResponse,
  StandingsResponse,
} from '@tickr/shared-types';
import { pool } from '../../db/pool.js';
import { requireLeagueMember } from '../../fantasy/guards.js';
import { computeLeagueWeek } from '../../fantasy/score.js';
import { decideWinner } from '../../fantasy/settle.js';
import { currentFriday } from '../../market/holidays.js';
import { sendFantasyError } from './_shared.js';

interface MatchupRow {
  id: string;
  league_id: string;
  season: number;
  week: number;
  home_user_id: string;
  away_user_id: string | null;
  home_points: number | null;
  away_points: number | null;
  winner_user_id: string | null;
  status: 'scheduled' | 'final';
}

function toMatchup(r: MatchupRow): Matchup {
  return {
    id: r.id,
    leagueId: r.league_id,
    season: r.season,
    week: r.week,
    homeUserId: r.home_user_id,
    awayUserId: r.away_user_id,
    homePoints: r.home_points,
    awayPoints: r.away_points,
    winnerUserId: r.winner_user_id,
    status: r.status,
  };
}

const MATCHUP_COLS = `id, league_id, season, week, home_user_id, away_user_id,
        home_points::float8 AS home_points, away_points::float8 AS away_points,
        winner_user_id, status`;

/** Parse a 1-based integer query param, or undefined when absent/blank. */
function intParam(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

export function registerMatchupRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { id: string };
    Querystring: { season?: string };
  }>('/leagues/:id/schedule', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const season = intParam(req.query.season) ?? 1;
    if (Number.isNaN(season)) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'season must be an integer' },
      });
    }
    try {
      const { rows } = await pool.query<MatchupRow>(
        `SELECT ${MATCHUP_COLS} FROM fs_matchup
          WHERE league_id = $1 AND season = $2
          ORDER BY week, home_user_id`,
        [req.params.id, season],
      );
      return {
        season,
        matchups: rows.map(toMatchup),
      } satisfies ScheduleResponse;
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { week?: string; season?: string };
  }>('/leagues/:id/matchups', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const week = intParam(req.query.week) ?? 1;
    const season = intParam(req.query.season) ?? 1;
    if (Number.isNaN(week) || Number.isNaN(season)) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'week/season must be integers' },
      });
    }
    try {
      const { rows } = await pool.query<MatchupRow>(
        `SELECT ${MATCHUP_COLS} FROM fs_matchup
          WHERE league_id = $1 AND season = $2 AND week = $3
          ORDER BY home_user_id`,
        [req.params.id, season, week],
      );
      const matchups = rows.map(toMatchup);

      // If the week hasn't settled, overlay live provisional points so the
      // scoreboard reads correctly before the Friday close.
      const provisional =
        matchups.length > 0 && matchups.some((m) => m.status !== 'final');
      if (provisional) {
        const live = await computeLeagueWeek(pool, {
          leagueId: req.params.id,
          season,
          week,
          weekEnd: currentFriday(new Date()),
          asOf: new Date(),
          provisional: true,
        });
        const points = new Map(live.map((s) => [s.userId, s.totalPoints]));
        for (const m of matchups) {
          if (m.status === 'final') continue;
          m.homePoints = points.get(m.homeUserId) ?? null;
          if (m.awayUserId == null) continue; // bye — no opponent to score
          m.awayPoints = points.get(m.awayUserId) ?? null;
          m.winnerUserId = decideWinner(
            m.homeUserId,
            m.awayUserId,
            m.homePoints ?? 0,
            m.awayPoints ?? 0,
          );
        }
      }

      return { season, week, provisional, matchups } satisfies MatchupsResponse;
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { season?: string };
  }>('/leagues/:id/standings', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const season = intParam(req.query.season) ?? 1;
    if (Number.isNaN(season)) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'season must be an integer' },
      });
    }
    try {
      const { rows } = await pool.query<{
        user_id: string;
        wins: number;
        losses: number;
        ties: number;
        points_for: number;
        points_against: number;
        rank: number;
      }>(
        `SELECT user_id, wins, losses, ties,
                points_for::float8 AS points_for,
                points_against::float8 AS points_against, rank
           FROM fs_standings
          WHERE league_id = $1 AND season = $2
          ORDER BY rank`,
        [req.params.id, season],
      );
      return {
        season,
        standings: rows.map((r) => ({
          userId: r.user_id,
          wins: r.wins,
          losses: r.losses,
          ties: r.ties,
          pointsFor: r.points_for,
          pointsAgainst: r.points_against,
          rank: r.rank,
        })),
      } satisfies StandingsResponse;
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });
}
