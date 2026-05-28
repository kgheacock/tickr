# 09 — Decisions Record

Record of decisions made and their rationale. Each item links back to its
source doc where the decision is applied. Items split by **phase scope**:

- **v1** — applies to the perpetual-leaderboard phase shipping first.
- **v2+** — applies to the seasons + themes + bot-registry phase.
- **v3+** — applies to user-authored algos.
- **All phases** — phase-agnostic infrastructure/policy.

## Phasing

| # | Question | Decision | Rationale |
|---|---|---|---|
| P1 | How is the work staged? | **Three additive phases**: v1 perpetual leaderboard; v2 seasons + themes + bot registry; v3 user algos | Each phase is shippable on its own; phase boundaries are additive (no schema rewrites) |
| P2 | What does v1 ship? | Single perpetual leaderboard, one portfolio per user, full S&P 500 tradeable, market orders, daily EOD snapshots, one built-in `index` buy-and-hold bot | Smallest surface that's still a "game"; the bot gives a baseline so the leaderboard isn't empty |
| P3 | What enters v2? | Seasons (lifecycle, bounded windows), themes (constrained universe), bot registry (the 6 strategy types in [07](07-bots-and-algos.md)) | Adds the gameplay variety described in [00](00-overview.md) and [07](07-bots-and-algos.md) |
| P4 | What enters v3? | User-authored algos using registered v2 strategy types, capped per user/season | Sandboxing arbitrary code is the deferred-indefinitely item |
| P5 | How do "kept" docs (00/06/07) line up with phases? | 00 leads with phase framing; 06 and 07 are tagged as "v2+ design" and their season-scoped routes / bot registry are explicitly v2+ | Preserves the design vocabulary already in those docs without forcing a v1 retrofit |

## v1 game mechanics ([04](04-game-mechanics.md))

| # | Question | Decision | Rationale |
|---|---|---|---|
| G1 | Game window | **Perpetual** in v1; bounded seasons arrive in v2 (default 30 days) | Drops the season lifecycle from the v1 surface area |
| G2 | Trading window | **24/7; fill at latest `price_bar.close`** | Simplest UX; fairness preserved (everyone within a day fills at the same close) |
| G3 | Fees / commissions | **Zero in v1**; `season.commissionCents` reserved for v2+ | Legible results; can add later without re-architecting |
| G4 | Snapshot cadence | **Daily EOD** in v1; v2 introduces `season.snapshotIntervalSec` (default 300 s) | Matches the once-daily Finnhub REST pull; ranking moves once a day |
| G5 | Leaderboard tie-breaking | **Shared rank; stable secondary sort by `portfolioId`** | Deterministic and simple; revisit with risk-adjusted metric later |
| G6 | Stale prices | **Reject orders if latest `price_bar` is > 5 calendar days old** (`STALE_PRICE`) | Threshold survives a 3-day weekend + daily-update window; only fires on actually-stuck feeds (delistings, prolonged backfill failure) |
| G7 | Shorting / margin / limit orders | **Out of scope** (schema reserves room) | Keeps invariants simple; `CHECK (quantity >= 0)` enforces no shorts |
| G8 | Bots in v1 | **One built-in `index` buy-and-hold bot**, seeded at install | Populates the leaderboard from day one; expands to registry in v2 |

## v1 data model ([02](02-data-model.md))

| # | Question | Decision |
|---|---|---|
| D1 | One portfolio per user | **`UNIQUE (user_id, algo_id)`** in v1; v2 adds `season_id` and uniqueness becomes `(season_id, user_id, algo_id)` |
| D2 | Fractional-share precision | **`NUMERIC(20,8)`** — 8 decimal places is more than sufficient |
| D3 | `season_id` migration shape (v2 cutover) | **Add column nullable → backfill all existing rows to a "legacy" v2 season → set NOT NULL** | Open: confirm at v2 implementation time |
| D4 | Contract source-of-truth across a polyglot future | **OpenAPI + JSON** for public API; **`@tickr/shared-types` package** for internal boundaries |

## v1 API ([03](03-api.md))

| # | Question | Decision |
|---|---|---|
| A1 | Concrete rate-limit numbers | Define per-endpoint at implementation time; stricter on order routes; token-bucket counters in Redis |
| A2 | Contract format | Same as D4 (OpenAPI/JSON public; shared TS internal) |
| A3 | WS `leaderboard` topic shape across v1→v2 | v1 uses `{ kind: "leaderboard" }` (perpetual board). v2 adds `{ kind: "leaderboard"; seasonId }`. Whether the no-`seasonId` form is preserved as backward-compat or removed at the v2 cutover is **open** |

