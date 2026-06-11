/**
 * Fantasy Street contract types — friendly aliases over the OpenAPI-generated
 * schemas (packages/shared-types/openapi.yaml → openapi.gen.ts). New FS items
 * add their schemas to the yaml and re-export the aliases here so the rest of
 * the epic imports `@tickr/shared-types` rather than reaching into `components`.
 */
import type { components } from './openapi.gen.js';

type Schemas = components['schemas'];

// --- Leagues & membership (item 01) ---
export type RosterConfig = Schemas['RosterConfig'];
export type LeagueMember = Schemas['LeagueMember'];
export type LeagueView = Schemas['LeagueView'];
export type LeagueSummary = Schemas['LeagueSummary'];
export type LeagueListResponse = Schemas['LeagueListResponse'];
export type LeagueMembership = Schemas['LeagueMembership'];
export type Invite = Schemas['Invite'];
export type CreateLeagueRequest = Schemas['CreateLeagueRequest'];
export type UpdateLeagueRequest = Schemas['UpdateLeagueRequest'];
export type CreateInviteRequest = Schemas['CreateInviteRequest'];
export type JoinLeagueRequest = Schemas['JoinLeagueRequest'];

export type LeagueStatus = LeagueView['status'];
export type JoinPolicy = LeagueView['joinPolicy'];
export type MemberRole = LeagueMember['role'];

// --- Players & grouping (item 02) ---
export type PlayerGroup = Schemas['PlayerGroup'];
export type PlayerMetrics = Schemas['PlayerMetrics'];
export type PlayerOwnership = Schemas['PlayerOwnership'];
export type PlayerInventoryItem = Schemas['PlayerInventoryItem'];
export type PlayerListResponse = Schemas['PlayerListResponse'];
export type PlayerDetail = Schemas['PlayerDetail'];

// --- Live draft (item 03) ---
export type DraftStatus = Schemas['DraftStatus'];
export type DraftPick = Schemas['DraftPick'];
export type DraftSlot = Schemas['DraftSlot'];
export type DraftState = Schemas['DraftState'];
export type MakePickRequest = Schemas['MakePickRequest'];

// --- Rosters & weekly lineups (item 04) ---
export type LineupSlot = Schemas['LineupSlot'];
export type Lineup = Schemas['Lineup'];
export type SetLineupSlot = Schemas['SetLineupSlot'];
export type SetLineupRequest = Schemas['SetLineupRequest'];
