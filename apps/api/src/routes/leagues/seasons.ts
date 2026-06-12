/**
 * Fantasy Street item 08 — season lifecycle & history routes, mounted under
 * /api/v1.
 *   GET  /leagues/:id/seasons       past + current seasons, newest first
 *   GET  /leagues/:id/seasons/:n    one season's final standings + bracket
 *   POST /leagues/:id/seasons       open the next season (commissioner)
 *
 * Reads are member-gated and archived seasons are immutable (history is
 * read-only); the POST is the only mutation and re-opens an archived league for
 * a re-draft via fantasy/season.ts. Bracket + standings reads reuse fs_matchup /
 * fs_standings written by settle.ts and playoffs.ts.
 */
import type { FastifyInstance } from 'fastify';
import type {
  Season,
  SeasonsResponse,
  SeasonDetail,
  Matchup,
  Standing,
} from '@tickr/shared-types';
import { pool } from '../../db/pool.js';
import {
  requireLeagueMember,
  requireCommissioner,
} from '../../fantasy/guards.js';
import {
  listSeasons,
  loadSeason,
  startNewSeason,
  type SeasonRow,
} from '../../fantasy/season.js';
import { FantasyError } from '../../fantasy/leagues.js';
import { sendFantasyError } from './_shared.js';

function toSeason(r: SeasonRow): Season {
  return {
    id: r.id,
    leagueId: r.league_id,
    seasonNumber: r.season_number,
    status: r.status,
    regularWeeks: r.regular_weeks,
    playoffSeeds: r.playoff_seeds,
    championUserId: r.champion_user_id,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
  };
}

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

export function registerSeasonRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { id: string } }>(
    '/leagues/:id/seasons',
    async (req, reply) => {
      if (!(await requireLeagueMember(req, reply, req.params.id))) return;
      try {
        const seasons = await listSeasons(pool, req.params.id);
        return { seasons: seasons.map(toSeason) } satisfies SeasonsResponse;
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  fastify.get<{ Params: { id: string; n: string } }>(
    '/leagues/:id/seasons/:n',
    async (req, reply) => {
      if (!(await requireLeagueMember(req, reply, req.params.id))) return;
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 1) {
        return reply.code(422).send({
          error: {
            code: 'VALIDATION',
            message: 'season number must be a positive integer',
          },
        });
      }
      try {
        const season = await loadSeason(pool, req.params.id, n);
        if (!season) {
          return reply.code(404).send({
            error: { code: 'NOT_FOUND', message: 'Season not found' },
          });
        }
        const { rows: standings } = await pool.query<{
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
          [req.params.id, n],
        );
        const { rows: matchups } = await pool.query<MatchupRow>(
          `SELECT id, league_id, season, week, home_user_id, away_user_id,
                  home_points::float8 AS home_points,
                  away_points::float8 AS away_points,
                  winner_user_id, status
             FROM fs_matchup
            WHERE league_id = $1 AND season = $2 AND is_playoff = true
            ORDER BY round, week, home_user_id`,
          [req.params.id, n],
        );
        return {
          season: toSeason(season),
          standings: standings.map(
            (r): Standing => ({
              userId: r.user_id,
              wins: r.wins,
              losses: r.losses,
              ties: r.ties,
              pointsFor: r.points_for,
              pointsAgainst: r.points_against,
              rank: r.rank,
            }),
          ),
          playoffMatchups: matchups.map(toMatchup),
        } satisfies SeasonDetail;
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/leagues/:id/seasons',
    async (req, reply) => {
      if (!(await requireCommissioner(req, reply, req.params.id))) return;
      try {
        const season = await startNewSeason(pool, req.params.id);
        return reply.code(201).send(toSeason(season));
      } catch (err) {
        if (err instanceof FantasyError) return sendFantasyError(reply, err);
        throw err;
      }
    },
  );
}
