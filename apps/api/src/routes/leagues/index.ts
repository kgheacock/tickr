/**
 * Fantasy Street leagues routes (item 01), mounted under /api/v1.
 *   POST   /leagues            create
 *   GET    /leagues            discovery (?mine, ?open)
 *   GET    /leagues/:id        league view
 *   PATCH  /leagues/:id        commissioner settings (forming only)
 *   POST   /leagues/:id/invites mint an invite (commissioner)
 *   POST   /leagues/:id/join   join via token / open policy
 *   …/draft                    live snake draft (item 03)
 *   …/lineup                   weekly starting lineup (item 04)
 *   …/scores                   weekly scoring & shorting (item 05)
 *   …/schedule|matchups|standings  head-to-head schedule & standings (item 06)
 */
import type { FastifyInstance } from 'fastify';
import { registerCreateLeagueRoute } from './create.js';
import { registerViewLeagueRoute } from './view.js';
import { registerListLeaguesRoute } from './list.js';
import { registerInviteRoute } from './invites.js';
import { registerJoinLeagueRoute } from './join.js';
import { registerSettingsRoute } from './settings.js';
import { registerPlayersRoutes } from './players.js';
import { registerDraftRoutes } from './draft.js';
import { registerLineupRoutes } from './lineup.js';
import { registerScoreRoutes } from './scores.js';
import { registerMatchupRoutes } from './matchups.js';

export async function registerLeaguesRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  registerCreateLeagueRoute(fastify);
  registerListLeaguesRoute(fastify);
  registerViewLeagueRoute(fastify);
  registerSettingsRoute(fastify);
  registerInviteRoute(fastify);
  registerJoinLeagueRoute(fastify);
  registerPlayersRoutes(fastify);
  registerDraftRoutes(fastify);
  registerLineupRoutes(fastify);
  registerScoreRoutes(fastify);
  registerMatchupRoutes(fastify);
}
