# FS-07 · Waivers & trades

**Status:** `done` ([#68](https://github.com/kgheacock/tickr/pull/68)) · **Epic:** [Fantasy Street](README.md) · **Depends on:** 04, 06

## User stories
- As a manager, I want to pick up undrafted stocks during the season, so that I
  can adapt as the market moves.
- As a manager, I want waiver priority to favor lower-ranked managers, so that
  the league stays competitive.
- As a manager, I want to propose and accept trades with other managers, so
  that I can reshape my team mid-season.

## Goal

Let rosters change mid-season through **waiver claims** (add an undrafted stock,
drop one) and **manager-to-manager trades**, while **preserving the single-owner
invariant** through every transaction. Waiver priority favors lower-ranked teams
to keep the league competitive.

## Pre-reads
- [FS-03](03-live-draft.md) — `fs_roster_entry` and `UNIQUE (league_id, symbol)`;
  every add/drop/trade mutates this table and must respect the invariant.
- [FS-06](06-matchups-and-standings.md) — `fs_standings.rank` drives waiver
  priority (reverse-standings).
- [FS-04](04-rosters-and-lineups.md) — the lineup lock; transactions process in
  the **unlocked window** (between Friday settle and Monday lock).
- [FS-02](02-players-and-grouping.md) — only `available` (unowned, backfilled)
  symbols are claimable.

## Design decisions
- **Processing window** — adds/drops and trades **process between weeks**: claims
  submitted during the week are batched and resolved at a waiver run after the
  Friday settle, before the Monday lock. Direct free-agent pickups (no contention)
  may resolve immediately if the league setting allows.
- **Waiver priority** — **reverse standings** (worst record claims first);
  successful claim sends the claimant to the back of the order (rolling
  priority). Ties broken by points-for ascending.
- **Single-owner invariant is the hard rule** — every add/trade insert/move is
  validated and DB-guarded by `UNIQUE (league_id, symbol)`; an add must be paired
  with a drop so roster size stays fixed; a trade is an atomic multi-row swap in
  one txn.

## Steps
1. **Schema** — `1700000000013_fs_transactions.sql`:
   - `fs_waiver_claim` — `id`, `league_id`, `user_id`, `add_symbol`,
     `drop_symbol`, `is_short BOOLEAN`, `status TEXT CHECK (status IN
     ('pending','won','lost','invalid'))`, `submitted_at`, `processed_at`.
   - `fs_trade` — `id`, `league_id`, `proposer_user_id`, `target_user_id`,
     `status TEXT CHECK (status IN ('proposed','accepted','rejected','cancelled','expired'))`,
     `created_at`, `resolved_at`.
   - `fs_trade_item` — `trade_id`, `from_user_id`, `symbol`, `is_short` (the
     legs moving each direction).
   - `fs_waiver_order` — `league_id`, `season`, `user_id`, `priority SMALLINT`
     (rolling order; rebuilt from standings at season start, then mutated on win).
2. **Free-agent / waiver claim.** `POST /leagues/:id/waivers` `{ addSymbol,
   dropSymbol, isShort }` — validate add is `available`, eligible, and drop is on
   the caller's roster. Queue as `pending` (or resolve immediately if uncontested
   and the league allows).
3. **Waiver run** (`apps/api/src/fantasy/waivers.ts`, from `jobs/scheduler.ts`
   after the Friday settle, under a Redis lock): group `pending` claims by
   `add_symbol`, award each to the highest-priority claimant in one txn
   (drop → add, respecting the invariant), mark others `lost`, demote winners in
   `fs_waiver_order`, publish `waiver.processed`.
4. **Propose trade.** `POST /leagues/:id/trades` `{ targetUserId, give:[symbols],
   receive:[symbols] }` — validate all give-legs are the proposer's and all
   receive-legs are the target's; status `proposed`. Optional expiry.
5. **Respond.** `POST /leagues/:id/trades/:tradeId/accept|reject` (target) /
   `…/cancel` (proposer). On accept, **atomically** re-key the `fs_roster_entry`
   rows between owners in one txn (the invariant holds because owners swap, not
   duplicate); publish `trade.accepted`. Reject stale trades if a leg has since
   moved.
6. **Read endpoints.** `GET /leagues/:id/waivers` (my claims + order),
   `GET /leagues/:id/trades` (incoming/outgoing).
7. **Tests.** Reverse-priority award + rolling demotion; contested claim awards
   one winner and invalidates the rest; add-without-drop rejected; trade swap is
   atomic and invariant-preserving; accepting a trade whose leg moved is rejected.

## Files
- Create: `apps/api/migrations/1700000000013_fs_transactions.sql`,
  `apps/api/src/fantasy/waivers.ts`, `fantasy/trades.ts`,
  `apps/api/src/routes/leagues/waivers.ts`, `routes/leagues/trades.ts`,
  `apps/api/test/fantasy/waivers.test.ts`, `test/fantasy/trades.test.ts`.
- Edit: `apps/api/src/jobs/scheduler.ts` (waiver-run firing),
  `events/publisher.ts`, `apps/api/src/routes/leagues/index.ts`,
  `packages/shared-types/src/fantasy.ts`.

## Definition of done
- [x] A contested waiver awards the add to the highest-priority (worst-ranked)
      claimant, invalidates the losers, and demotes the winner in the order.
- [x] An add must be paired with a drop; roster size is invariant.
- [x] A proposed trade can be accepted, rejected, or cancelled; accepting swaps
      ownership atomically and the single-owner invariant holds throughout.
- [x] Picking up or trading for an already-owned ticker is impossible
      (DB-enforced).
- [x] Transactions resolve in the unlocked between-weeks window and never alter a
      locked lineup.
