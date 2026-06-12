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

// --- Scoring & shorting (item 05) ---
export type ScoreBreakdownItem = Schemas['ScoreBreakdownItem'];
export type WeeklyScore = Schemas['WeeklyScore'];
export type LeagueScoresResponse = Schemas['LeagueScoresResponse'];

// --- Matchups, schedule & standings (item 06) ---
export type Matchup = Schemas['Matchup'];
export type ScheduleResponse = Schemas['ScheduleResponse'];
export type MatchupsResponse = Schemas['MatchupsResponse'];
export type Standing = Schemas['Standing'];
export type StandingsResponse = Schemas['StandingsResponse'];

// --- Waivers & trades (item 07) ---
export type WaiverClaim = Schemas['WaiverClaim'];
export type WaiverOrderEntry = Schemas['WaiverOrderEntry'];
export type SubmitWaiverRequest = Schemas['SubmitWaiverRequest'];
export type WaiversResponse = Schemas['WaiversResponse'];
export type TradeItem = Schemas['TradeItem'];
export type Trade = Schemas['Trade'];
export type ProposeTradeRequest = Schemas['ProposeTradeRequest'];
export type TradesResponse = Schemas['TradesResponse'];

// --- Season & playoffs (item 08) ---
export type Season = Schemas['Season'];
export type SeasonStatus = Season['status'];
export type SeasonsResponse = Schemas['SeasonsResponse'];
export type SeasonDetail = Schemas['SeasonDetail'];

// --- Auto-managers / bots (item 10) ---
export type AddBotsRequest = Schemas['AddBotsRequest'];

// --- Reminders & recaps (item 11) ---
export type Notification = Schemas['Notification'];
export type NotificationKind = Notification['kind'];
export type NotificationsResponse = Schemas['NotificationsResponse'];
export type RecapSlot = Schemas['RecapSlot'];
export type RecapLeader = Schemas['RecapLeader'];
export type RecapPayload = Schemas['RecapPayload'];

// --- Commissioner & admin tools (item 12) ---
export type AuditEntry = Schemas['AuditEntry'];
export type AuditResponse = Schemas['AuditResponse'];
export type FantasyHealth = Schemas['FantasyHealth'];
export type StuckWeek = Schemas['StuckWeek'];
export type LeagueScoringRun = Schemas['LeagueScoringRun'];