## All phases — auth ([05](05-auth.md))

| # | Question | Decision |
|---|---|---|
| AU1 | Duplicate-signup / account-merge policy | **Auto-link if verified emails match**; else create distinct account (admin merges on request) |
| AU2 | Absolute session lifetime + refresh | **Sliding expiry; 30-day absolute maximum** |
| AU3 | Admin bootstrap mechanism | **Env allowlist of provider subjects** (`ADMIN_BOOTSTRAP`) |

## All phases — frontend ([06](06-frontend.md))

| # | Question | Decision |
|---|---|---|
| F1 | Styling approach | **CSS Modules** — scoped, no runtime, matches workspace convention |
| F2 | Charting library | **Lightweight Charts** (TradingView) — purpose-built for financial time-series |
| F3 | Component library vs. hand-roll | **Hand-roll early**; reach for Semantic UI React only if a library becomes necessary |
| F4 | v1 routes vs v2+ routes | **v1 ships `/`, `/login`, `/portfolio`, `/leaderboard`.** Season-scoped routes (`/seasons/*`, per-season leaderboard) arrive in v2 |

## v2+ — bots & algos ([07](07-bots-and-algos.md))

| # | Question | Decision |
|---|---|---|
| B1 | v1 bot lineup | **Just `index` (buy_and_hold of an equal-weighted S&P 500 basket)**; the 6-type registry lands in v2 |
| B2 | Allow arbitrary user code? | **Deferred indefinitely**; if pursued: sandboxed WASM/isolate or inbound webhook |
| B3 | Intent rejection location (runner vs order API) | **Order API** — single source of truth for validation |
| B4 | Default risk caps for house bots (v2+) | **Max order 10% of equity; max position 25% of equity** |
| B5 | Cap on user algos per user/season (v3+) | **3 algos per user per season** (house bots exempt) |

## All phases — backend language ([01](01-architecture.md#3-language-strategy))

| # | Question | Decision |
|---|---|---|
| L1 | When to rewrite a hot path in Go | **Only after profiling shows need** — likely EOD snapshot loop (v1) or per-cycle bot runner (v2/v3) first |
| L2 | Keep 3 backend roles as one image or split | **One image, `ROLE` env var** initially; split only if independent deploy cadences require it |

## v1 deployment / Finnhub ([08](08-deployment.md))

| # | Question | Decision |
|---|---|---|
| O1 | Market data provider + tier | **Finnhub Free ($0/mo)** sufficient in v1 (REST-only, ~500 calls/day + one-time backfill). v2 evaluates the paid tier once the WebSocket symbol limit (≤50) becomes binding |
| O2 | Job-queue durability | **Re-enqueue on boot** using idempotency keys; no Redis persistence mode needed |
| O3 | Backup cadence/retention + restore drill | **Daily `pg_dump` to off-VPS storage; 7-day retention; quarterly restore drill** (`pg_dump` includes TimescaleDB hypertable data) |
| O4 | v1 Finnhub usage shape | **REST-only**: `GET /stock/candle` for bootstrap backfill, `GET /quote` for daily price update. **No WebSocket in v1** |

## All phases — timeseries & data architecture

| # | Question | Decision | Rationale |
|---|---|---|---|
| T1 | Timeseries DB choice | **TimescaleDB** (Postgres extension) | No new service on the VPS — same container, same `DATABASE_URL`, same `pg_dump` backup path. Hypertables + columnar compression handle OHLCV append workloads well. Alternatives considered: QuestDB (fast but another process + port, different query language), InfluxDB (separate service, Flux/InfluxQL instead of SQL), ClickHouse (excellent for analytics but heavy for a single-VPS game). TimescaleDB wins on operational simplicity for the single-VPS target. |
| T2 | v1 polling scope | **Full S&P 500** (bootstrap backfill of all 500; daily `/quote` for all 500) | v1 has no themes/watch list. Daily 500-call burst fits the 60 req/min free-tier bucket (~8.5 min). v2 narrows to watch-list-only when themes land. |
| T3 | Source of truth for in-game pricing | **TimescaleDB `price_bar`** — fills, snapshots, and bot context all read from here | Single source eliminates Redis-vs-Postgres divergence. Redis retains queue, rate-limit, session, and leaderboard-cache roles; it is not used for quote data. |
| T4 | v1 backfill strategy | **Bootstrap backfill at install** — `GET /stock/candle?resolution=5` for 5 years of 5-min bars per `universe_symbol` | Loads ~49 M rows up front (one-time cost) so v1 doesn't need lazy/triggered backfill machinery. v2's theme-driven watch list reuses the same job, just triggered by theme membership instead of bootstrap. |
| T5 | No-trade-until-backfill gate | **Symbol not tradeable until `universe_symbol.backfilled = true`** | Prevents orders from filling against a symbol with incomplete price history, which would break snapshot and backtest reproducibility. |
| T6 | `universe_symbol` population | **Admin-managed (manual upsert)** in v1; periodic check job deferred | Keeps v1 simple. S&P 500 composition changes infrequently (~30–50 changes/year); admin can act on rebalance announcements without an automated feed. |

