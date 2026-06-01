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
| G4 | Snapshot cadence | **Daily EOD** in v1; v2 introduces `season.snapshotIntervalSec` (default 300 s) | Matches the once-daily market data pull; ranking moves once a day |
| G5 | Leaderboard tie-breaking | **`RANK() OVER (ORDER BY equity DESC)`** for the rank value (equal equity → same rank); **separate top-level `ORDER BY equity DESC, portfolio_id ASC`** for display order. Putting `portfolio_id` inside the `OVER` clause makes every tuple distinct — ranks would never tie. | Deterministic and simple; revisit with risk-adjusted metric later |
| G6 | Stale prices | **Reject orders if latest `price_bar` is > 5 calendar days old** (`STALE_PRICE`) | Threshold survives a 3-day weekend + daily-update window; only fires on actually-stuck feeds (delistings, prolonged backfill failure) |
| G7 | Shorting / margin / limit orders | **Out of scope** (schema reserves room) | Keeps invariants simple; `CHECK (quantity >= 0)` enforces no shorts |
| G8 | Bots in v1 | **One built-in `index` buy-and-hold bot**, seeded once after the bootstrap backfill has marked **all** seeded `universe_symbol` rows `backfilled = true`. `N = COUNT(*) FROM universe_symbol WHERE backfilled = true`; places 1/N-budget market orders per symbol. | Full-universe seeding: the bot holds the full basket from day one. "At least one" trigger leaves the bot 100 % in one symbol; "per-symbol as each completes" spreads orders over hours. |
| G9 | Stale-bar policy on the valuation snapshot | **No staleness gate**: the EOD snapshot uses whatever the latest `price_bar.close` is for each held symbol. The admin ops endpoint surfaces daily-price-job success; an alert fires if the job fails. Stale valuations are a documented v1 limitation; the UI shows "as of <date>". | Quarantining stale symbols (nulling position value) would distort rankings in ways harder to explain than a stale close. |

## v1 data model ([02](02-data-model.md))

| # | Question | Decision |
|---|---|---|
| D1 | One portfolio per user | **Two partial indexes** on `portfolio`: `portfolio_one_human_per_user` (`(user_id) WHERE algo_id IS NULL`) and `portfolio_one_per_user_algo` (`(user_id, algo_id) WHERE algo_id IS NOT NULL`). A plain `UNIQUE (user_id, algo_id)` fails because Postgres treats `NULL ≠ NULL` — two `(U, NULL)` rows would both be allowed. v2 adds `season_id` and the same partial-index pattern applies with season scope. |
| D2 | Fractional-share precision | **`NUMERIC(20,8)`** — 8 decimal places is more than sufficient |
| D3 | `season_id` migration shape (v2 cutover) | **Add column nullable → backfill all existing rows to a "legacy" v2 season → set NOT NULL** | Open: confirm at v2 implementation time |
| D4 | Contract source-of-truth across a polyglot future | **OpenAPI + JSON** for public API; **`@tickr/shared-types` package** for internal boundaries |

## v1 API ([03](03-api.md))

