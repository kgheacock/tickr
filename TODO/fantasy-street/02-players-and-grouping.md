# FS-02 · Players & grouping

**Status:** `done` ([#55](https://github.com/kgheacock/tickr/pull/55)) · **Epic:** [Fantasy Street](README.md) · **Depends on:** market-data corpus

## User stories
- As a manager, I want to browse the full inventory of players (stocks), so
  that I can scout who to draft or pick up.
- As a manager, I want to filter the inventory by group (anchor, growth,
  momentum, value, defense, wildcard) and see who's already owned, so that I
  can find candidates for a specific slot.
- As a manager, I want to open a player's detail view — recent performance,
  price history, the slots they qualify for, and their ownership status — so
  that I can make an informed pick.
- As a manager, I want each stock to be ownable by only one person in my
  league, so that drafting involves real scarcity and competition.
- As a manager, I want defined roster positions, so that I must build a balanced
  team instead of grabbing only the hottest names.

## Goal

Turn the platform corpus (`universe_symbol` + `price_bar`) into a draftable
**player inventory**: each stock annotated with the **groups/slots it qualifies
for**, recent performance, and **per-league ownership status**. No new pricing —
this layer reads the existing corpus and adds a classification on top.

## Pre-reads
- [Epic README → Locked decisions](README.md#locked-decisions) (roster slots) and
  [Open questions #3/#4](README.md#open-questions-decide-before-building).
- `apps/api/src/routes/universe.ts` — corpus listing + `price_bar` coverage join.
- `apps/api/src/routes/prices.ts` — the `price_bar` hot-path query the detail
  view and classifier reuse.
- [docs/02-data-model.md §2.9, §2.10](../../docs/02-data-model.md#29-universe_symbol)
  — `universe_symbol`, `price_bar`.

## Design decisions (resolving open questions)
- **#4 Slot eligibility — classify from price-derived metrics + sector**
  (recommended). We have **no fundamentals feed**, so groups are computed from
  `price_bar` plus a static sector attribute:
  - **Anchor** — large, low-volatility names (low trailing 90-day σ, top
    liquidity quartile).
  - **Growth** — high trailing 12-month return.
  - **Momentum** — high trailing 3-month return.
  - **Value** — bottom valuation proxy (lowest 12-month return among non-Growth);
    flagged as a price-only proxy until a fundamentals source lands.
  - **Defense** — eligibility is universal (any tradeable name may be shorted).
  - **Wildcard** — universal.
  A symbol may qualify for **multiple** groups; eligibility is many-to-many.
  Sector/market-cap source for the cap-tier split stays an **open data item**
  (note it; seed a static sector map for now).
- **#3 Long-vs-short ownership — one or the other, never both** (recommended):
  a ticker is exactly one manager's long *or* one manager's short within a
  league. Enforced by the single-owner invariant on `fs_roster_entry`
  (`UNIQUE (league_id, symbol)` regardless of the `is_short` flag) — defined in
  [FS-03](03-live-draft.md). This item only **surfaces** ownership; FS-03 writes
  it.

## Steps
1. **Schema** — `1700000000007_fs_classification.sql`:
   - `fs_player_classification` — `symbol → universe_symbol(symbol)`,
     `group TEXT CHECK (group IN ('anchor','growth','momentum','value','defense','wildcard'))`,
     `eligible BOOLEAN`, `metrics JSONB` (the trailing returns/σ used),
     `computed_at`, `PRIMARY KEY (symbol, group)`.
2. **Classifier job** (`apps/api/src/fantasy/classify.ts`) — reads `price_bar`,
   computes trailing 3m/12m return and 90-day σ per backfilled symbol, assigns
   groups per the rules above, upserts `fs_player_classification`. Idempotent;
   re-runnable. Scheduled weekly in the `worker` role (alongside the EOD cron in
   `jobs/scheduler.ts`); also runnable on demand.
3. **`GET /api/v1/leagues/:id/players`** — paginated inventory. Joins
   `universe_symbol` (backfilled only) × `fs_player_classification` ×
   `fs_roster_entry` (this league) → each item carries `symbol`, `groups[]`,
   `recentReturnPct`, and `ownership: { owned: boolean, ownerTeam?, isShort? }`.
   Filters: `?group=`, `?available=true`, `?q=` (symbol search). League-scoped so
   ownership is correct per league.
4. **`GET /api/v1/leagues/:id/players/:symbol`** — detail view: classification +
   `metrics`, a `price_bar` window (reuse `routes/prices.ts` query, ~1y),
   the slots it qualifies for, and league ownership status.
5. **Eligibility helper** (`apps/api/src/fantasy/eligibility.ts`) —
   `slotsFor(symbol)` and `isEligible(symbol, slot)`, the shared predicate used
   by draft auto-pick (FS-03), lineup auto-fill (FS-04), and waivers (FS-07).
6. **Tests.** Classifier assigns expected groups for known fixtures; inventory
   reflects ownership and `?available` filter; detail view returns the price
   window + eligible slots; defense is universally eligible.

## Files
- Create: `apps/api/migrations/1700000000007_fs_classification.sql`,
  `apps/api/src/fantasy/classify.ts`, `fantasy/eligibility.ts`,
  `apps/api/src/routes/leagues/players.ts`,
  `apps/api/test/fantasy/classify.test.ts`,
  `apps/api/test/fantasy/players.test.ts`.
- Edit: `apps/api/src/jobs/scheduler.ts` (weekly classifier tick),
  `apps/api/src/routes/leagues/index.ts`, `packages/shared-types/src/fantasy.ts`.

## Definition of done
- [x] The classifier assigns each backfilled symbol to ≥1 group and writes
      `metrics`; a second run changes nothing (idempotent).
- [x] `GET /leagues/:id/players` lists the corpus with groups, recent return,
      and correct per-league ownership; `?group=` and `?available=true` filter.
- [x] The detail view returns classification, a price-history window, eligible
      slots, and ownership status.
- [x] `isEligible(symbol, 'defense')` is true for every tradeable symbol; the
      eligibility helper is the single source consumed by FS-03/04/07.
- [x] Open data item noted: sector/cap-tier source for Anchor/Value is a static
      seed pending a fundamentals feed.