## Open Finnhub questions

| # | Open question | Notes |
|---|---|---|
| T2b | Finnhub historical bar depth and per-call response window | Need to verify: (1) how many years of 5-min OHLCV history `GET /stock/candle?resolution=5` returns per call; (2) whether it paginates or returns all bars in one call per time range; (3) free-tier restrictions on historical depth. Open since the provider switch from Alpaca. |
| F1 | Commercial licensing — does Finnhub's free tier permit a public game? | Free tier ToS must be reviewed before launch. "Commercial use" may require a paid plan regardless of symbol count or call volume. Verify with Finnhub support or legal terms. |
| F2 | WebSocket symbol limit per plan (v2 concern) | Free tier: 50 simultaneous symbols. v2 themes are typically ≤50, so free tier should still fit; confirm at v2 implementation. |
| F3 | REST rate limit under combined load (v2 concern) | At 60 req/min, simultaneous REST fallback + theme-triggered backfill could saturate the bucket. Backfill should run at reduced rate or off-peak. Not a v1 concern (REST is daily-burst only). |

## Open design questions (from review)

Contradictions and gaps surfaced by reviewing the design set against the
v1 implementation playbooks in [`TODO/`](../TODO/). Each needs a decision
before or during implementation; once resolved, the answer either amends
an existing row above or moves into the source doc directly.