| # | Question | Decision |
|---|---|---|
| A1 | Concrete rate-limit numbers | Define per-endpoint at implementation time; stricter on order routes; token-bucket counters in Redis |
| A2 | Contract format | Same as D4 (OpenAPI/JSON public; shared TS internal) |
| A3 | WS `leaderboard` topic shape across v1→v2 | v1 uses `{ kind: "leaderboard" }` (perpetual board). v2 adds `{ kind: "leaderboard"; seasonId }`. Whether the no-`seasonId` form is preserved as backward-compat or removed at the v2 cutover is **open** |
| A4 | CSRF token delivery | **`GET /me` returns `csrfToken: string`** in `MeResponse`. Client stores it in memory; all state-changing requests send it as `X-CSRF-Token`. The token is rotated per session. |
| A5 | WS `quotes` per-symbol fan-out | **Full-broadcast on `ws:quotes`**: after the daily price update, `quotes.updated` is published once with all ~500 updated symbols. Clients filter on receipt. The 100-symbol subscription cap stays as a validation guard; bandwidth is ~10 KB once daily — acceptable for v1's daily cadence. Per-symbol channels (`ws:quotes:<sym>`) are deferred to v2 when live streaming makes the cost meaningful. |
| A6 | Bot → order-API auth | **In-process call**: the bot runner invokes the trading-engine function directly (trusted module call) rather than going through the HTTP route. Full validation logic still runs; no session/CSRF check. The HTTP surface remains auth-gated for all external callers. Trusted-internal-caller exception to B3. |
| A7 | Bot `displayName` in `LeaderboardResponse` | **Join through `algo.name`** when `isBot = true`. The leaderboard query joins `portfolio → algo` for bot rows and uses `algo.name` ("index") as `displayName`. The system user's `display_name` stays `"system"` (ops/admin context only). |
| A8 | OAuth `state` browser binding | **Signed `tickr_oauth_attempt` cookie**: at `/start`, set a host-only, `SameSite=Lax`, HMAC-signed single-use cookie. At `/callback`, require the cookie to be present, valid (signature + TTL ≤ 10 min), and matching the `state`. Prevents login-CSRF (attacker-initiated flow completing in a victim's browser). Cookie cleared on callback or TTL expiry. |
| A9 | Fill-price phrasing | **"the most recent `price_bar.close` for the symbol"** everywhere. "Prior day's close" is inaccurate: on Monday morning the latest bar is Friday's; after 16:30 ET it is today's. `STALE_PRICE` is added to the rejection table in [04 §2.2](04-game-mechanics.md#22-rejections) (previously absent from that table). |

## All phases — auth ([05](05-auth.md))

| # | Question | Decision |
|---|---|---|
| AU1 | Duplicate-signup / account-merge policy | **Auto-link if verified emails match**; else create distinct account (admin merges on request) |
| AU2 | Absolute session lifetime + refresh | **Sliding expiry; 30-day absolute maximum** |
| AU3 | Admin bootstrap mechanism | **Env allowlist of provider subjects** (`ADMIN_BOOTSTRAP`) |
| AU4 | OAuth login-CSRF mitigation | **Signed `tickr_oauth_attempt` cookie** (see A8). Closes the classic login-CSRF hole where an attacker initiates the flow and a victim completes the callback in their own browser. |

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
| B3 | Intent rejection location (runner vs order API) | **Order API** — single source of truth for validation. Exception: the v1 `index` bot calls the trading engine **in-process** as a trusted internal caller (A6); full validation logic still runs, but no session/CSRF check. |
| B4 | Default risk caps for house bots (v2+) | **Max order 10% of equity; max position 25% of equity** |
| B5 | Cap on user algos per user/season (v3+) | **3 algos per user per season** (house bots exempt) |

## All phases — backend language ([01](01-architecture.md#3-language-strategy))

| # | Question | Decision |
|---|---|---|
| L1 | When to rewrite a hot path in Go | **Only after profiling shows need** — likely EOD snapshot loop (v1) or per-cycle bot runner (v2/v3) first |
| L2 | Keep 3 backend roles as one image or split | **One image, `ROLE` env var** initially; split only if independent deploy cadences require it |

## v1 deployment / market data ([08](08-deployment.md))

| # | Question | Decision |
|---|---|---|
| O1 | Market data provider + tier | **Two free tiers in v1**: Massive Free for bootstrap backfill (2 years of daily bars); Finnhub Free ($0/mo) for daily price updates (~500 calls/day). v2 evaluates Finnhub paid tier once the WebSocket symbol limit (≤50) becomes binding |
| O2 | Job-queue durability | **Re-enqueue on boot** using idempotency keys; no Redis persistence mode needed |
| O3 | Backup cadence/retention + restore drill | **Daily `pg_dump` to off-VPS storage; 7-day retention; quarterly restore drill** (`pg_dump` includes TimescaleDB hypertable data) |
| O4 | v1 market data usage shape | **REST-only, two providers**: Massive `GET /v2/aggs/ticker/{symbol}/range/1/day` for bootstrap backfill; Finnhub `GET /quote` for daily price update. **No WebSocket in v1** |
| O5 | Daily price source for "official close" | **Accept `q.c` from `GET /quote` as v1's documented approximation** of the close. The daily-update row is timestamped `16:00 ET`; `open/high/low` from `/quote` are real-time snapshots, not true OHLC, and are written as-is. Switching to `GET /stock/candle?resolution=D` is deferred to v2 if accuracy becomes a concern. |
| O6 | Schema coverage for Massive backfill endpoint | **Schema added** at `schema/massive.com/openapi.json` (Custom Bars endpoint). `npm run gen:massive` generates types; see TODO/13 for the integration steps. |

## All phases — timeseries & data architecture

| # | Question | Decision | Rationale |
|---|---|---|---|
| T1 | Timeseries DB choice | **TimescaleDB** (Postgres extension) | No new service on the VPS — same container, same `DATABASE_URL`, same `pg_dump` backup path. Hypertables + columnar compression handle OHLCV append workloads well. Alternatives considered: QuestDB (fast but another process + port, different query language), InfluxDB (separate service, Flux/InfluxQL instead of SQL), ClickHouse (excellent for analytics but heavy for a single-VPS game). TimescaleDB wins on operational simplicity for the single-VPS target. |
| T2 | v1 polling scope | **Full S&P 500** (bootstrap backfill of all 500; daily `/quote` for all 500) | v1 has no themes/watch list. Daily 500-call burst fits the 60 req/min free-tier bucket (~8.5 min). v2 narrows to watch-list-only when themes land. |
| T3 | Source of truth for in-game pricing | **TimescaleDB `price_bar`** — fills, snapshots, and bot context all read from here | Single source eliminates Redis-vs-Postgres divergence. Redis retains queue, rate-limit, session, and leaderboard-cache roles; it is not used for quote data. |
| T4 | v1 backfill strategy | **Bootstrap backfill at install** — Massive `GET /v2/aggs/ticker/{symbol}/range/1/day` for 2 years of daily bars per `universe_symbol` | Loads ~252 K rows up front (one-time cost) so v1 doesn't need lazy/triggered backfill machinery. v2's theme-driven watch list reuses the same job, just triggered by theme membership instead of bootstrap. |
| T5 | No-trade-until-backfill gate | **Symbol not tradeable until `universe_symbol.backfilled = true`** | Prevents orders from filling against a symbol with incomplete price history, which would break snapshot and backtest reproducibility. |
| T6 | `universe_symbol` population | **Admin-managed (manual upsert)** in v1; periodic check job deferred | Keeps v1 simple. S&P 500 composition changes infrequently (~30–50 changes/year); admin can act on rebalance announcements without an automated feed. |

## Open market data questions

| # | Open question | Notes |
|---|---|---|
| T2b | Finnhub historical bar depth and per-call response window | **Resolved 2026-05-31.** `GET /stock/candle` returns HTTP 403 for all resolutions on the free tier (premium-gated). `GET /quote` is free and confirmed working. **Decision: use Massive for backfill (TODO/13); daily price stays on Finnhub `/quote`.** |
| T2c | Massive free-tier rate limit and pagination behavior | **Open.** Run `scripts/probe-massive-candles.ts` (TODO/13 step 4) to determine req/min or req/day cap and whether responses paginate via `next_url`. Pin findings here before setting `MASSIVE_RPS_LIMIT`. |
| F1 | Commercial licensing — do the free tiers of Massive and Finnhub permit a public game? | Both providers' ToS must be reviewed before launch. "Commercial use" may require paid plans. Verify with each provider's support or legal terms. |
| F2 | Finnhub WebSocket symbol limit per plan (v2 concern) | Free tier: 50 simultaneous symbols. v2 themes are typically ≤50, so free tier should still fit; confirm at v2 implementation. |
| F3 | Finnhub REST rate limit under combined load (v2 concern) | At 60 req/min, simultaneous REST fallback + theme-triggered backfill could saturate the bucket. Backfill should run at reduced rate or off-peak. Not a v1 concern (REST is daily-burst only). |

## Open design questions (from review)

All items from the initial design review have been resolved and recorded in
the decision tables above (D1, G5, G8–G9, O5–O6, A4–A9, AU4). Source docs
updated accordingly. No open items remain in this section.
