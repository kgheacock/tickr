# 02 — Shared contracts

> **Status:** [done](https://github.com/kgheacock/tickr/pull/4) • **Depends on:** 01

## Goal

Single source of truth for the v1 wire types: an OpenAPI document for the
public REST surface and a `@tickr/shared-types` TS package the api and web
both import. No drift between server and client types.

## Pre-reads

- [docs/03-api.md](../docs/03-api.md) — the v1 endpoint surface.
- [docs/02-data-model.md](../docs/02-data-model.md) — the entity types.
- [docs/09-open-questions.md D4](../docs/09-open-questions.md) — OpenAPI +
  shared TS decision.

## Steps

1. **OpenAPI doc.** Author `packages/shared-types/openapi.yaml` covering:
   - `/me`, `/auth/*/start`, `/auth/*/callback`, `/auth/logout`,
     `/auth/link/*/start`
   - `/portfolios/:id`, `/portfolios/:id/orders` (GET + POST),
     `/portfolios/:id/orders/:orderId/cancel`, `/portfolios/:id/history`
   - `/leaderboard`
   - `/quotes`, `/symbols`
   - `/admin/universe/upsert`, `/admin/universe/backfill`, `/admin/ops`
   - Schemas mirroring the TS interfaces in [docs/02-data-model.md](../docs/02-data-model.md)
     and [docs/03-api.md](../docs/03-api.md).
2. **Generate TS types from OpenAPI.** Use `openapi-typescript` to emit
   `packages/shared-types/src/openapi.gen.ts`. Wrap in friendly exports
   (`User`, `Order`, `Fill`, `PortfolioView`, `LeaderboardResponse`,
   `CreateOrderRequest`, etc.) in `packages/shared-types/src/index.ts`.
3. **Hand-written WS types.** WebSocket isn't covered by OpenAPI. Add
   `packages/shared-types/src/ws.ts` mirroring [docs/03-api.md §7](../docs/03-api.md#7-websocket):
   `WsClientMessage`, `WsServerMessage`, `WsTopic`. Re-export from `index.ts`.
4. **Validation at runtime.** Use `zod` schemas alongside the static types
   for request validation in the api. Co-locate per-route schemas in
   `apps/api/src/routes/*/schema.ts` and infer types via `z.infer<>` where
   you don't want the OpenAPI-generated form.
5. **Wire it up.** `apps/api/package.json` and `apps/web/package.json` both
   declare `"@tickr/shared-types": "workspace:*"`. pnpm workspaces resolves
   the local package.
6. **Codegen as a script, not a hook.** `pnpm run gen:types` regenerates the
   openapi.gen.ts file; runs in CI; commit the generated file.

## Files to create

- `packages/shared-types/package.json`
- `packages/shared-types/tsconfig.json`
- `packages/shared-types/openapi.yaml`
- `packages/shared-types/src/index.ts`
- `packages/shared-types/src/ws.ts`
- `packages/shared-types/src/openapi.gen.ts` (generated)
- Root `package.json` script: `"gen:types"`

## Definition of done

- [ ] `pnpm run gen:types` regenerates `openapi.gen.ts` deterministically.
- [ ] `apps/api` and `apps/web` both compile against
      `import { ... } from '@tickr/shared-types'`.
- [ ] OpenAPI doc validates with `npx @redocly/cli lint
      packages/shared-types/openapi.yaml`.
- [ ] CI fails on uncommitted codegen diff.
- [ ] `WsClientMessage` / `WsServerMessage` exhaustively cover the v1 event
      set in [docs/03-api.md §7](../docs/03-api.md#7-websocket).