| # | Open question | Notes |
|---|---|---|
| D1b | Portfolio uniqueness — reconcile D1 with [02 §2.3](02-data-model.md#23-portfolio) | D1 states `UNIQUE (user_id, algo_id)` and [04 §5](04-game-mechanics.md#5-anti-abuse) repeats it, but 02 §2.3 explicitly warns this fails for human portfolios because Postgres treats `NULL ≠ NULL` — it uses two partial indexes instead (`portfolio_one_human_per_user` + `portfolio_one_per_user_algo`). **Decide:** amend D1 + 04 §5 to reference the partial indexes (preferred), or move to `UNIQUE NULLS NOT DISTINCT (user_id, algo_id)` on PG 15+. |
| G5b | RANK SQL form for shared-rank ties | G5 says ties share a rank, but [`TODO/08` §2](../TODO/08-snapshots-and-leaderboard.md) line 63 writes `RANK() OVER (ORDER BY equity DESC, portfolio_id ASC)` — including `portfolio_id` inside the OVER clause makes every tuple distinct, so ranks are never shared. **Decide:** `RANK() OVER (ORDER BY equity DESC)` for the rank value, with a separate top-level `ORDER BY equity DESC, portfolio_id` for display order. |
| G8b | Index-bot seeding trigger | Three docs give three triggers: [04 §1.2](04-game-mechanics.md#12-the-index-bot) says "after the backfill job has marked **at least one** symbol `backfilled = true`" (with N orders sized to 1/N); [`TODO/07` step 7](../TODO/07-trading-engine.md) says "after a Redis lock + `backfill complete` check"; [08 §5](08-deployment.md#5-scheduled--background-jobs) says "500 market buys". The first reading leaves the bot 100 % in one symbol forever if N=1; the second leaves the leaderboard empty for hours. **Decide:** one trigger (most likely "after full backfill of the seeded universe") and reconcile all three docs. |
| G9 | Stale-bar policy on the valuation snapshot | G6 rejects ORDERS when the latest `price_bar` is > 5 days old, but the EOD snapshot silently uses whatever the latest bar is — so a failed daily-price update (Finnhub 429, network blip) values every holder against yesterday's close with no error. **Decide:** does the snapshot also apply a staleness gate (quarantine the symbol / fall back to NULL), or is a stale valuation acceptable as a documented limitation? |
| O5 | Daily-update price source for "official close" | [`TODO/06` step 3](../TODO/06-backfill-and-daily-price.md) writes `q.c` from `/quote` as today's `price_bar.close`, but `q.c` is Finnhub's current/delayed price — not the 4 PM official close. On early-close days (Black Friday, July 3) and after-hours prints it diverges meaningfully. **Decide:** switch the daily update to `GET /stock/candle?resolution=D&from=today&to=today` for an actual daily bar, or accept `q.c` as v1's documented approximation (and remove `open/high/low/volume` from the daily-update row since they're not real OHLC). |
| O6 | Swagger coverage for `/stock/candle` | `schema/finhub.io/swagger.json` contains only `/quote`; the trimmed commit dropped `/stock/candle` even though bootstrap backfill depends on it. **Decide:** add `/stock/candle` and its response schema to the bundled swagger so `openapi-typescript` codegen covers it, or hand-type the candle path and accept a second source-of-truth (with a lint rule forbidding direct `axios` calls outside `client.ts`). |
| A4 | CSRF token delivery to the client | [`TODO/04` step 10](../TODO/04-auth.md) and [`TODO/11` step 3](../TODO/11-frontend.md) read `csrfToken` from `GET /me`, but [03 §2](03-api.md#2-auth--session) `MeResponse` does not include it. **Decide:** add `csrfToken: string` to `MeResponse` (preferred — keeps a single auth-state endpoint), or expose via a dedicated `/csrf` endpoint, or set as a non-HttpOnly companion cookie the client reads. |
| A5 | WS `quotes` per-symbol fan-out | The `quotes` topic accepts a per-connection `symbols: string[]` (cap 100), but [`TODO/09` step 4](../TODO/09-websocket-gateway.md) publishes once on a single channel `ws:quotes` with no symbol scoping. Clients subscribed to a small set would receive the full ~500-symbol daily payload. **Decide:** publish per-symbol channels (`ws:quotes:<sym>`) and have connections subscribe to their own symbols, or accept full-fanout broadcasts and have clients filter on receipt (document the bandwidth cost). |
| A6 | Bot → order-API authentication | [`TODO/07` step 7](../TODO/07-trading-engine.md) has the bot role `POST /portfolios/<bot>/orders`, but those routes require `auth: player` (cookie/session) and CSRF; the bot has no SSO identity. **Decide:** add a service-token / signed-internal-request auth path for trusted roles, or have the bot call the trading engine in-process (relaxing B3 "order API as single source of truth" for trusted internal callers). |
| A7 | Bot `displayName` source in `LeaderboardResponse` | [03 §4](03-api.md#4-leaderboard) `LeaderboardResponse` comments `displayName` as `"index"` for the bot row, but [`TODO/04` step 9](../TODO/04-auth.md) seeds the owning system user with `display_name='system'`. The string "index" lives on `algo.name`. **Decide:** rename the system user's `display_name` to "index", or change the leaderboard query to join through `algo.name` when `isBot=true`. |
| A8 | OAuth `state` binding to browser session | [`TODO/04` §2](../TODO/04-auth.md) + [05 §6](05-auth.md#6-csrf--state-token) store `state` server-side keyed only by `state`. Nothing binds the state to the initiating browser, leaving the classic OAuth login-CSRF (attacker initiates the flow, victim completes the callback in their own browser and is logged in as the attacker) unmitigated by `state` alone. **Decide:** set a single-use `tickr_oauth_attempt` cookie at `/start` (host-only, `SameSite=Lax`, signed) and require it to match at `/callback`, or accept the residual risk and add monitoring. |
| A9 | Fill-price phrasing across docs | [03 §3](03-api.md#3-portfolio--trading) line 115 says "intraday orders fill at the **prior day's close**", and the same phrase appears in [01 §2](01-architecture.md) and [04 §2.1](04-game-mechanics.md#21-fills). After 16:30 ET the latest `price_bar.close` is *today's*, and Monday morning it's *Friday's* (3 days back), not "the prior day". **Decide:** replace with "the most recent `price_bar.close` for the symbol" (and amend §2.2 of 04 to include `STALE_PRICE` in the rejection table — currently absent). |
