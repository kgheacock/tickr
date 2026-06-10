# FS-00 · UI groundwork (light theme & login surface)

**Status:** `done` ([#48](https://github.com/kgheacock/tickr/pull/48)) · **Epic:** [Fantasy Street](README.md) · **Depends on:** platform auth/sessions

Retroactive record. Front-end groundwork done ahead of the league-mode build so
later items land on a coherent visual base instead of the v1 market/strategy
chrome.

## User stories
- As a player, I want the app to read like a sports/markets newspaper, so that
  Fantasy Street feels like its own product rather than the v1 tooling.
- As a player, I want a single, on-theme entry page, so that signing in is the
  only thing I can do until league mode ships.
- As a returning manager, I want the entry page to recognize me, so that I see
  my account and can sign out without a separate page.

## Delivered
- **Light "newsprint" theme** (Wall Street Journal front-page aesthetic):
  rewrote `tokens.css` (ink on warm paper, hairline rules, editorial-blue
  accent) and wired Newsreader / Libre Franklin / JetBrains Mono fonts.
- **Login page rebuilt** as an editorial front page — masthead, double rule,
  lead story + sign-in column. Copy reframed for Fantasy Street: kicker
  *Fantasy Street*, headline *"Draft your team. Set your lineup. Earn your
  glory."*, deck derived from this epic's README.
- **Auth-aware sign-in column:** logged out → Google/GitHub buttons + closed-
  beta line; logged in → Account view (email + sign out). The user stays on the
  home page (the OAuth callback already redirects to `/`).
- **Reduced surface area:** removed the v1 market (home) and strategy pages and
  their routes; the app is a single `/` route.
- **Kept for reuse:** `LineChart` component and `lightweight-charts` stay for
  the dashboard / live-following work (items 09, 06).

## Follow-ups
- The dark OAuth chips are fixed by Google's branding guidelines; design around
  them rather than recoloring (see `docs/oauth-provider-approval.md`).
- Re-theme `LineChart` colors via props when it's rewired into a Fantasy Street
  view; series colors arrive from the caller, not the component.
