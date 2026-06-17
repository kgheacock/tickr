# FS-05 · Scoring & shorting

**Status:** `done` ([#63](https://github.com/kgheacock/tickr/pull/63)) · **Epic:** [Fantasy Street](README.md) · **Depends on:** 02, 04

## User stories
- As a manager, I want my weekly score to come from how my started stocks moved
  that week, so that good picks are rewarded.
- As a manager, I want losses to count against me, so that risky picks carry
  real downside and a balanced team matters.
- As a manager, I want to see how each slot contributed to my weekly score, so
  that I understand why I won or lost.
- As a manager, I want my Defense slot to be a short that earns points when the
  stock falls, so that I can profit in down markets and hedge my team.
- As a manager, I want shorting a name to use up that stock for the whole
  league, so that betting against a stock is a real strategic tradeoff.
- As a manager, I want a short squeeze to genuinely hurt, so that the Defense
  slot carries real risk, not free insurance.

## Goal

Compute each manager's **weekly score** from their locked lineup's price moves,
with **losses counted fully** and the **Defense slot scored as a short**. Persist
a **per-slot contribution breakdown** — the explainer the manager sees and the
data source FS-06 (matchups) and FS-11 (recaps) read.

## Pre-reads
- [Epic README → Scoring rules (canonical)](README.md#scoring-rules-canonical-reference)
  — the `r` / `−r` formulas + the worked-through short table. **Do not
  re-derive; implement these.**
- [FS-04](04-rosters-and-lineups.md) — the locked `fs_lineup` / `fs_lineup_slot`
  set this scores.
- `apps/api/src/routes/prices.ts` / `eval/replay.ts` — the `price_bar` close
  lookup pattern (Friday-close resolution) the scorer reuses.
- `apps/api/src/jobs/scheduler.ts` — the `0 30 21 * * 1-5` post-close cadence;
  scoring fires the Friday firing.

## Design decisions
- **Weekly return** `r = (this Friday close − last Friday close) / last Friday
  close`, per symbol, from `price_bar` (use the most recent close at-or-before
  each Friday, mirroring `eval/replay.ts` point-in-time resolution; holiday-short
  weeks resolve to the last available close).
- **This-Friday close = authoritative else provisional** (TODO/30). Massive's
  free tier doesn't serve the current day and the intraday sweep never runs
  weekends, so **this** Friday's authoritative `price_bar` close doesn't land
  until Monday — but the scorer settles Friday evening. The Finnhub close-capture
  job (`session_close`, keyed by `(symbol, session_date)`) fills it provisionally
  after the close. So the **this-Friday** leg resolves
  `COALESCE(price_bar close at-or-before Friday, session_close for that
  session_date)`; the **last-Friday** leg reads `price_bar` only (its
  authoritative bar is always present a week later). When Monday's real bar lands
  the authoritative value wins automatically — no overwrite logic, no phantom
  rows (authoritative keyed by `ts`, provisional by `session_date`; they never
  collide). `returns.ts` owns this fallback; `replay.ts`/`prices.ts` stay
  `price_bar`-only so backtests never see provisional same-day data.
- **Points** — long slot `= r`; Defense (short) `= −r`. Weekly total =
  Σ started slots, **uncapped, losses included** (locked decision; mercy cap is
  open question #2, deferred). Short gain floored at 0 (−100% → +100); short
  loss unbounded (the "pick-six").
- **Shorting reuses the single-owner invariant** — a short is a normal
  `fs_roster_entry` with `is_short=true`; `UNIQUE (league_id, symbol)` (FS-03)
  already makes that ticker off-board for everyone, long or short (#3).

## Steps
1. **Schema** — `1700000000010_fs_scores.sql`:
   - `fs_weekly_score` — `league_id`, `user_id`, `season SMALLINT`,
     `week SMALLINT`, `total_points NUMERIC(12,2)`, `computed_at`,
     `breakdown JSONB` (array of `{ slot, symbol, isShort, lastClose, thisClose,
     returnPct, points }`), `PRIMARY KEY (league_id, user_id, season, week)`.
2. **Return resolver** (`apps/api/src/fantasy/returns.ts`) — `weeklyReturn(symbol,
   weekEndFriday)` reads the two Friday closes from `price_bar` and returns `r`;
   handles missing/holiday closes by walking back to the last available bar.
3. **Scorer** (`apps/api/src/fantasy/score.ts`) — for one (league, week): load
   each manager's locked `fs_lineup_slot` started set, compute per-slot points
   (`r`, or `−r` for `is_short`), sum to `total_points`, write
   `fs_weekly_score` with the full `breakdown`. Idempotent upsert (re-scoring a
   week overwrites — supports FS-12 dispute corrections).
4. **Scoring job** — from `jobs/scheduler.ts`, the **Friday** post-close firing
   under a Redis lock: score the just-closed week for every `active` league, then
   publish `score.updated`. Hands off to FS-06 to settle matchups.
   - **Run *after* close-capture completes, not at the same instant.** TODO/30's
     capture also fires `0 30 21 * * 5` and its ~9-min sweep isn't finished when
     it starts — a scorer that also fires at 21:30 would read a half-populated
     `session_close`. Schedule this settle later (e.g. `0 45 21 * * 5`, or gate it
     on the capture lock being free) so every provisional close is in place first.
5. **Read endpoints.** `GET /leagues/:id/scores?week=` (all managers' totals +
   breakdown for the week) and `GET /leagues/:id/lineup/:userId/score?week=`
   (one team's per-slot explainer).
6. **Live in-week scoring (provisional).** Expose a best-effort current score
   from the latest available close during the week (not just Friday) so FS-09
   can show a live matchup; mark it provisional until the Friday settle. Register
   the live topic `{ kind: 'matchup'; leagueId; week }` in `ws/topics.ts` +
   the `WsTopic` union in `shared-types/ws.ts`, and publish `matchup.updated`
   via `events/publisher.ts` as provisional scores change.
7. **Tests.** Reproduce the README worked examples (short TSLA −4% → +4; +4% →
   −4; →0 → +100 floored; squeeze +30% → −30); losses reduce the total;
   uncapped totals; breakdown sums to `total_points`; idempotent re-score.

## Files
- Create: `apps/api/migrations/1700000000010_fs_scores.sql`,
  `apps/api/src/fantasy/returns.ts`, `fantasy/score.ts`,
  `apps/api/src/routes/leagues/scores.ts`,
  `apps/api/test/fantasy/score.test.ts`, `test/fantasy/returns.test.ts`.
- Edit: `apps/api/src/jobs/scheduler.ts` (Friday scoring cron),
  `apps/api/src/ws/topics.ts`, `events/publisher.ts`,
  `apps/api/src/routes/leagues/index.ts`,
  `packages/shared-types/src/ws.ts` + `fantasy.ts`.

## Definition of done
- [x] Each README short example reproduces exactly (+4 / −4 / +100 floored /
      −30), and a long slot scores `r`.
- [x] Weekly total is the uncapped sum of started slots with losses included;
      the `breakdown` sums to `total_points`.
- [x] The Friday post-close job scores every active league's just-closed week
      and publishes `score.updated`; re-running overwrites cleanly.
- [x] The per-slot breakdown is queryable and is the data FS-06 and FS-11 read.
- [x] A shorted ticker is unavailable to every other manager in the league
      (single-owner invariant holds for shorts).

## Implementation notes
- Migration `1700000000010_fs_scores.sql` (`fs_weekly_score`: total +
  JSONB breakdown, idempotent upsert). Domain in `fantasy/returns.ts`
  (point-in-time `weeklyReturn`, holiday-aware, `asOf` for provisional) and
  `fantasy/score.ts` (scorer + settle + read functions). Job in `jobs/scoring.ts`
  driven by two `jobs/scheduler.ts` crons: Friday post-close settle
  (`score.updated`) and Mon–Thu provisional push (`matchup.updated`).
- Live `matchup` WS topic (member-gated in `ws/server.ts`, keyed per league+week
  in `ws/topics.ts` + `shared-types/ws.ts`); `score.updated` is a plain domain
  event in `events/publisher.ts`, mirroring `lineup.locked`.
- Read routes in `routes/leagues/scores.ts`. Tests in
  `test/fantasy/score.test.ts` + `returns.test.ts`.
- Deferred to later items: schedule→week mapping (the job targets week 1 until
  FS-06); FS-06 consumes `score.updated` to settle matchups.
