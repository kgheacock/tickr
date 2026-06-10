# 22 — Ticker metadata + branding

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/56) • **Depends on:** 13, 19

## Goal

Source company **reference metadata** (name, exchange, type, market cap, SIC
sector, description, …) and **branding images** (logo + icon) for every universe
symbol from the Massive reference API, store them in Postgres, and serve the
images to the browser. The upstream image URLs are Bearer-gated, so the frontend
cannot hotlink them — the bytes are downloaded and served from our own API.

## Pre-reads

- [TODO/13-massive-client.md](13-massive-client.md) — the Massive client and the
  Redis token bucket this job reuses (5 req/min free-tier limit).
- [schema/massive.com/openapi.json](../schema/massive.com/openapi.json) — the
  bundled aggregates surface. Reference endpoints (`/v3/reference/tickers/...`,
  `/v1/reference/company-branding/...`) are Polygon-compatible and confirmed live
  by `scripts/probe-massive-reference.ts`.

## Steps

1. **Schema (migration 007).** `symbol_metadata` (lean company fields, queried)
   and `symbol_branding` (downloaded logo/icon `BYTEA`, isolated for a later move
   to object storage). Per-artifact `fetched_at` columns drive idempotent age-out.
2. **Client.** Add `massiveGetBytes()` to `apps/api/src/massive/client.ts`,
   sharing the existing bucket + retry shell, so image downloads are rate-limited
   and no code path fetches `api.massive.com` outside the client.
3. **Refresh job.** `refresh-metadata.ts` + `run-metadata.ts` + `pnpm metadata`:
   selects symbols whose metadata/branding is missing or older than
   `METADATA_TTL_DAYS`, fetches details (normalizing `BRK-B`→`BRK.B`), downloads
   images, upserts per-symbol so an interrupt resumes. Missing branding is stamped
   "checked, none available" so a re-run reaches a quiet steady state.
4. **Serving endpoint.** Public `GET /symbols/:symbol/{logo,icon}` streams the
   stored bytes with the stored content-type, an ETag/304 validator, immutable
   caching, and `nosniff` + a locked-down CSP to neutralize SVG-as-document XSS.
5. **Docs + tests.** OpenAPI paths, `.env.example` vars, and unit/integration
   tests for the client, the job, and the route.

## Definition of done

- [x] `symbol_metadata` + `symbol_branding` created by migration 007; image bytes
      stored in Postgres with per-artifact fetch timestamps.
- [x] `massiveGetBytes` downloads images on the shared bucket/retry path; no fetch
      hits `api.massive.com` outside `client.ts`.
- [x] `pnpm metadata` is repeatable and idempotent: a second run within the TTL
      fetches nothing, an interrupt resumes per-symbol, and a symbol with no
      branding does not re-select forever.
- [x] Ticker-format normalization verified live (`BRK-B`→`BRK.B`, `MOG-A`→`MOG.A`).
- [x] Public `GET /symbols/:symbol/{logo,icon}` serves the stored bytes with
      correct content-type, ETag/304, immutable caching, and SVG hardening.
- [x] OpenAPI + `.env.example` updated; generated types regenerated.
- [x] Client, job, and route tests pass; full `pnpm --filter @tickr/api test` green.
- [ ] **Follow-up:** `apps/web` renders the logos (`<img>` in the UI).
- [ ] **Follow-up:** metadata JSON endpoint (name / sector / market cap) so a
      company name can sit beside the logo.
