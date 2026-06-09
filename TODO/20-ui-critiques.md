# 20 — UI critiques & polish (running list)

> **Status:** in-progress • **Depends on:** 11, 18 • **PR:** —
>
> A **running list** of UI changes recommended during a page-by-page review
> of `apps/web`. The reviewer (user) critiques each page; this file records
> each issue with enough detail for a future agent to act on it **without
> needing the original conversation**. This file is documentation only — no
> code changes are made while recording.

## How to use

- Items are grouped by page/surface, in review order.
- Each item has: **What** (the observed issue), **Where** (file/line if known),
  **Why** (impact), and **Proposed fix** (concrete direction). Severity is one
  of `blocker` / `major` / `minor` / `nit`.
- A future agent picks items, implements them, and checks them off. Keep the
  file open until the review is complete and all items are resolved.

## Surfaces under review

| Surface | File | Reviewed | Items |
|---|---|---|---|
| Landing | `src/pages/LandingPage.tsx` | — | — |
| ~~Login~~ (removed — folded into Landing) | ~~`src/pages/LoginPage.tsx`~~ | ✅ 2026-06-09 | 3 (all implemented) |
| Market | `src/features/market/MarketPage.tsx` | — | — |
| Strategy | `src/features/strategy/StrategyPage.tsx` | — | — |
| Shared (LineChart, App shell) | `src/components/`, `src/App.tsx` | — | — |

---

## Items

### Login page (`src/pages/LoginPage.tsx`)

### 1. Promote the login page to a hero layout  ·  `major`
- **Surface:** Login
- **What:** The login page is a small centered card (`.card`, `max-width:
  360px`) with a plain "Sign in to tickr" heading. It reads as a bare auth
  form, not a destination. It should be a **hero page** like the landing
  page — large title, supporting copy, generous vertical layout — so signing
  in feels like part of the product, not a utility screen.
- **Where:** `apps/web/src/pages/LoginPage.tsx:16-31`,
  `apps/web/src/pages/LoginPage.module.css:9-29`
- **Why:** First impression for anyone arriving from the landing CTA. A
  cramped card undersells the product and is visually inconsistent with the
  hero treatment already on `LandingPage`.
- **Proposed fix:** Restyle the page after the landing hero
  (`LandingPage.module.css` `.hero` / `.title` / `.tagline`): large `tickr`
  wordmark/title, a short value-prop line, then the sign-in actions. Reuse
  the landing hero's spacing/typography tokens for consistency. The provider
  buttons (item 3) live inside this hero rather than in a boxed card.
- **Status:** [x] done (2026-06-09) — `LoginPage.tsx`/`LoginPage.module.css`
  rebuilt as a hero (`.hero`/`.title`/`.tagline`) mirroring `LandingPage`;
  the boxed `.card` is gone.

### 2. Add a "Request access" call-to-action (closed beta)  ·  `major`
- **Surface:** Login
- **What:** tickr is currently in **closed beta**, but the login page offers
  no path for someone without access. It should surface a clear **"Request
  access"** call to action for users who can't yet sign in.
- **Where:** `apps/web/src/pages/LoginPage.tsx:16-31` (and likely the landing
  hero as well — confirm with user where the CTA should live)
- **Why:** Without a request-access path, interested-but-unapproved visitors
  hit a dead end at the OAuth buttons. A beta CTA captures that demand and
  sets expectations (this is invite-only right now).
- **Proposed fix:** Add a secondary CTA below the OAuth buttons, e.g.
  "tickr is in closed beta — request access". Style as a secondary/ghost
  action so it's clearly distinct from the primary sign-in buttons.
