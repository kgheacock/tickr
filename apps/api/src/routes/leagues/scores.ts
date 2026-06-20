/**
 * Fantasy Street item 05 — weekly score read routes, mounted under /api/v1.
 *   GET /leagues/:id/scores?week=&season=              every manager's total + breakdown
 *   GET /leagues/:id/lineup/:userId/score?week=&season=  one team's per-slot explainer
 *
 * Thin glue over the read functions in fantasy/score.ts (the same source FS-06
 * matchups and FS-11 recaps read server-side). Scores are settled by the Friday
 * post-close job in jobs/scoring.ts; week is supplied by the caller (FS-06 owns
 * the schedule→week mapping), season defaults to 1.
 */
import type { FastifyInstance } from 'fastify';
import type {
  LeagueScoresResponse,
  SeasonWinsResponse,
} from '@tickr/shared-types';
import { pool } from '../../db/pool.js';
import { requireLeagueMember } from '../../fantasy/guards.js';
import {
  computeLeagueWeek,
  loadLeagueScores,
  loadWeeklyScore,
} from '../../fantasy/score.js';
import { loadSeasonWins } from '../../fantasy/wins.js';
import { currentWeek } from '../../fantasy/returns.js';
import { sendFantasyError } from './_shared.js';

/** Parse a 1-based integer query param, or undefined when absent/blank. */
function intParam(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

export function registerScoreRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { id: string };
    Querystring: { week?: string; season?: string };
  }>('/leagues/:id/scores', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const week = intParam(req.query.week) ?? 1;
    const season = intParam(req.query.season) ?? 1;
    if (Number.isNaN(week) || Number.isNaN(season)) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'week/season must be integers' },
      });
    }
    try {
      // Settled scores once the Friday post-close job has written them. Until
      // then the week is in-flight, so compute provisional totals so far (the
      // same FS-05 live path matchups overlays) — this is the in-progress team
      // total the My Team header reads. Anchor on currentWeek (close-aligned
      // baseline + weekEnd, asOf = now) so the team total reconciles with the
      // per-stock "This wk" column, which shares those anchors (players.ts).
      const settled = await loadLeagueScores(pool, req.params.id, week, season);
      const now = new Date();
      const { weekEnd, baselineAt } = currentWeek(now);
      const scores =
        settled.length > 0
          ? settled
          : await computeLeagueWeek(pool, {
              leagueId: req.params.id,
              season,
              week,
              weekEnd,
              asOf: now,
              baselineAt,
              provisional: true,
            });
      return { season, week, scores } satisfies LeagueScoresResponse;
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  // Season win standings — the dashboard leaderboard. A win is a first-place
  // finish in a settled week's ranking, tallied across every settled week of the
  // season (derived on read from fs_weekly_score; nothing stored).
  fastify.get<{
    Params: { id: string };
    Querystring: { season?: string };
  }>('/leagues/:id/wins', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const season = intParam(req.query.season) ?? 1;
    if (Number.isNaN(season)) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'season must be an integer' },
      });
    }
    try {
      const { weeks, entries } = await loadSeasonWins(
        pool,
        req.params.id,
        season,
      );
      return { season, weeks, entries } satisfies SeasonWinsResponse;
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  fastify.get<{
    Params: { id: string; userId: string };
    Querystring: { week?: string; season?: string };
  }>('/leagues/:id/lineup/:userId/score', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const week = intParam(req.query.week) ?? 1;
    const season = intParam(req.query.season) ?? 1;
    if (Number.isNaN(week) || Number.isNaN(season)) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'week/season must be integers' },
      });
    }
    try {
      const score = await loadWeeklyScore(
        pool,
        req.params.id,
        req.params.userId,
        week,
        season,
      );
      if (!score) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'No score for this week yet' },
        });
      }
      return score;
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });
}
