# FS-09 · Dashboard & live following

**Status:** `pending` · **Epic:** [Fantasy Street](README.md) · **Depends on:** 04, 05, 06

## User stories
- As a manager, I want a dashboard showing my team, matchup, and standings, so
  that I can manage everything in one place.
- As a manager, I want to watch my matchup update through the week, so that
  following the action is fun.

## Goal

The **frontend surface** for the epic: a league dashboard that pulls together a
manager's roster/lineup (FS-04), weekly score breakdown (FS-05), current matchup
and standings (FS-06), and updates **live through the week** over the existing
WebSocket. This is the read/UI slice — it composes endpoints already built, plus
the live topics.

## Pre-reads
- [docs/06-frontend.md](../../docs/06-frontend.md) and `apps/web/src/` — the web
  app structure, routing, and API client conventions.
- `apps/web/src/api/`, `apps/web/src/lib/` — the existing fetch/WS client this
  reuses (auth cookie + CSRF already handled).
- `apps/api/src/ws/` + [16 step 4](../16-platformize-api.md) — the WS spine;
  note it currently carries only `universe`/`prices` topics, so FS adds league
  topics (`draft`, `matchup`/live score) in FS-03/05.
- CLAUDE.md tech prefs — **Semantic UI + CSS Modules, React 18, TypeScript**.

## Design decisions
- **Compose, don't re-fetch raw.** The dashboard reads the FS-04/05/06 endpoints
  (`/lineup`, `/scores`, `/matchups`, `/standings`) and subscribes to the
  league's live topics; no new backend domain logic.
- **Live following** uses the provisional in-week score (FS-05 step 6) pushed via
  the `matchup` topic; the Friday settle finalizes it.
- **One league context** — a `useLeague(leagueId)` hook centralizes the
  REST + WS state; pages render off it.

## Steps
1. **Routing + shell.** Add FS routes under `apps/web/src/features/fantasy/`:
   league list (`/leagues`), league dashboard (`/leagues/:id`), and sub-views
   (team, matchup, standings, players, draft). Wire into the app router.
2. **League context hook** (`features/fantasy/useLeague.ts`) — loads
   `LeagueView` + `/me.leagues`, opens the WS subscription to
   `{ kind: 'matchup', leagueId, week }` (and `draft` during a draft), exposes
   roster/lineup/score/matchup/standings state with live updates.
3. **Dashboard page** — at-a-glance: my matchup (live points, both lineups),
   my standings row, this week's lineup status (set/locked/auto-filled), quick
   links to set lineup / view players.
4. **Team & lineup view** — render the roster, the lineup editor (calls FS-04
   `PUT /lineup`), lock countdown to Monday open, and the FS-05 per-slot score
   breakdown once scored.
5. **Matchup view** — head-to-head with live per-slot contributions for both
   teams, updating from the `matchup` topic through the week.
6. **Standings view** — ranked table with the FS-06 tiebreaker columns; link to
   the schedule.
7. **Live wiring** — handle `score.updated` / `matchup` / `lineup.locked` /
   `waiver.processed` / `trade.accepted` messages to refresh the relevant slice
   without a full reload.
8. **Tests.** Jest + React Testing Library for the hook and key components;
   Playwright e2e: log in (dev-login), open a league dashboard, see a live score
   tick update the matchup.

## Files
- Create: `apps/web/src/features/fantasy/useLeague.ts`,
  `features/fantasy/Dashboard.tsx`, `TeamView.tsx`, `LineupEditor.tsx`,
  `MatchupView.tsx`, `StandingsView.tsx`, `*.module.css`,
  `apps/web/src/features/fantasy/api.ts` (FS endpoint client),
  `apps/web/e2e/fantasy-dashboard.spec.ts`.
- Edit: `apps/web/src/` router + nav; `apps/web/src/lib/` WS client (subscribe to
  FS topics) if topic plumbing isn't generic.

## Definition of done
- [ ] A manager opens their league dashboard and sees team, current matchup, and
      standings in one place.
- [ ] During the week the matchup view updates live (provisional scores) over the
      WS without a reload.
- [ ] The lineup editor sets a lineup and shows the lock countdown; after lock it
      is read-only.
- [ ] Standings and schedule render with correct tiebreaker columns.
- [ ] Built with Semantic UI + CSS Modules + React 18; e2e proves the live tick.
