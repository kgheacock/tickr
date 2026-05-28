# 10 — Observability + admin

> **Status:** pending • **Depends on:** 04, 06, 08

## Goal

Structured JSON logs, an in-process metric set, an admin ops endpoint
that surfaces health at a glance, per-route rate limiting, and the
remaining admin endpoints (`/admin/universe/*`).

## Pre-reads

- [docs/08-deployment.md §6](../docs/08-deployment.md#6-observability)
  — v1 metric list + admin ops view.
- [docs/03-api.md §6, §8](../docs/03-api.md#6-admin-v1) — admin endpoints
  + rate-limiting policy.
- [docs/01-architecture.md §4](../docs/01-architecture.md#4-cross-cutting-concerns-v1)
  — cross-cutting concerns table.

## Steps

1. **Structured logging.** Use `pino` with a child logger per request and
   per job. Required fields on every line: `level`, `ts`, `msg`, plus
   `request_id` (HTTP) or `job_id` (worker). Redact `FINNHUB_API_KEY`,
   OAuth secrets, and the session cookie via `pino.redact`.
2. **Request middleware.** Generate a `request_id` (UUID) per request;
   attach to `req.log`. Log `req.method`, `req.url`, status, and
   `duration_ms` on response. Skip body logging by default; gate behind
   `LOG_LEVEL=debug`.
3. **Metrics registry.** A tiny in-process registry — `Map<string,
   number>` for counters + gauges. No Prometheus client in v1. Increment
   sites:
   - `http_requests_total{route,status}` — counter in the request
     middleware.
   - `http_request_duration_ms{route}` — last-N circular buffer for p50/p95.
   - `finnhub_calls_total`, `finnhub_429_total` — in the Finnhub client
     (item 05).
   - `backfill_remaining` — gauge updated by the backfill job (item 06).
   - `daily_price_last_run_at`, `daily_price_duration_ms` — set by the
     daily-price job (item 06).
   - `snapshot_last_run_at`, `snapshot_duration_ms`,
     `snapshot_lag_seconds` — set/computed by the snapshot job (item 08).
   - `redis_queue_depth` — gauge polled every 30 s.
   - `finnhub_bucket_remaining` — gauge polled every 5 s.
4. **`GET /admin/ops`.** Returns `OpsResponse` from
   [docs/03-api.md §6](../docs/03-api.md#6-admin-v1):
   ```ts
   {
     lastSnapshotAt: string | null;
     snapshotLagSec: number | null;
     finnhubRest429sLast24h: number;
     jobQueueDepth: number;
     backfillRemaining: number;
   }
   ```
   Reads from the metrics registry + a 24-hour rolling counter in Redis
   for `finnhub_429_total`.
5. **Rate limiting.** Redis-backed sliding-window counters via a Lua
   script. Wire as middleware:
   - Default per-IP cap: 60 req/min on all routes.
   - Per-user cap on `POST /portfolios/:id/orders`: 30 req/min.
   - Per-user cap on auth `start` routes: 10 req/min.
   429 responses include `Retry-After`. Counts on the metrics registry.
6. **`POST /admin/universe/upsert`** and `POST /admin/universe/backfill`
   — already specified in item 06; this item wires the admin role check
   middleware and rate limiting around them.
7. **Email/Discord alerts (optional v1).** A tiny worker tick (every
   5 min) checks:
   - `snapshot_lag_seconds > 26 * 3600` → alert.
   - `backfill_remaining > 0` and unchanged for 1 h → alert.
   - `finnhub_429_total in last 5m > 0` → alert.
   POSTs to a Discord webhook (`ALERT_WEBHOOK_URL`) if set; otherwise
   logs at `warn`.
8. **Tests.**
   - Hitting a route updates `http_requests_total` and
     `http_request_duration_ms`.
   - The 31st `POST /orders` in a minute by one user returns 429 with
     `Retry-After`.
   - `GET /admin/ops` requires admin role; player gets 403.
   - With a faked clock pushing `lastSnapshotAt` 27 h into the past, the
     alerter triggers exactly once per check window.

## Files to create

- `apps/api/src/log/logger.ts`
- `apps/api/src/log/middleware.ts`
- `apps/api/src/metrics/registry.ts`
- `apps/api/src/metrics/middleware.ts`
- `apps/api/src/ratelimit/limiter.ts` (Lua script + helper)
- `apps/api/src/routes/admin/ops.ts`
- `apps/api/src/alerts/checker.ts`
- `apps/api/test/observability/*.test.ts`
- `apps/api/test/ratelimit/*.test.ts`

## Definition of done

- [ ] Every log line includes `request_id` or `job_id`; `FINNHUB_API_KEY`
      never appears in stdout (grep verifies after a full flow).
- [ ] `GET /admin/ops` (admin) returns realistic numbers after one full
      daily cycle has run.
- [ ] Player calling `/admin/ops` → 403.
- [ ] Order spam from one user is throttled to ≤30/min; other users
      unaffected.
- [ ] Alerter logs (or sends) exactly one alert per stuck-state window.
