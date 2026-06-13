# FS-13 · QA release review — PR #70 (Fantasy Street → `main`)

**Status:** `in-progress` — ✅ ready for manual QA · ❌ blocked on prod deploy
(migration renumber, F5) · **Epic:** [Fantasy Street](README.md)
**Role:** QA release lead · **Reviewed:** 2026-06-11 · **Final pass:** 2026-06-12
**PR:** [#70 — Fantasy street](https://github.com/kgheacock/tickr/pull/70)
(`fantasy-street` → `main`, +20,038 / −111, 133 files)

This is the integration PR for the **entire** Fantasy Street epic. At first
review (2026-06-11) it carried items **01–07**; it has since grown to land the
**whole epic — items 01–12** (item 00 already shipped in #48) onto `main`, as
items 08–12 merged into `fantasy-street` via #74/#76/#77/#79/#81. This file is
the single ledger of every deviation from the definition of done and every
correctness/isolation concern found, so a release decision can be made from one
place. The [final-pass re-scope](#final-pass-2026-06-12--full-epic-re-scope) at
the bottom records the full-epic review.

## Verdict

**Two-tier, as of the 2026-06-12 final pass:**

- ✅ **Ready for manual QA** (fresh / dev DB). A fresh database migrates the full
  FS chain cleanly, so functional QA is unblocked. F1/F2/F4 are fixed and
  re-confirmed present; F3 is intentional single-week MVP scope (now sharper —
  see below — but tracked and not a regression).
- ❌ **Blocked on prod deploy (F5).** The migration-ordering forward-risk flagged
  on 2026-06-11 has **materialized**: `main` shipped `020_symbol-coverage-watermark`
  (#75) and **it is now applied to prod**. The FS chain `012–019` sorts *before*
  the already-run `020`, so `node-pg-migrate` (`checkOrder: true`) aborts the prod
  upgrade before any new FS table is created. Deploy is gated until either the FS
  chain is renumbered to sort after `020` **or** `checkOrder` is disabled (F5,
  below — release owner's call). This does **not** block manual QA.

> **▶ Recommended next step: resolve F5 _before_ QA starts, then QA the final
> chain.** If QA runs now against `012–019`/`021–023` and the fix later renumbers
> to `024+`, QA will have exercised migration numbers that won't ship. Pick the F5
> resolution first (renumber vs. `checkOrder:false`), then run manual QA on a
> freshly migrated DB so QA matches what deploys.

**History (2026-06-11):** The original verdict was block-on-merge because F1
aborted the production migration. CI was green and a fresh DB migrated cleanly,
so the defect was invisible to the existing pipeline — it only manifested on the
prod *upgrade* path. F1 was fixed and re-verified on a scratch DB seeded to
prod's applied state; F2 degrades gracefully; F3 is confirmed single-week MVP
scope. The branch was brought up to date with `main` (intraday-live-tail merge,
conflicts resolved in the worker scheduler).

## Findings

| # | Sev | Finding | Location | PR comment |
|---|-----|---------|----------|------------|
| F1 | 🔴 Blocker | FS migrations `006–010` (+ a duplicate `007`) interleave with platform migrations `007_symbol-metadata` (#67) and `011_universe-dash-to-dot` that already shipped to `main`/prod. `node-pg-migrate` runs with default `checkOrder: true`, which rejects an un-run migration sorting before an already-run one. **Verified:** on a scratch DB at prod's applied state, `db:migrate` throws `Not run migration 1700000000006_fs_leagues is preceding already run migration 1700000000007_symbol-metadata` → deploy aborts. | `apps/api/migrations/1700000000006_fs_leagues.sql` … `010_fs_scores.sql`; duplicate `1700000000007_*`; `apps/api/src/db/migrate.ts` (no `checkOrder:false`) | [discussion_r3399624197](https://github.com/kgheacock/tickr/pull/70#discussion_r3399624197) |
| F2 | 🟡 Isolation | Core platform endpoint `/me` now **unconditionally** calls `getUserLeagues`, hard-joining `fs_league_member`/`fs_league` into every authenticated response. Couples the stock platform login bootstrap to FS schema; an independent FS rollback breaks `/me`. | `apps/api/src/routes/me.ts:29` | [discussion_r3399624261](https://github.com/kgheacock/tickr/pull/70#discussion_r3399624261) |
| F3 | 🟠 Limitation | Automated weekly crons (lineup-lock, weekly-settle, provisional-scoring) are pinned to week 1 via `currentWeek() => 1`. Item 06 builds a multi-week round-robin, but weeks ≥ 2 will never auto-lock/auto-settle until the `TODO(FS-06)` week-derivation lands. | `apps/api/src/jobs/scheduler.ts:42` | [discussion_r3399624310](https://github.com/kgheacock/tickr/pull/70#discussion_r3399624310) |

### F1 — recommended fix (verified)

Renumber the entire FS chain to sort **after** `011`, preserving
`leagues → classification → draft → lineups → scores → matchups → transactions`:

```
1700000000006_fs_leagues        → 1700000000012_fs_leagues
1700000000007_fs_classification → 1700000000013_fs_classification
1700000000008_fs_draft          → 1700000000014_fs_draft
1700000000009_fs_lineups        → 1700000000015_fs_lineups
1700000000010_fs_scores         → 1700000000016_fs_scores
1700000000012_fs_matchups       → 1700000000017_fs_matchups
1700000000013_fs_transactions   → 1700000000018_fs_transactions
```

No later migration carries an FK to `fs_roster_entry` / `fs_player_classification`,
so the move is DDL-safe. Re-running the scratch test with the renumbered set
clears `checkOrder` and begins applying `012_fs_leagues`. This also removes the
duplicate `1700000000007_*` filename. (Renumbering only `fs_classification` does
**not** fix it — the gate trips on `006_fs_leagues`.)

*Assumes no persistent env has already applied the old FS numbers* — true today
given manual-deploy discipline (prod is at `main`'s state; FS has never
deployed). If any env already ran `006–010`, renaming the files would orphan
those `pgmigrations` rows and needs a data-aware reconciliation instead.

## Definition-of-done check (items 01–07)

DoD checklists for 01–07 are internally satisfied and unit-tested (the PR adds
~3,500 lines of `apps/api/test/fantasy/*`). Deviations vs. the epic intent:

- **F3 (item 06)** — schedule/matchup/standings modules + endpoints meet their
  DoD, but the *cron integration* only ever drives week 1. The single-week MVP
  scope must be made explicit, not implicit.
- **Open data item (item 02)** — `value` classification is a price-only proxy;
  sector / market-cap tier is deferred pending a fundamentals feed. Documented in
  the `007_fs_classification` migration, not a regression — noted for tracking.

No DoD item was found falsely checked beyond the above.

## Isolation assessment (platform ↔ FS / parallel features)

Goal: FS must not prevent non-FS platform features from shipping in parallel.

- ✅ **Routes** — FS mounts under `/api/v1/leagues/*` via an additive
  `registerLeaguesRoutes`; no platform route changed.
- ✅ **Realtime** — new WS topics (`draft:*`, `matchup:*`) and Redis channels are
  FS-namespaced (`fs:*`); publisher additions are new functions only.
- ✅ **Jobs** — new crons use distinct `fs:job:*` locks; no platform job altered.
- ✅ **Schema** — all FS tables are `fs_*` prefixed; only FK reuse is `app_user` /
  `universe_symbol` (read-only).
- ⚠️ **F1 (migration numbering)** — the one real isolation breach: FS claimed
  migration numbers a parallel platform feature also used. **Discipline for
  future parallel work: number new migrations strictly greater than the highest
  number on every branch that will reach `main`, never backfill a gap.**
- ⚠️ **F2 (`/me` coupling)** — the only platform endpoint now hard-depending on FS.

## Resolution (2026-06-11)

- [x] **F1** — FS migration chain renumbered after `011`
      (`012_fs_leagues … 018_fs_transactions`); duplicate `007` filename removed;
      the stale "created in `…007`" comment in `014_fs_draft` repointed to
      `013_fs_classification`. **Re-verified** by replaying the prod upgrade on a
      scratch DB: applied prod's set (`000–005`, `007_symbol-metadata`, `011`),
      then ran the full renumbered set with `--check-order` — clean apply through
      `018_fs_transactions`, no `checkOrder` violation. A negative control
      (injecting a `006`) still throws the original
      `… is preceding already run migration 1700000000007_symbol-metadata`,
      confirming the test detects interleaving. FS-08 then added `019_fs_season`
      (PR #74); the chain now runs `012…019`.
  - ⚠️ **Forward risk (merge/deploy ordering):** a main-targeted PR (#75) claims
      `020_symbol-coverage-watermark`. It is **not** on `origin/main` yet, so the
      fix above holds for prod's current state (`000–005`, `007`, `011`). But
      `checkOrder` trips only on the prod *upgrade*, never in CI — so if `020`
      merges + **deploys to prod** before this PR deploys, the FS `012–019` chain
      will again sort before an already-run `020` and abort the deploy. Mitigation:
      deploy PR #70 **before** main's `020`, **or** renumber the FS chain to
      `021+` at that point. Tracked in the `project-migration-numbering` memory.
- [x] **F2** — `/me` now catches Postgres `42P01` (undefined_table) from
      `getUserLeagues` and degrades to `leagues: []` with a warn log; any other
      error still propagates. Platform login bootstrap no longer hard-depends on
      FS schema.
- [x] **F3** — single-week cron scope confirmed as intentional MVP and made
      explicit in `scheduler.ts` (`currentWeek()` comment); multi-week
      auto-advance tracked as a follow-up in
      [06-matchups-and-standings](06-matchups-and-standings.md).
- [x] Branch synced with `main`; scheduler merge conflict (intraday-live-tail vs
      FS crons) resolved and `scheduler.test.ts` updated to the merged 9-cron set.

### F4 (🟡, FIXED) — FS settle: uniform regular-close anchor + pre-settle capture

Main's intraday-live-tail refactor **removed** the dedicated 21:30 UTC
session-update cron the FS weekly-settle (Fri 21:35) was timed to read 5 min
after. Two problems surfaced:

1. **Uneven after-hours anchor.** `price_bar` carries extended-hours bars
   (04:00–~20:00 ET). The settle anchored on its wall-clock time (Fri 21:35 UTC =
   17:35 EDT), so `closeAtOrBefore` (`ts <= anchor`) picked whatever each symbol's
   last *after-hours* bar was — verified on the dev DB to range 16:00–17:30 ET
   across symbols (A→16:00, AAL→17:30, ABBV→17:00…). Different symbols were scored
   at **different points in the day**, and the prior-week baseline (`weekEnd − 7d`)
   drifted an hour across DST.
2. **Missing close.** The session-gated tail stops at 16:00 ET and a ~100-min
   sweep may not have landed every rostered symbol's final bar by settle.

**Fix (this PR):**
- `nyseRegularCloseAnchor()` (DST-aware) anchors *both* endpoints at the
  regular-session close (16:00 ET → 15:45 ET bar), uniformly for every symbol;
  baseline is re-derived zone-aware so a DST week stays 16:00-ET-to-16:00-ET.
  Verified on the dev DB: the new anchor selects the 15:45 ET bar for all symbols.
- `runWeeklyScoring` captures the just-closed bars for exactly the **rostered**
  symbols (bounded, dozens) before scoring, so the close is present for all.
- Settle-only; the provisional path (best-effort, never persisted) is unchanged.
- DST anchor unit-tested (`test/market/holidays.test.ts`).

The user accepted up to ~2h of settle lag provided the *same period is compared
across all* — the capture + regular-close anchor deliver exactly that.

## Final pass (2026-06-12) — full-epic re-scope

PR #70 stayed open and grew from items 01–07 to the **whole epic (01–12)**;
items 08–12 merged into `fantasy-street` via #74 (season/playoffs), #76
(dashboard), #77 (auto-managers), #79 (reminders/recaps), #81 (commissioner/
admin). Each of 08–12 has its own done-review + PR, so their per-item DoDs are
**not** re-litigated here. This pass covers the integration delta: prior findings
re-confirmed, the new code's isolation invariants, and the new migrations.

### Integration build/test status (integrated HEAD)

Ran against the merged `fantasy-street` HEAD (not per-PR snapshots), to catch
breakage from the merges + the scheduler conflict resolution:

- ✅ **Typecheck green** — `pnpm -r run typecheck` passes for `shared-types`,
  `api`, and `web`. This is the load-bearing integration signal: the cross-PR
  merges compile cleanly together.
- ⚠️ **Unit/integration suite not run to green here** — `apps/api` (`vitest`)
  requires a Postgres/Timescale **and** Redis instance; neither is provisioned in
  this review environment, and an attempted run failed on infra connection errors
  (`ioredis` ECONNREFUSED), not on assertions. Test-green therefore relies on
  per-PR CI; **the QA environment should run `pnpm --filter @tickr/api test`
  against provisioned DB + Redis once** to confirm the suite passes on the
  integrated HEAD (and re-run after the F5 resolution, since renumbering touches
  migrations the `test/db` suite exercises).

### F5 (🔴 Blocker — prod deploy only, NOT QA) — migration ordering materialized

The forward-risk recorded under F1 on 2026-06-11 has come true. State today:

- **prod applied set:** `{000–005, 007, 011, 020}` — `020_symbol-coverage-watermark`
  (#75) merged to `main` 2026-06-12 and **is live on prod** (confirmed with the
  release owner).
- **PR #70 brings (FS chain):** `012–019` (leagues→…→season) then `021, 022, 023`
  (bots, notifications, audit) — note it **skips `020`**.

With `checkOrder: true` (default; no override in `apps/api/src/db/migrate.ts`),
the prod upgrade sees pending `012_fs_leagues` sorting *before* already-run `020`
and throws `Not run migration …012_fs_leagues is preceding already run migration
…020_symbol-coverage-watermark` → deploy aborts before any FS table is created.
Invisible to CI and to a fresh-DB migrate; it only trips on the prod *upgrade*,
exactly like the original F1.

**Recommended fix — renumber the *entire* FS chain `012–023` → `024–035`,
preserving internal order.** It is **not** sufficient to renumber only `012–019`:
the newer FS migrations `021–023` (`fs_bot_member`, `fs_notification`,
`fs_audit_log`) all `REFERENCES fs_league(id)` (created in `012`), so they must
stay *after* the league/draft/lineup tables. Renumbering `012–019` above
`021–023` would invert that FK order. Shifting the whole contiguous block up
keeps every internal FK valid and sorts all of FS after prod's `020`.

```
012_fs_leagues        → 024_fs_leagues
013_fs_classification → 025_fs_classification
014_fs_draft          → 026_fs_draft
015_fs_lineups        → 027_fs_lineups
016_fs_scores         → 028_fs_scores
017_fs_matchups       → 029_fs_matchups
018_fs_transactions   → 030_fs_transactions
019_fs_season         → 031_fs_season
021_fs_bots           → 032_fs_bots
022_fs_notifications  → 033_fs_notifications
023_fs_audit          → 034_fs_audit
```

(Leaves a clean contiguous `024–034`; `035` reserved as headroom.) DDL-safe: no
non-FS migration FKs into any `fs_*` table, so the block moves wholesale.

**Alternative fix — `checkOrder: false` in `apps/api/src/db/migrate.ts`
(release owner's call).** Renumbering is a treadmill: it clears `020`, but every
*next* main migration that lands before #70 deploys re-triggers the same abort.
F1 chose renumber when it was 5 files and `main` was quiet; the chain is now 12
files and `main` is active (`020` today, more tomorrow). Since `node-pg-migrate`
files are timestamp-prefixed (lexical order already matches intended order),
disabling `checkOrder` breaks the cycle permanently — at the cost of losing
out-of-order *detection* (a genuinely misordered migration would no longer be
caught). One-line change, no file churn, no orphaned-rows risk. **Recommend the
release owner pick renumber (keeps the safety net, one-time cost) vs.
`checkOrder:false` (durable, drops the net) before deploy.**

> **Caveat — orphaned `pgmigrations` rows.** This is safe only for environments
> that have **not** already applied the old FS numbers. Any dev/QA DB that ran
> `012–023` will orphan those rows on rename and must be reset (or reconciled)
> before re-migrating. Manual-deploy discipline means prod has never run FS, so
> prod is clean; the constraint is on existing dev/QA databases — **do manual QA
> on a freshly migrated DB**, or do the renumber *before* QA so QA exercises the
> final numbers.

**This blocks the prod cutover, not manual QA** (a fresh DB still applies
`012–023` in order). Recommended sequencing: renumber → re-run the scratch-DB
prod-upgrade replay (apply `{000–005,007,011,020}`, then the renumbered FS set
with `--check-order` → expect clean apply; negative control injecting a sub-`020`
FS file → expect the original abort) → then QA on the renumbered chain.

### Prior findings — re-confirmed on the full epic

- **F1** — resolved as recorded; superseded by **F5** now that its forward-risk
  is live. The `012–019` renumber from 2026-06-11 remains correct for a fresh DB.
- **F2** — still fixed. `apps/api/src/routes/me.ts` still catches Postgres `42P01`
  from `getUserLeagues` and degrades to `leagues: []`; other errors propagate.
- **F3** — **still open, and sharper now.** `currentWeek()` in
  `apps/api/src/jobs/scheduler.ts:51` still hardcodes `return 1`. Items 06 *and*
  08 are now done — the multi-week schedule and the playoff bracket exist — yet
  the automated lineup-lock / weekly-settle / provisional crons still only ever
  drive **week 1**. Weeks ≥ 2 (and all playoff weeks) therefore do **not**
  auto-lock or auto-settle; they depend on the on-demand / commissioner manual
  path (item 12 admin tools). **Verified that path takes an arbitrary week:**
  `POST /leagues/:id/admin/rescore` (`rescoreWeek`, required `week`) settles a
  given week's matchups and can crown the champion; the lineup-override route
  (`week` + `lock`/`unlock`) covers the lock side; `POST /leagues/:id/admin/advance`
  (`forceAdvance`, `week`) drives bracket progression. This stays intentional MVP
  scope, documented in [06 → Follow-up](06-matchups-and-standings.md), but QA must
  know: **drive multi-week and playoff progression via those admin endpoints** —
  the scheduler will not advance the week. Not a regression; tracked.
- **F4** — still present. `nyseRegularCloseAnchor()` (DST-aware) anchors both
  settle endpoints at the regular-session close; `runWeeklyScoring` pre-captures
  rostered symbols. Unit test `test/market/holidays.test.ts` retained.

### Isolation re-check — items 08–12 (platform ↔ FS)

The new code holds the invariants established for 01–07:

- ✅ **Routes** — 08–12 add only `fs_*`-scoped handlers under `/api/v1/leagues/*`
  (+ FS admin); no platform route changed.
- ✅ **Schema** — new tables `fs_bot_member`, `fs_notification`, `fs_audit_log`
  are all `fs_*` prefixed; only FK reuse is `fs_league` / `app_user` (read-only
  for the latter).
- ✅ **Migration numbering** — the **new** items obeyed the discipline: `021–023`
  were placed *after* main's `020`. The breach is the *older* `012–019` that
  predate `020` — that is F5, not a new-code defect.
- ⚠️ **F2** — `/me` remains the one platform endpoint touching FS (degrades
  gracefully; unchanged).

### DoD note (08–12)

DoDs for 08–12 are satisfied per their own files/PRs and not re-checked here. The
only integration-level deviation surfaced is **F3** (cron week pinning) which now
visibly interacts with item 08's bracket-advance-on-settle: because settle is
cron-driven off `currentWeek() => 1`, playoff advance is reached via manual/
on-demand settle, not the automated Friday cron. Consistent with the documented
MVP scope; flagged so QA exercises the manual path.
