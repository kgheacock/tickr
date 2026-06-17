# FS-14 · UI polish (post-release follow-ons)

**Status:** `pending` · **Epic:** [Fantasy Street](README.md) · **Depends on:** 09

> **Non-blocking.** This is a running ledger of small UI/UX polish items found
> after the build was feature-complete. It does **not** gate the PR #70 release
> (item 13) — ship these as their own follow-on PR(s) after the epic merges.

## Polish items

### 1. Landing page: replace the static "My Leagues →" with league-aware affordances

Today the homepage shows a single hardcoded `My Leagues →` link for every
signed-in user, regardless of whether they belong to any leagues
(`apps/web/src/pages/LandingPage.tsx:80-82`, in the `user` branch of the
`Account` aside). Make it reflect the user's actual membership:

- **0 leagues** → replace the link with a **`+ Create League`** call-to-action.
- **≥1 leagues** → replace the single `My Leagues →` link with **one hyperlink
  per league, labelled with the league's name**, each linking to
  `/leagues/:id`. e.g.

  ```
  My Leagues →            ┌─ Bear Market Bulls
                    ─────▶ ├─ Office Shorts
                          └─ The Dividend Club
  ```

#### Implementation notes
- **Data source — two roles, decided.** Do **not** render the league list off
  `me.leagues`. `/me` carries `leagues` as a *sibling* of `user` in `MeResponse`
  (`packages/shared-types/src/openapi.gen.ts`), but that field is
  `LeagueMembership[]` → `{ leagueId, teamName, role, status }` — a **routing
  hint only, with no league name** (its OpenAPI description says "for client
  routing"). It can answer *"is this user in any leagues, and where do I send
  them"* on first paint, nothing more.
  - **Render the list from `GET /leagues?mine`** — `LeagueSummary`
    (`{ id, name, memberCount, size, status }`) is the display shape and carries
    the `name` these hyperlinks need. Reuse the existing query:
    `client.listLeagues('mine')` under `fantasyKeys.myLeagues`, exactly as
    `LeaguesPage.tsx` already does. The landing aside is a condensed
    `LeaguesPage` list and shares its cache entry (no duplicate fetch).
  - **Why two sources, not one:** `/me` is the slow-changing session bootstrap
    (`['me']`, 5-min `staleTime`); league membership/status changes on
    draft/join/trade and streams over the WS. Keeping leagues on their own query
    key lets them invalidate independently instead of forcing a refetch of
    identity/csrf or a nested-array patch into the `['me']` cache. Treat
    `/leagues?mine` as canonical for **display**, `me.leagues` as the cheap
    **routing hint**, and don't render names off the membership rows (they drift).
  - This depends on item 2 (full `me` exposed via `AuthProvider`) only for the
    *empty-vs-populated* decision if you'd rather branch off the bootstrap hint;
    the rendered list itself comes from `listLeagues('mine')` regardless.
- **Empty/loading state.** While the leagues query is loading, keep the aside
  stable (don't flash the CTA then swap to a list). Pick a default — e.g. render
  nothing in that slot until resolved, matching the page's existing
  `isLoading ? null` treatment.
- **⚠ Hidden scope — there is no create-league UI yet.** `POST /leagues` exists
  on the API, but no frontend surface calls it: `LeaguesPage` explicitly scopes
  out creation ("creation/join live in FS-01") and its empty state tells users to
  "ask a commissioner for an invite." So `+ Create League` needs a **destination
  that does not exist today**. Decide and note it before building:
  - **(a)** build a real create flow (a `/leagues/new` route or a create
    form/modal on `LeaguesPage`) wired to `POST /leagues` — this is the honest
    full fix but is bigger than "polish"; or
  - **(b)** point the CTA at an interim target (e.g. `/leagues`, where a create
    control would live) and split the actual create flow into its own item.

  This polish item is **(b)-sized** unless we deliberately pull the create flow
  in. Flag the choice in the PR.

#### Files
- Edit: `apps/web/src/pages/LandingPage.tsx` (the `user` branch around L76–86),
  `apps/web/src/pages/LandingPage.module.css` (style the league list / CTA to
  match the newspaper aside).
- Reuse: `apps/web/src/api/client.ts` `listLeagues('mine')`,
  `apps/web/src/features/fantasy/api.ts` `fantasyKeys.myLeagues`.
- If option (a): new create route/form + `App.tsx` wiring.

> **⚠ Revised twice.** The league listing was built, then **removed** at the
> user's request ("remove my leagues entirely for now"), then **restored
> alongside the CTA** when a member's league stopped appearing on the homepage.
> The signed-in aside now shows: account email, a **My Leagues** list (one serif
> hyperlink per membership → `/leagues/:id`, from `listLeagues('mine')`, only
> when ≥1), a **`Start a League`** CTA that opens the create modal in place
> (item 3), and Sign out. The list is additive **above** the always-present CTA,
> so there's no loading flash. The `me`-exposure work (item 2) stands on its own.
>
> **Note:** the list keys off real **membership** (`/leagues?mine`). A user added
> only as an **email seat** (item 3) has a pending invite, not a membership, so
> their league won't appear here until invite acceptance is wired (item 4).

#### Definition of done (as shipped)
- [x] Signed-in aside shows account email + a **My Leagues** list (hyperlink per
      membership) + a `Start a League` CTA + Sign out.
- [x] No loading flash (list is additive above the permanent CTA).
- [x] Styled consistently with the existing newspaper aside (CSS Modules).
- [x] Built with **CSS Modules + React 18 + TypeScript** (project conventions).

### 2. AuthProvider should expose all of `/me`, not just `user`

`AuthProvider` fetches the full `MeResponse` but its context only re-exposes
`user` and `csrfToken` (`apps/web/src/auth/AuthProvider.tsx:14-18`, `86-90`),
discarding `identities` and `leagues` even though the network call already has
them. Expose the whole payload so consumers can read identity/membership
metadata without a second fetch.

#### Design (decided)
- Add `me: MeResponse | null` to the context as the full payload. **Keep** the
  existing `user` / `csrfToken` / `isLoading` fields as conveniences so the three
  current consumers don't break (`RequireAuth.tsx`, `useLeague.ts`,
  `LandingPage.tsx` — all read `user`/`isLoading`; none reads `csrfToken` off the
  context today). `isLoading` stays separate — it's query state, not part of `me`.
- `me.leagues` is the **routing hint** (membership rows, no name). It is *not* the
  source for rendered league lists — see item 1. Displaying leagues with detail
  still goes through `GET /leagues?mine` (`fantasyKeys.myLeagues`), which
  invalidates independently of `['me']`. Don't fold leagues into the `['me']`
  cache or collapse the two into one endpoint.

#### Files
- Edit: `apps/web/src/auth/AuthProvider.tsx` (`AuthState` interface + the
  context `value`).

#### Definition of done
- [x] `useAuth()` exposes the full `me: MeResponse | null` (incl. `identities`
      and `leagues`) alongside the existing `user` / `csrfToken` / `isLoading`.
- [x] Existing consumers (`RequireAuth`, `useLeague`, `LandingPage`) still
      compile and behave unchanged.
- [x] `me.leagues` is documented in-code as a routing hint only; league *display*
      remains sourced from `listLeagues('mine')` (item 1).

### 3. Create-league flow — `CreateLeagueModal` (full feature)

> **⚠ This outgrew "polish."** It now carries a backend feature + a migration.
> Kept here for continuity, but treat it as a real slice, not a polish nit.

A `CreateLeagueModal` (native `<dialog>`/`showModal()` — Escape-to-close + focus
trap for free, plus backdrop-click-to-close) opened **directly from the
homepage** `Start a League` CTA (item 1). It is no longer minimal:

- **Team name** — the commissioner's own team, set on their membership row.
- **Managers** — a dynamic seat list; each seat is a human invited by **email**
  or an **auto-manager (bot)** via a per-row toggle (the toggle disables that
  row's email field). League **capacity is derived** from the seat count
  (`1 + seats`, validated to land in 4–12, i.e. 3–11 seats).
- **Continuous season by default** — a toggle (default on) that maps to a long
  fixed season (`seasonLengthWeeks = 52`); toggle off to set a shorter run.
  Per decision, "continuous" is a **value, not a new league type**.
- On submit → `client.createLeague` → `POST /leagues`; on success invalidate
  `fantasyKeys.myLeagues` and route to the new `/leagues/:id`.

**Backend (data model done properly; no users yet ⇒ no back-compat shims):**
- `CreateLeagueRequest` gained `teamName` + `members[]` (`{ email?, isBot }`);
  `size` is now optional and **derived** server-side from `members`. Spec lives
  in `packages/shared-types/openapi.yaml` (regenerated, not hand-edited).
- `createLeague` orchestrates league + commissioner membership (with team name)
  + bot minting + per-email invites **in one transaction**. Bot minting was
  extracted to `fantasy/botMint.ts` (`mintBots`) and reused by `addBots` to
  avoid an import cycle.
- Migration `…024_fs_invite_email.sql` adds a nullable `fs_invite.email` so an
  invite is labelled by who it's for (NULL = the old anonymous share-link).

#### Files
- New: `apps/web/src/features/fantasy/CreateLeagueModal.tsx` + `.module.css`,
  `apps/api/src/fantasy/botMint.ts`,
  `apps/api/migrations/1700000000024_fs_invite_email.sql`.
- Edit: `apps/web/src/pages/LandingPage.tsx` (+ `.module.css`),
  `apps/web/src/api/client.ts` (`createLeague`), `packages/shared-types/openapi.yaml`,
  `apps/api/src/fantasy/leagues.ts`, `apps/api/src/fantasy/bots.ts`,
  `apps/api/src/routes/leagues/create.ts`, `apps/api/test/fantasy/leagues.test.ts`.

#### Definition of done
- [x] A signed-in user can create a league from the homepage modal (team name,
      email/bot seats, continuous default) and lands on its dashboard. (The
      brand-new *forming* league dashboard renders — `getMatchups`/`getStandings`
      return empty 200s and the dashboard has empty states; verified by code
      inspection, a live browser run is still pending.)
- [x] Capacity derived + validated (4–12); invalid emails rejected with a
      readable message; bots minted as auto-managers.
- [x] Data model done properly: `fs_invite.email` migration; team name persisted
      on the commissioner membership.
- [x] Domain tests cover the seat-list path (bots, labelled invites, capacity +
      email validation); `createLeague`/`addBots`/bots tests green.
- [x] Built with **CSS Modules + React 18 + TypeScript**.

### 4. Invite email **delivery** (stubbed — needs a mail transport)

Item 3 creates a labelled `fs_invite` row per human seat, but **nothing is
sent** — the API has no mail transport. Wire real delivery so invitees actually
get a link.

- Pick + configure a mail provider (provider choice + secret + deploy decision —
  outward-facing, needs the maintainer's call).
- Send each invite its join link on league creation (and a "resend" action).
- Surface the generated invite links in the UI in the meantime so a commissioner
  can share them manually.

#### Definition of done
- [ ] Creating a league emails each human seat a working join link.
- [ ] A commissioner can re-send / copy an invite link from the league view.