- **Destination (resolved 2026-06-09):** Link out to a **Google-account-gated
  form** (Google Forms, or Tally with a sign-in gate) as the convenient,
  zero-backend default. Rationale: requiring a Google sign-in to submit *is*
  the bot mitigation — Google does the human-gating for free, and the form
  captures the requester's Google email, which is exactly the identity that
  would later be granted OAuth access. The request and the grant key are the
  same thing. Reversible, no cost, nothing to deploy.
  - **Bot handling:** the sign-in gate is the deterrent. Only add a honeypot
    field + reuse TODO/10 rate limiting *if* this ever migrates to a custom
    in-app form. Do **not** build a captcha/anti-abuse subsystem for the
    closed-beta default.
  - **Alternative (not default):** a **Google Group** "request to join" flow —
    viable only if a beta announcements/comms channel is also wanted; the
    semantics are fuzzier (feels like joining a mailing list, not requesting
    app access).
  - **Rejected (don't relitigate):** `mailto:` (scrapeable, unstructured, no
    bot defense); a Slack join link (not a reviewable intake mechanism,
    invites spam); a custom `/request-access` route + endpoint (overkill for
    closed beta — that's the post-beta destination, not the convenient
    default).
  - **Action item for user:** provide the form URL once created, so the future
    agent can wire the CTA `href`.
- **Placement (resolved 2026-06-09):** the dedicated **login page was removed
  altogether**; sign-in moved into a **header** on the landing page, and the
  "Request access" CTA now lives in the landing hero. So the CTA is on Landing,
  not a separate login surface.
- **Status:** [x] done (2026-06-09) — CTA implemented in `LandingPage.tsx`:
  "tickr is in closed beta. Request access" in the hero below the tagline,
  styled as a secondary text link (`.beta`/`.requestAccess`). The `href` now
  points at the real Google-account-gated form
  (`https://forms.gle/xhPHtFmtSvHByEqa6`); the placeholder is gone. Placement
  resolved (see above).

### 3. Use branded OAuth provider buttons (Google / GitHub)  ·  `major`
- **Surface:** Login
- **What:** Both sign-in buttons share one generic blue style (`.btn` with
  `background: var(--color-accent)`), so "Sign in with Google" and "Sign in
  with GitHub" look identical and unbranded. They should follow the
  conventional, recognizable OAuth button treatments per provider.
- **Where:** `apps/web/src/pages/LoginPage.tsx:22-27`,
  `apps/web/src/pages/LoginPage.module.css:37-52` (single shared `.btn`)
- **Why:** Branded provider buttons are an established UX pattern — users scan
  for the Google "G" and GitHub mark/colors. Two identical blue buttons add
  friction and look unfinished/untrustworthy on an auth screen.
- **Proposed fix:** Give each provider its own button variant:
  - **Google:** white background, subtle border, dark text, the multicolor
    Google "G" icon (follow Google's sign-in branding guidelines).
  - **GitHub:** dark (`#24292f`/black) background, white text, GitHub Octocat
    mark.
  Add provider icons (inline SVG to avoid a dependency, consistent with the
  project's dependency-light charting choice). Keep the existing
  `href="/api/v1/auth/{google,github}/start"` links intact — styling only.
  Ensure adequate contrast and a visible focus state for accessibility.
- **Status:** [x] done (2026-06-09) — per-provider button variants in
  `LoginPage.tsx`/`LoginPage.module.css` with inline SVGs (no new dep). Google
  button follows the official dark-theme branding spec (fill `#131314`, 1px
  `#8E918F` border, text `#E3E3E3`, unmodified multicolor "G", text "Sign in
  with Google"); GitHub button is dark `#24292f` with the Octocat mark. Start
  `href`s unchanged; `:focus-visible` outline added. Brand-compliance and the
  follow-on Google approval steps are documented in
  `docs/oauth-provider-approval.md`.

<!--
Template for each item — copy when recording:

### NN. <short title>  ·  `severity`
- **Surface:** <page/component>
- **What:** <the observed issue, in the user's words + my read>
- **Where:** `apps/web/src/...:line`
- **Why:** <user impact / why it matters>
- **Proposed fix:** <concrete, actionable direction for the implementing agent>
- **Status:** [ ] open
-->
