# 24 — Landing page: logo board → markets ribbon

> **Status:** flap board [shipped](https://github.com/kgheacock/tickr/pull/60),
> then **superseded** by the markets ribbon
> [in review](https://github.com/kgheacock/tickr/pull/62) • **Depends on:** 11, 22
>
> A reusable `FlapBoard` SPA component that takes an array of tickers and, as a
> **single split-flap tile**, flips through them one at a time — dropping a
> fresh flap with each symbol's logo (served by item 22's branding endpoint).
> The first consumer is the landing page, where it stands in for the lead
> paragraph's drop-cap "F".
>
> **Superseded (PR #62):** the flap tile read as out of place in the
> WSJ-front-page layout, so it was replaced by a scrolling **markets ribbon**
> (`TickerTape`) and a restored serif drop cap. See the follow-up section below;
> `FlapBoard` is removed.

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
- **Drop cap beside the word.** The flipper floats as the lead paragraph's drop
  cap, to the left of the opening word "Fantasy" (which keeps its visible "F").
  The old `::first-letter` drop cap is removed so it no longer enlarges the F.
- **Visual language.** Cream gradient tile + center seam echo the split-flap
  tiles in `docs/index.html`, reusing the newsprint design tokens.

## Steps (as built)

1. **`FlapBoard` component** (`apps/web/src/components/FlapBoard.tsx` +
   `.module.css`). Props `{ tickers: string[]; intervalMs?: number }`; a
   `setInterval` advances the index and a `FlapFace` subcomponent owns the
   logo→glyph fallback state. A single tile sized as a drop cap.
2. **Landing page drop cap** (`apps/web/src/pages/LandingPage.tsx` +
   `.module.css`). The flipper floats in at the start of the lead paragraph,
   beside the opening word "Fantasy"; the old `.deck::first-letter` drop cap is
   removed so it no longer enlarges the "F".

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
- [x] Sits as the landing page's lead drop cap, beside the opening word
      "Fantasy" (which keeps its visible "F").
- [x] `tsc --noEmit`, eslint, and prettier are clean.

## Follow-up — markets ribbon redesign (PR #62)

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/62)

The flap tile, used as the lede's drop cap, didn't fit the newspaper layout.
Keep the dynamic logos but move them into a newspaper-native treatment: a
scrolling **markets ribbon** under the masthead, plus a real serif drop cap.

### Steps (as built)

1. **`TickerTape` component** (`apps/web/src/components/TickerTape.tsx` +
   `.module.css`). Props `{ tickers: string[]; label?: string }`. A fixed
   editorial label ("The Tape") sits in a ruled cell, followed by an overflow
   window whose track holds two concatenated copies of the run and translates
   `-50%` for a seamless loop. Slow linear drift, pause-on-hover, edge fades,
   and `animation: none` under `prefers-reduced-motion`. Each `Quote` is just
   the brand logo, pinned to a common height (width free, `max-width` clamp) so
   icon marks and wide wordmarks align without distortion; a symbol whose logo
   404s renders `null` and drops out of the tape, so only real logos show.
2. **Landing page** (`apps/web/src/pages/LandingPage.tsx` + `.module.css`).
   `<TickerTape>` is placed below the masthead rules, above the hero. The lede's
   `.deck::first-letter` serif drop cap is restored.
3. **Remove `FlapBoard`** (`.tsx` + `.module.css` deleted; no other consumers).

### Files

- `apps/web/src/components/TickerTape.tsx` _(ribbon + per-logo drop-on-404)_
- `apps/web/src/components/TickerTape.module.css` _(strip + seamless marquee)_
- `apps/web/src/pages/LandingPage.tsx` _(ribbon placement; flap board removed)_
- `apps/web/src/pages/LandingPage.module.css` _(restored `::first-letter` drop cap)_
- ~~`apps/web/src/components/FlapBoard.tsx` / `.module.css`~~ _(deleted)_

### Definition of done

- [x] `TickerTape` takes `tickers: string[]` and scrolls their logos under a
      fixed label as an endless, hairline-framed markets strip.
- [x] Logos only: a symbol whose logo 404s drops out of the tape entirely.
- [x] Logos share a baseline (fixed height, free width, `max-width` clamp) so
      icon marks and wordmarks don't distort.
- [x] Tape pauses on hover and holds still under `prefers-reduced-motion`.
- [x] The lede regains a serif `::first-letter` drop cap; `FlapBoard` is removed.
- [x] `tsc --noEmit`, eslint, and prettier are clean.
