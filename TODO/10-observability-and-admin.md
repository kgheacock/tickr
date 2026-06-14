# 10 — Observability + admin

> **Status:** [done](https://github.com/kgheacock/tickr/pull/36) • **Depends on:** 04, 16

## Goal

Structured JSON logs, a small in-process metric set, and an admin ops
endpoint that surfaces platform health at a glance, plus per-route rate
limiting on the surviving admin endpoints.

> **Re-scoped for the platform pivot (item 16).** This item was originally
> written for the trading-game architecture (snapshots, leaderboard, orders,
> bots, a Finnhub provider, and an Express-style middleware stack). Item 16
> dropped the game surface and item 19/cleanup removed Finnhub + Kaggle, and
> the service is Fastify with **two separate processes** (`ROLE=api` and
> `ROLE=worker`). The aims below are the surviving observability/admin core,
> re-targeted at what actually exists:
>
> - **No snapshots/leaderboard.** The closest health signal is the daily EOD
>   price-update cron (`jobs/intraday-update.ts`, the `0 30 21 * * 1-5`
>   firing). "Snapshot lag" becomes **EOD-update lag**.
> - **No Finnhub.** Massive is the only external market-data provider.
> - **No orders/portfolios.** The per-user order rate cap is gone; rate
>   limiting is per-IP global + per-route caps on the auth and admin surface.
> - **api and worker are separate processes.** An in-process metric registry
>   in the api process cannot see worker-produced numbers (Massive calls/429s,
>   EOD run, backfill). Those cross-process metrics live in **Redis**; the
>   in-process registry is only for the api process's own HTTP counters.
> - **Rate limiting already exists** via `@fastify/rate-limit` (global +
>   per-route `config.rateLimit`). This item *tunes* it rather than building a
>   parallel Lua sliding-window limiter.

## Pre-reads

- [docs/08-deployment.md §6](../docs/08-deployment.md#6-observability)
  — v1 metric list + admin ops view.
- [docs/03-api.md §6, §8](../docs/03-api.md#6-admin-v1) — admin endpoints
  + rate-limiting policy.
- [docs/01-architecture.md §4](../docs/01-architecture.md#4-cross-cutting-concerns-v1)
  — cross-cutting concerns table.
- `apps/api/src/roles/api.ts`, `roles/worker.ts`, `index.ts` — the
  api/worker split this item instruments.
- `apps/api/src/massive/client.ts`, `jobs/scheduler.ts`,
  `jobs/intraday-update.ts`, `jobs/backfill.ts` — the worker metric sources.

## Steps

1. **Structured logging.** A shared `pino` factory. Required fields on every
   line: `level`, `time`, `msg`, plus `request_id` (HTTP) or `job_id`
   (worker). The Fastify server uses the pino instance with a `genReqId` that
   stamps a UUID `request_id` onto `req.log`. Worker components
   (`scheduler`, `backfill`, `intraday-update`, `massive`, `alerts`) replace
   their ad-hoc `console.log(JSON.stringify(...))` calls with a `job_id`-keyed
   child logger. Redact the real leak paths via `pino.redact`:
   `req.headers.authorization`, `req.headers.cookie`, and
   `res.headers["set-cookie"]`. (The Massive client already keeps
   `MASSIVE_API_KEY` out of log fields — keep it that way.)
2. **Request logging.** Generate a `request_id` (UUID) per request; Fastify
   attaches it to `req.log`. Method/url/status/`responseTime` are logged on
   response by Fastify's default request logging. Body logging stays off
   unless `LOG_LEVEL=debug`.
3. **Metrics registry.** A tiny in-process registry — `Map<string, number>`
   for counters + gauges and a last-N circular buffer for durations
   (p50/p95). Lives in the api process. Increment sites:
   - `http_requests_total{route,status}` — counter in an `onResponse` hook.
   - `http_request_duration_ms{route}` — circular buffer for p50/p95.
4. **Cross-process metrics (Redis).** Numbers produced in the worker but read
   by the api process's `/admin/ops`:
   - `massive_429` — a Redis ZSET of 429 event timestamps (incremented in the
     Massive client). 24h window for ops; 5m window for the alerter.
   - `massive_calls_total` — lifetime counter (Massive client).
   - EOD run state — `metrics:eod:last_run_at`, `metrics:eod:duration_ms`,
     `metrics:eod:bars_written` set by the EOD update job.
   - `backfill_remaining` — derived on read from
     `SELECT count(*) FROM universe_symbol WHERE backfilled = false`.
   - `job_queue_depth` — count of currently-held job locks
     (`massive:job:backfill`, `massive:job:session-update`).
5. **`GET /admin/ops`.** Admin-only. Returns `OpsResponse`:
   ```ts
   interface OpsResponse {
     lastEodUpdateAt: string | null;   // last successful EOD price-update run
     eodUpdateLagSec: number | null;   // now - lastEodUpdateAt
     marketData429sLast24h: { massive: number };
     jobQueueDepth: number;            // held job locks
     backfillRemaining: number;        // universe_symbol where backfilled=false
   }
   ```
   Reads the Redis cross-process metrics (step 4) + the DB count. Gated by the
   existing `requireAdmin` check (player → 403).
6. **Rate limiting (tune, don't rebuild).** Keep `@fastify/rate-limit`. Back
   it with Redis so limits hold across api instances. Tune to the spec intent:
   - Default per-IP cap: 60 req/min (global).
   - Auth `start` routes: 10 req/min.
   - Admin routes (`/admin/*`): explicit `config.rateLimit`.
   429 responses carry `Retry-After` (the plugin sets this).
7. **`/admin/universe/*`** — already implemented (item 06/16). This item wires
   the per-route rate limiting around them; the admin role check already
   exists.
8. **Alerts (optional v1).** A worker tick (every 5 min) checks:
   - `eodUpdateLagSec > 26 * 3600` → alert (missed the daily run).
   - `backfillRemaining > 0` and unchanged for 1 h → alert.
   - Massive 429s in the last 5 min `> 0` → alert.
   POSTs to a Discord webhook (`ALERT_WEBHOOK_URL`) if set; otherwise logs at
   `warn`. Fires **once per stuck-state window** (a Redis flag per alert key,
   cleared when the condition resolves).
9. **Tests.**
   - Hitting a route updates `http_requests_total` and
     `http_request_duration_ms`.
   - Logger redaction: `authorization`/`cookie`/`set-cookie` never appear in
     a serialized log line.
   - `GET /admin/ops` requires admin role; a player gets 403; an admin gets
     the `OpsResponse` shape.
   - With a faked clock pushing `lastEodUpdateAt` 27 h into the past, the
     alerter triggers exactly once per check window.

## Files to create

- `apps/api/src/log/logger.ts`
- `apps/api/src/metrics/registry.ts`
- `apps/api/src/metrics/middleware.ts`
- `apps/api/src/metrics/redis.ts` (cross-process counters)
- `apps/api/src/routes/admin/ops.ts`
- `apps/api/src/alerts/checker.ts`
- `apps/api/test/observability/*.test.ts`
- `apps/api/test/ratelimit/*.test.ts`

## Definition of done

- [x] Every log line includes `request_id` or `job_id`; `authorization`,
      `cookie`, and `set-cookie` are redacted; `MASSIVE_API_KEY` never appears
      in stdout (logger redaction test).
- [x] `GET /admin/ops` (admin) returns realistic numbers
      (`lastEodUpdateAt`, `backfillRemaining`, `marketData429sLast24h`,
      `jobQueueDepth`).
- [x] Player calling `/admin/ops` → 403.
- [x] Per-IP rate limiting is Redis-backed; auth-start and admin routes carry
      explicit per-route caps; 429s include `Retry-After`. (Keyed per *real*
      client IP only after the proxy fix below — see Follow-on.)
- [x] Alerter logs (or sends) exactly one alert per stuck-state window.

## Follow-on: trust the proxy hop so rate limiting is actually per-IP ([#85](https://github.com/kgheacock/tickr/pull/85))

The rate limiter above was registered without `trustProxy`, so behind Caddy
(the sole ingress) every request appeared to come from Caddy's container IP
(`172.18.0.7` in prod logs). That collapsed the "per-IP" 60/min bucket into a
single **global** bucket — one scanner could exhaust the budget for all real
users — and hid true client IPs from request logs. PR #85 sets `trustProxy: 1`
on the Fastify instance: exactly one `X-Forwarded-For` hop (Caddy) is trusted,
restoring real client IPs in logs and genuine per-client rate limiting. A fixed
hop count (not `true`) avoids honoring spoofed `X-Forwarded-For` if the api port
is ever exposed directly. Surfaced by `.env`/config probe traffic in prod logs.
