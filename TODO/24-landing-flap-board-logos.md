# 24 — Landing page: split-flap logo flipper

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/60) • **Depends on:** 11, 22
>
> A reusable `FlapBoard` SPA component that takes an array of tickers and, as a
> **single split-flap tile**, flips through them one at a time — dropping a
> fresh flap with each symbol's logo (served by item 22's branding endpoint).
> The first consumer is the landing page, where it stands in for the lead
> paragraph's drop-cap "F".

## Goal

Bring the marketing page's split-flap idiom into the SPA: a single flap tile
that flips through company logos, fed by a plain `tickers: string[]` prop and
the public branding endpoint (`/api/v1/symbols/:symbol/logo`), placed as the
lead paragraph's drop cap.

## Context / constraints

- **The logo endpoint 404s on missing branding** (see `routes/branding.ts`), and
  backfill is still in progress — most symbols have no stored logo yet. So each
  tile must **degrade gracefully**: on image error it falls back to the bare
  ticker glyph, and the board always renders something legible rather than a
  broken-image icon.
- **Same-origin, no client wrapper.** Logos are plain `<img src>` against the
  relative `/api/v1/...` path (matching `api/client.ts`'s origin handling), so
  the component needs no fetch/JSON plumbing and the images are CDN-cacheable
  (the endpoint sends `Cache-Control: immutable` + ETag).
- **Flip on a top hinge.** Each tick advances the index and the leaf is
  re-keyed so a `rotateX(-92deg → 0)` "flap-drop" animation replays — a fresh
  flap swinging down into place. Decorative, so the whole tile is `aria-hidden`
  and the animation is disabled under `prefers-reduced-motion` (it still cycles).
- **Drop cap without breaking the text.** The flipper floats as the lead
  paragraph's drop cap; the literal "F" is kept but visually hidden (`.srOnly`),
  so the tile stands in for it while the paragraph still reads "Fantasy…" for
  screen readers and selection. The old `::first-letter` drop cap is removed.
- **Visual language.** Cream gradient tile + center seam echo the split-flap
  tiles in `docs/index.html`, reusing the newsprint design tokens.

## Steps (as built)

1. **`FlapBoard` component** (`apps/web/src/components/FlapBoard.tsx` +
   `.module.css`). Props `{ tickers: string[]; intervalMs?: number }`; a
   `setInterval` advances the index and a `FlapFace` subcomponent owns the
   logo→glyph fallback state. A single tile sized as a drop cap.
2. **Landing page drop cap** (`apps/web/src/pages/LandingPage.tsx` +
   `.module.css`). The flipper floats in at the start of the lead paragraph in
   place of the "F"; the literal "F" is wrapped in a `.srOnly` span and the old
   `.deck::first-letter` drop cap is removed.

## Entry point

`https://tickr.keithheacock.com/` (the landing page, signed-out or signed-in).

## Files

- `apps/web/src/components/FlapBoard.tsx` _(flipper + face fallback)_
- `apps/web/src/components/FlapBoard.module.css` _(tile + flap-drop animation)_
- `apps/web/src/pages/LandingPage.tsx` _(drop-cap wiring + hidden "F")_
- `apps/web/src/pages/LandingPage.module.css` _(remove `::first-letter`, add `.srOnly`)_
- `docs/screenshots/landing-flap-board.png` _(PR screenshot)_

## Definition of done

- [x] `FlapBoard` takes `tickers: string[]` and, as a single split-flap tile,
      flips through them, each face loading `/api/v1/symbols/:symbol/logo`.
- [x] A symbol with no stored logo (404) falls back to the ticker glyph; the
      tile never shows a broken-image icon.
- [x] Each change replays a flap-drop animation; the flip honors
      `prefers-reduced-motion`.
- [x] Sits as the landing page's lead drop cap in place of the "F", with the
      letter preserved for screen readers / selection.
- [x] `tsc --noEmit`, eslint, and prettier are clean.
