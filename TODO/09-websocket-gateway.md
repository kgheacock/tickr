# 09 — WebSocket gateway

> **Status:** pending • **Depends on:** 04, 07, 08

## Goal

A single authenticated `/ws` endpoint that lets clients subscribe to
typed topics and pushes events as they happen: `portfolio.updated`,
`order.filled`, `leaderboard.updated`, `quotes.updated`. Conforms to the
contract in [docs/03-api.md §7](../docs/03-api.md#7-websocket).

## Pre-reads

- [docs/03-api.md §7](../docs/03-api.md#7-websocket) — message and topic types.
- [docs/06-frontend.md §7](../docs/06-frontend.md) — client-side contract
  the gateway must satisfy.

## Steps

1. **WS server.** Use `ws` (low-level) rather than socket.io to keep the
   protocol simple. Mount at `/ws` on the same HTTP server as the REST
   api. Caddy already upgrades through the proxy.
2. **Auth at upgrade.** During HTTP→WS upgrade, read the `tickr_sid`
   cookie; look up the session in Redis; reject `401` if invalid.
   Attach `userId` to the WS connection.
3. **Topic subscriptions.** Client sends
   `{ type: 'subscribe', topic: WsTopic }` after connect. Server
   validates:
   - `portfolio` topic — `portfolioId` must belong to the user (or admin).
   - `leaderboard` topic — public.
   - `quotes` topic — public; `symbols` must each exist in
     `universe_symbol`; cap at 100 per subscription.
   Connection holds a `Set<TopicKey>` of subscribed topics.
4. **Event publisher.** `apps/api/src/events/publisher.ts` is the only
   place the rest of the codebase pushes from. It writes a typed event
   to Redis pub/sub on a per-topic channel:
   - `ws:portfolio:<portfolioId>` ← `portfolio.updated`, `order.filled`
   - `ws:leaderboard` ← `leaderboard.updated`
   - `ws:quotes` ← `quotes.updated` (fires after daily price update)
5. **Fan-out.** Each WS server process subscribes to all `ws:*` channels
   (pattern subscribe with `psubscribe ws:*`). On message, fan out to
   matching connections. This lets multiple api containers run later
   without losing events. In v1 there's one api process, but the design
   is ready.
6. **Hooks into trading + snapshots.**
   - After a successful fill (item 07): publish `portfolio.updated` and
     `order.filled` on the portfolio's channel.
   - After the snapshot job (item 08): publish `leaderboard.updated` on
     the leaderboard channel.
   - After the daily price update (item 06): publish `quotes.updated`
     with the freshly-updated symbols.
7. **Backpressure + heartbeats.** Ping every 30 s; close stale
   connections after 60 s no-pong. Per-connection outbound queue cap
   (e.g. 256 messages) — drop oldest on overflow and emit an `error`
   message with `code: "BACKPRESSURE"`.
8. **Error messages.** Anything the gateway rejects (bad topic, unknown
   portfolio, validation failure) sends an `{ type: 'error', error: {
   code, message } }` and keeps the connection open. Only auth failures
   close.
9. **Tests.** Vitest + a real `ws` client:
   - Subscribe to your own portfolio, place an order via REST, receive
     `order.filled` then `portfolio.updated` on the socket.
   - Subscribe to another user's portfolio → server rejects with
     `FORBIDDEN`.
   - Subscribe to `leaderboard`, trigger the snapshot job, receive
     `leaderboard.updated`.
   - Unauthenticated upgrade → 401; cookie session expiry mid-connection
     → server closes.

## Files to create

- `apps/api/src/ws/server.ts`
- `apps/api/src/ws/auth.ts`
- `apps/api/src/ws/topics.ts`
- `apps/api/src/ws/subscriber.ts` (Redis psubscribe + fan-out)
- `apps/api/src/events/publisher.ts` (shared with item 08)
- `apps/api/test/ws/*.test.ts`

## Definition of done

- [ ] A connected, subscribed client receives a `portfolio.updated` event
      within 100 ms of a fill committing.
- [ ] Subscribing to another user's `portfolio` topic returns `FORBIDDEN`
      without closing the socket.
- [ ] `leaderboard.updated` fires once per snapshot job run.
- [ ] Killing and restarting the api process drops connections; client
      reconnect (item 11) resubscribes successfully.
- [ ] No event is delivered before the originating DB transaction commits
      (use `commit` hook on the pg client, not the `query` callback).
