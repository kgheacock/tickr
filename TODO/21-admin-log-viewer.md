# 21 — Admin log viewer (web)

> **Status:** [done](https://github.com/kgheacock/tickr/pull/43) • **Depends on:** 04, 10, 12
>
> Retroactive record of work already implemented. tickr is in production; this
> item adds an **admin-only, web-accessible, text-only viewer** for the
> structured logs that item 10 introduced.

## Goal

Give an admin a live window onto the platform logs from a browser — no SSH,
no `docker logs` — rendered as a terminal: colored monospace text on a black
background, white by default, tinted by level.

## Context / constraints

- **Three processes, three containers.** `ROLE=api`, `ROLE=worker`, and `bot`
  run as separate containers (see `compose/docker-compose.yml`). pino writes
  to stdout, captured per-container by Docker — there is no shared log file. An
  in-process ring buffer in the api process would therefore only ever show api
  lines and **miss the worker jobs** (backfill, daily EOD price update) that do
  the real background work.
- **Decision: a capped Redis Stream.** Every process fans its pino output into
  one Redis Stream (`logs:stream`, `MAXLEN ~ 5000`), which the api process's
  admin route reads back. This mirrors the existing cross-process metrics
  pattern from item 10 (`metrics/redis.ts`) and survives process restarts.
- **The fanout must never degrade logging itself.** "Now in production" means a
  bug in the Redis path could break the very observability it adds. The Redis
  write runs alongside stdout (Docker capture is untouched) and is strictly
  fire-and-forget: it never blocks pino, never throws, and swallows errors so a
  Redis outage degrades only the viewer.
- **Redaction is inherited, not re-implemented.** pino applies `redact` upstream
  of the destination, so `authorization` / `cookie` / `set-cookie` are
  `[REDACTED]` before a line ever reaches Redis. This matters more now: logs
  now persist (~5000 lines) and are served over HTTPS to admin sessions.

## Steps (as built)

1. **Redis log buffer** (`log/buffer.ts`). A `RedisLogStream` (Writable) mirrors
   each pino line into the capped stream via `appendRawLog` (fire-and-forget).
   `buildLogDestination()` returns a `pino.multistream` of `process.stdout` +
   the Redis stream. `readRecentLogs` / `readLogsAfter` read it back (newest N,
   or entries after a stream id, for tailing).
2. **Wire the destination in** (`log/logger.ts`, `roles/api.ts`). `rootLogger`
   (worker/bot) and the Fastify request logger (api) both write through the
   shared destination. Added a `service` base binding (`api`/`worker`/`bot`) so
   the viewer can tell the three containers apart.
3. **Admin routes** (`routes/admin/logs.ts`), both `requireAdmin`-gated and
   pinned to `logLevel: 'warn'` so the viewer's own 2s polling does not flood
   the stream it displays:
   - `GET /admin/logs` — a self-contained terminal-style HTML page (black
     background, white monospace default, level-colored; inline CSS/JS — the
     prod Caddyfile sets no CSP). Polls the JSON endpoint every 2s and tails by
     stream id; `level` filter, follow toggle, clear.
   - `GET /admin/logs.json` — recent entries, or those after `?after=<id>`;
     `?limit=` (1..1000) and `?level=` minimum-severity filter. Per-route rate
     limit 120/min (covers 30 polls/min comfortably).
4. **Tests** (`test/observability/logs.test.ts`).

> Use of OpenAPI/shared-types was intentionally avoided: the JSON endpoint is
> consumed only by the page's own inline JS (not the SPA client), so the
> response type is local to the route — no `openapi.gen.ts` regen.

## Entry point

`https://tickr.keithheacock.com/api/v1/admin/logs` — requires an existing
**admin** session cookie. Non-admin / unauthenticated callers get the
`403` / `401` JSON (there is no login page on this surface).

## Files

- `apps/api/src/log/buffer.ts` _(new)_
- `apps/api/src/log/logger.ts` _(fanout destination + `service` binding)_
- `apps/api/src/roles/api.ts` _(Fastify logger routed through the destination)_
- `apps/api/src/routes/admin/logs.ts` _(new — HTML page + JSON tail endpoint)_
- `apps/api/test/observability/logs.test.ts` _(new)_

## Definition of done

- [x] All three roles (api/worker/bot) fan logs into `logs:stream`; lines carry
      `service` so containers are distinguishable.
- [x] `GET /admin/logs` serves the terminal HTML page to an admin; player /
      unauthenticated → 403 / 401.
- [x] `GET /admin/logs.json` returns recent entries, tails via `?after=<id>`,
      and filters via `?level=`; admin-gated.
- [x] The real `pino → multistream → Redis` write path is exercised and a logged
      line round-trips through the viewer (integration test, not a seeded stream).
- [x] Redaction preserved: a line carrying `authorization` / `cookie` reaches
      the persisted stream as `[REDACTED]` (test).
- [x] The Redis fanout is fire-and-forget and cannot block or break stdout
      logging if Redis is unavailable.
