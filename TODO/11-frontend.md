# 11 — Frontend SPA

> **Status:** pending • **Depends on:** 02, 04, 07, 08, 09

## Goal

Build the v1 SPA: SSO login, the perpetual portfolio view (cash,
positions, order ticket, equity chart), and the perpetual leaderboard.
Live updates over the WS gateway. CSS Modules + hand-rolled components.

## Pre-reads

- [docs/06-frontend.md](../docs/06-frontend.md) — stack, app structure,
  routes (v2+ routes are not in scope here; see the phase banner).
- [docs/03-api.md](../docs/03-api.md) — endpoints + WS topics.
- [docs/04-game-mechanics.md](../docs/04-game-mechanics.md) — what the UI
  must communicate (daily ranking cadence, fill at last close).

## Steps

1. **Scaffold.** `apps/web` via Vite (`npm create vite@latest -- --template
   react-ts`). Strict TS. Add: `react-router-dom`, `@tanstack/react-query`,
   `lightweight-charts`, `zod`, `@tickr/shared-types`. CSS Modules
   work out of the box with Vite.
2. **App shell.** `src/main.tsx`, `src/App.tsx` with React Router
   `<Routes>`:
   - `/` — landing (logged out: explain the game + show top-10
     leaderboard; logged in: redirect to `/portfolio`).
   - `/login` — Google + GitHub buttons that hit
     `/api/v1/auth/:provider/start`.
   - `/portfolio` — owner-only.
   - `/leaderboard` — public.
3. **Auth context.** `src/auth/AuthProvider.tsx` calls `GET /me` on
   mount (TanStack Query). On 401 → unauthenticated state. Exposes
   `user`, `portfolioId`, `csrfToken`. A `<RequireAuth>` wrapper
   redirects to `/login` if unauthenticated.
4. **Typed fetch client.** `src/api/client.ts` wraps `fetch` with:
   - `credentials: 'include'` (session cookie).
   - `X-CSRF-Token` header for mutations.
   - Typed responses via `@tickr/shared-types`.
   - Throws `ApiError` on non-2xx with the parsed `error` envelope.
5. **WS client.** `src/api/socket.ts` opens `/ws`, exposes
   `subscribe(topic)`, `on(eventType, handler)` per
   [docs/06-frontend.md §7](../docs/06-frontend.md). Reconnect with
   exponential backoff (1s→30s); on reconnect, replay all active
   subscriptions. If down for > 30 s, fall back to TanStack Query refetch
   every 30 s.
6. **Portfolio view.** `src/features/portfolio/PortfolioPage.tsx`:
   - Top: display name, cash, equity (live, computed from latest
     `lastPrice` per position), return % vs starting capital, "as of
     <lastSnapshotAt>" tag explaining the ranking.
   - Positions table: symbol, quantity, avg cost, last price, market
     value, P/L.
   - Equity chart: TradingView Lightweight Charts; data from
     `GET /portfolios/:id/history`.
   - Order ticket: symbol autocomplete (`GET /symbols`), buy/sell,
     quantity, fractional supported. Client-side validation mirrors
     server (`SYMBOL_NOT_TRADEABLE` if not backfilled, insufficient
     funds, etc.) for UX only — server is authoritative. Generates an
     `idempotencyKey` per submission attempt (regenerated only on user
     edit).
   - Subscribes to `{ kind: 'portfolio', portfolioId }`; on
     `order.filled` or `portfolio.updated`, invalidate the relevant
     queries.
7. **Leaderboard view.** `src/features/leaderboard/LeaderboardPage.tsx`:
   - Paginated table (TanStack Query infinite scroll).
   - "Snapshot taken <relative time>" header — clearly daily.
   - Subscribes to `{ kind: 'leaderboard' }`; on `leaderboard.updated`
     replace the cached data.
   - Bot row visually distinguished (italics + a small "bot" tag).
8. **Money / number formatting.** `src/lib/format.ts` exports
   `formatCents(n)`, `formatPercent(n)`, `formatQuantity(n)`. Never do
   financial math in floats on the client; display-only conversions.
9. **Styling.** `*.module.css` next to each component. A small token
   file `src/lib/tokens.css` for colors, spacing, radii. No CSS-in-JS,
   no Tailwind.
10. **Tests.** Jest + React Testing Library for components.
    Playwright e2e covering: sign in → place order → see fill on
    portfolio → see updated rank after a forced snapshot (admin
    endpoint).

## Files to create

- `apps/web/package.json`, `apps/web/vite.config.ts`,
  `apps/web/tsconfig.json`
- `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- `apps/web/src/auth/AuthProvider.tsx`,
  `apps/web/src/auth/RequireAuth.tsx`
- `apps/web/src/api/client.ts`, `apps/web/src/api/socket.ts`
- `apps/web/src/features/portfolio/*`
- `apps/web/src/features/leaderboard/*`
- `apps/web/src/lib/format.ts`, `apps/web/src/lib/tokens.css`
- `apps/web/test/*`, `apps/web/playwright/*`

## Definition of done

- [ ] `npm run dev` in `apps/web` serves the SPA at http://localhost:5173
      and proxies `/api` + `/ws` to the api container.
- [ ] Signing in with Google sets the cookie and lands on `/portfolio`.
- [ ] Placing a market buy reflects in the positions table within 1 s
      of the fill (WS path), without polling.
- [ ] Forcing an EOD snapshot (admin-triggered) updates the leaderboard
      view within 1 s without a page reload.
- [ ] No `any` types in committed code.
- [ ] All money is rendered via `formatCents`; the page passes the
      "no-floats-in-JS-financial-math" lint rule.
