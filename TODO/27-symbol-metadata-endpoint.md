# 27 — Symbol metadata JSON endpoint

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/67) • **Depends on:** 22

## Goal

Serve the company **reference metadata** the refresh job already stores in
`symbol_metadata` over a JSON endpoint, so a company name / sector / market cap
can sit beside the logo in the UI. This realizes the follow-up left open in
[item 22](22-ticker-metadata-and-branding.md) (DoD line: *"metadata JSON
endpoint (name / sector / market cap) so a company name can sit beside the
logo"*). Item 22 downloaded and stored the metadata and served the **images**;
the broken-out company fields were populated but never exposed.

Unlike the public logo/icon assets, this is **protected** — company reference
data sits behind login, matching `/universe` and `/me`.

## Pre-reads

- [TODO/22-ticker-metadata-and-branding.md](22-ticker-metadata-and-branding.md)
  — the refresh job (`apps/api/src/jobs/refresh-metadata.ts`) and the
  `symbol_metadata` / `symbol_branding` split (migration 007).
- `apps/api/src/routes/branding.ts` — the existing public per-symbol image
  routes this parallels (`/symbols/:symbol/{logo,icon}`).

## Steps

1. **Route** (`apps/api/src/routes/metadata.ts`) — `GET /symbols/:symbol/metadata`,
   `requireAuth`-gated. Uppercases the symbol (case-insensitive, dotted `BRK.B`
   survives Fastify routing), 404s an unknown symbol. Returns the broken-out
   columns: `name`, `primaryExchange`, `type`, `marketCap`, `sicCode`,
   `sicDescription`, `homepageUrl`, `listDate`, `totalEmployees`, `description`,
   `fetchedAt`. Excludes the raw Massive payload (`raw`) and internal bookkeeping
   (`updated_at`, `massive_ticker`) so the contract stays decoupled from upstream.
2. **Timezone-proof date** — `list_date` formatted via `to_char(..., 'YYYY-MM-DD')`
   in SQL rather than a JS `Date.toISOString()` slice, so the calendar day doesn't
   shift across UTC offsets.
3. **Contract** — `SymbolMetadata` schema + path added to
   `packages/shared-types/openapi.yaml` (inherits the global `cookieAuth`),
   generated types regenerated (`pnpm gen:types`) and exported from `index.ts`.
4. **Register + test** — wired into `apps/api/src/roles/api.ts`; route test under
   `apps/api/test/metadata/`.

## Definition of done

- [x] `GET /symbols/:symbol/metadata` returns the broken-out company fields for an
      authenticated caller; `raw` / `updated_at` / `massive_ticker` are not exposed.
- [x] Protected via `requireAuth` — 401 for an unauthenticated caller; 404 for a
      symbol with no `symbol_metadata` row; case-insensitive and dotted-symbol
      (`BRK.B`) lookup verified.
- [x] `marketCap` served as a JSON number; `listDate` is a timezone-proof
      `YYYY-MM-DD` (verified under `TZ=Pacific/Auckland`).
- [x] `SymbolMetadata` schema + path in `openapi.yaml`; generated types
      regenerated and exported.
- [x] Route test covers 200 + shape, null fields, 401, 404, dotted `BRK.B`, and
      case-insensitivity; typecheck + lint clean.
