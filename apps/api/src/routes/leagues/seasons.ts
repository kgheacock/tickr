/**
 * Fantasy Street item 08 — season lifecycle & history routes, mounted under
 * /api/v1.
 *   GET  /leagues/:id/seasons       past + current seasons, newest first
 *   GET  /leagues/:id/seasons/:n    one season's lifecycle row
 *   POST /leagues/:id/seasons       open the next season (commissioner)
 *
 * The game is weekly-ranking-only, so a season carries no standings or playoff
 * bracket — it is purely a re-draft container. Reads are member-gated and
 * archived seasons are immutable (history is read-only); the POST is the only
 * mutation and re-opens an archived league for a re-draft via fantasy/season.ts.
 */
import type { FastifyInstance } from 'fastify';
import type {
  Season,
  SeasonsResponse,
  SeasonDetail,
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
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
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
        return { season: toSeason(season) } satisfies SeasonDetail;
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
