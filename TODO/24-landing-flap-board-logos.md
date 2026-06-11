# 24 — Landing page: split-flap logo board

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/60) • **Depends on:** 11, 22
>
> A reusable `FlapBoard` SPA component that takes an array of tickers and
> renders a continuously-scrolling row of **split-flap tiles**, one per symbol,
> each showing the company logo served by item 22's branding endpoint. The
> first consumer is the landing page, as a masthead ticker band.

## Goal

Bring the marketing page's split-flap idiom into the SPA: an iterating list of
company logos that reads as a market ticker, fed by a plain `tickers: string[]`
prop and the public branding endpoint (`/api/v1/symbols/:symbol/logo`).

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
- **Seamless marquee.** The sequence is rendered twice and the track is
  translated by `calc(-50% - gap/2)` so the wrap lands exactly on the clone with
  no visible jump; the clone is `aria-hidden` so each symbol is announced once.
- **Motion is decorative.** The scroll pauses on hover and is disabled under
  `prefers-reduced-motion`; edges are masked so tiles slide in/out rather than
  popping at a hard clip.
- **Visual language.** Cream gradient tile + center seam echo the split-flap
  tiles in `docs/index.html`, reusing the newsprint design tokens.

## Steps (as built)

1. **`FlapBoard` component** (`apps/web/src/components/FlapBoard.tsx` +
   `.module.css`). Props `{ tickers: string[]; paused?: boolean }`; a `FlapTile`
   subcomponent owns the logo→glyph fallback state.
2. **Landing page wiring** (`apps/web/src/pages/LandingPage.tsx`). A
   `MARKET_TICKERS` spread of recognizable S&P 500 names rendered as a ticker
   band between the subhead rule and the hero.

## Entry point

`https://tickr.keithheacock.com/` (the landing page, signed-out or signed-in).

## Files

- `apps/web/src/components/FlapBoard.tsx` _(component + tile fallback)_
- `apps/web/src/components/FlapBoard.module.css` _(tile/marquee styles)_
- `apps/web/src/pages/LandingPage.tsx` _(ticker band wiring)_
- `docs/screenshots/landing-flap-board.png` _(PR screenshot)_

## Definition of done

- [x] `FlapBoard` takes `tickers: string[]` and renders one split-flap tile per
      symbol, each loading `/api/v1/symbols/:symbol/logo`.
- [x] A symbol with no stored logo (404) falls back to the ticker glyph; the
      board never shows a broken-image icon.
- [x] The marquee loops seamlessly, pauses on hover, and honors
      `prefers-reduced-motion`.
- [x] Wired into the landing page as a masthead ticker band.
- [x] `tsc --noEmit`, eslint, and prettier are clean.
