# 06 — Frontend (React + TypeScript)

> Structure and contracts only — **not implemented**. TypeScript is the default
> for the entire client; there is no plain-JS path.
>
> **Phases:** this doc describes the **v2+ target**. In v1 the SPA ships only
> `/`, `/login`, `/portfolio`, and a perpetual `/leaderboard`. The
> season-scoped routes below (`/seasons/*`, per-season leaderboard) arrive
> in v2 when seasons + themes land; the `/algos` route arrives in v3 with
> user-authored strategies. The `WsTopic` shape is similarly v2+ — see
> [03-api §7](03-api.md#7-websocket) for the v1 topic set and
> [09-open-questions A3](09-open-questions.md) for the v1→v2 transition.

## 1. Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | React | SPA; SSR not required for a game UI |
| Language | **TypeScript** | Strict mode on; no implicit `any` |
| Build/dev | Vite (recommended) | Fast HMR; simple static output for the VPS |
| Routing | Client-side router | e.g. React Router; routes in §4 |
| Data fetching | Typed fetch + a query/cache layer | e.g. TanStack Query; types from §2 |
| Realtime | Single WebSocket client | Subscriptions per [03-api](03-api.md#7-websocket) |
| State | Server-state via query cache; minimal local UI state | Avoid a heavy global store early |
| Styling | **CSS Modules** | Scoped by default, no runtime, matches workspace convention |

> Build output is static assets served by the gateway (see
> [08-deployment](08-deployment.md)). No Node runtime is required *on the client
> path* — the React app is files; the API is separate.

## 2. Shared types

The backend default is TypeScript specifically so the wire types can be shared.
Define API request/response and entity types once in a shared package and import
them on both sides.

```
/packages
  /shared-types        # entities + API contracts (the §2 of 02 and 03 docs)
    index.ts           # re-exports User, Season, Portfolio, Order, ... and
                       # CreateOrderRequest, LeaderboardResponse, WsServerMessage…
/apps
  /web                 # the React app, imports @tickr/shared-types
  /api                 # the Node/TS backend, imports @tickr/shared-types
```

> If/when a component is rewritten in Go (see
> [01-architecture](01-architecture.md#3-language-strategy)), the shared types stop
> being the source of truth for *that* boundary and the language-neutral contract
> format (OpenAPI/Protobuf — TODO) takes over. The web app keeps generated TS
> types either way.

## 3. App structure (proposed)

```
/apps/web/src
  /api          # typed client wrappers around REST + WS (uses shared-types)
  /auth         # session context, login buttons, guards
  /components   # presentational, reusable
  /features
    /seasons    # season list, season detail, join
    /portfolio  # holdings, order ticket, history chart
    /leaderboard
    /algos      # create/manage algos, attach to season
    /admin      # admin-only screens (themes, seasons, seed bots, ops)
  /lib          # formatting (money/percent), time, constants
  /routes       # route definitions + lazy loading
  main.tsx
```

## 4. Routes & views

| Route | View | Auth | Key data |
|---|---|---|---|
| `/` | Landing + active seasons | public | `GET /seasons?status=active` |
| `/login` | SSO buttons (Google, GitHub) | public | `/auth/*/start` |
| `/seasons/:id` | Season detail + join | public | `GET /seasons/:id` |
| `/seasons/:id/leaderboard` | Leaderboard | public | `GET /seasons/:id/leaderboard` + WS |
| `/portfolios/:id` | Holdings, order ticket, equity chart | player (owner) | `GET /portfolios/:id` + WS |
| `/algos` | Manage algos | player | `GET /algos` |
| `/admin` | Admin console | admin | `/admin/*` |

### 4.1 Key interactions

- **Join a season** → `POST /seasons/:id/join` → redirect to the new portfolio.
- **Place an order** → order ticket validates client-side (symbol ∈ theme, qty>0,
  affordable) for UX, but trusts the **server** as authority; sends
  `CreateOrderRequest` with a generated `idempotencyKey`.
- **Live updates** → subscribe to `portfolio` and `leaderboard` WS topics; reflect
  `order.filled`, `portfolio.updated`, `leaderboard.updated` without polling.

## 5. Auth on the client

- Session is a server cookie (HTTP-only) — **the client never reads a token**.
- An `AuthProvider` calls `GET /me` on load to learn the current user/role and
  gate admin routes. 401 → show login.
- Login is a redirect to `/auth/:provider/start`; the SPA resumes after callback.

## 6. Money & number formatting

- All money arrives as integer **cents**; format at the edge only.
- A single `formatMoney(cents)` / `formatPercent(x)` in `/lib` to avoid drift.
- Never do financial math in floats on the client; display only.

## 7. Realtime client contract

The WS client is typed against `WsClientMessage` / `WsServerMessage`
([03-api](03-api.md#7-websocket)):

```ts
interface TickrSocket {
  subscribe(topic: WsTopic): void;
  unsubscribe(topic: WsTopic): void;
  on<T extends WsServerMessage["type"]>(
    type: T,
    handler: (msg: Extract<WsServerMessage, { type: T }>) => void
  ): () => void;   // returns unsubscribe
}
```

Reconnect with backoff; re-subscribe active topics on reconnect; degrade to
periodic REST refetch if the socket is unavailable.

## 8. Performance & escape hatch

- The client is read-mostly; the leaderboard and portfolio views are the hot
  screens. Lean on the cached server reads (snapshots), not live recompute.
- The "use a compiled language if slow" decision is a **backend** concern
  ([01-architecture](01-architecture.md#3-language-strategy)); it does not change
  the React app, which talks to the same API contract regardless.

## 9. Frontend decisions (resolved)

- **Styling:** CSS Modules. Scoped, no runtime cost, no purge config needed.
- **Charting:** [Lightweight Charts](https://github.com/tradingview/lightweight-charts)
  (TradingView). Purpose-built for financial time-series; small bundle; handles
  equity curves and leaderboard history well.
- **Component library:** hand-roll early. The UI surface is small and focused;
  reach for [Semantic UI React](https://react.semantic-ui.com/) if a library is
  needed rather than adopting one prematurely.
