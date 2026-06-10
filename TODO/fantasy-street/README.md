# Fantasy Street — epic (v2 league mode)

Parody fantasy football, but the "players" are stocks. Small groups (4–12)
**draft** the S&P 500 with **exclusive ownership** (one manager per ticker),
field a **weekly lineup** of position slots, and play **head-to-head** into
playoffs. Skill comes from drafting, start/sit, and trades; luck comes from the
weekly head-to-head schedule and real market variance. In-game, stocks are
surfaced as **players** — you scout an inventory, open a player's detail view,
and draft them onto your team.

**Track:** v2. Layered on the existing market-data corpus; does not replace the
perpetual platform. See the [root TODO README](../README.md) → "Epics (v2+)".

**Status legend:** `pending` / `in-progress` / `done`. This epic is `pending`
(outline). Each item below is a vertical slice ≈ one focused PR, bundling 3–7
user stories — same slicing rationale as v1.

## Items

| # | Item | Depends on | Status |
|---|---|---|---|
| 00 | [UI groundwork (light theme & login surface)](00-ui-groundwork.md) | platform auth | done ([#48](https://github.com/kgheacock/tickr/pull/48)) |
| 01 | [Leagues & membership](01-leagues-and-membership.md) | platform auth | pending |
| 02 | [Players & grouping](02-players-and-grouping.md) | corpus | pending |
| 03 | [Live draft](03-live-draft.md) | 01, 02 | pending |
| 04 | [Rosters & weekly lineups](04-rosters-and-lineups.md) | 03 | pending |
| 05 | [Scoring & shorting](05-scoring-and-shorting.md) | 02, 04 | pending |
| 06 | [Matchups, schedule & standings](06-matchups-and-standings.md) | 03, 05 | pending |
| 07 | [Waivers & trades](07-waivers-and-trades.md) | 04, 06 | pending |
| 08 | [Season & playoffs](08-season-and-playoffs.md) | 06 | pending |
| 09 | [Dashboard & live following](09-dashboard.md) | 04, 05, 06 | pending |
| 10 | [Auto-managers (bots)](10-auto-managers.md) | 03, 04 | pending |
| 11 | [Reminders & recaps](11-reminders-and-recaps.md) | 04, 05, 06 | pending |
| 12 | [Commissioner & admin tools](12-commissioner-and-admin.md) | 01 | pending |

## Dependency graph (at a glance)

```
01 leagues ─┐
02 players ─┴─▶ 03 draft ─▶ 04 lineups ─▶ 05 scoring+shorting ─▶ 06 matchups ─▶ 08 playoffs
                 │                            │                      │
                 └─▶ 10 bots                  └──────────┬───────────┘
                                                         │
04, 06 ─▶ 07 waivers/trades                              ▼
04, 05, 06 ─▶ 09 dashboard                      11 reminders & recaps
01 ─▶ 12 commissioner/admin
```

---

## Locked decisions

| Dimension | Decision |
|---|---|
| Cadence | **Weekly** matchups; lineups lock **Monday at market open**, frozen all week |
| Draft | **Live snake draft**, timed picks; **auto-draft** covers offline/missed picks |
| Roster slots | Anchor · Growth · Momentum · Value · **Defense (short)** · Wildcard + shallow bench |
| Scoring | Sum of **started** stocks' weekly % return ×10; **losses count fully** |
| Defense slot | **Short only** — scored as the inverse of the stock's return |
| Variance cap | **Uncapped for now** (no mercy cap) |
| Anti-"benching cash" | **Mandatory fixed slots** + auto-fill; the only choice is *which* stock fills each slot |

## Scoring rules (canonical reference)

Product rules behind items 05/06/11 — not implementation detail. Weekly return
`r` = (this Friday close − last Friday close) / last Friday close, as a percent.

```
long slot points     =  r × 10
defense (short) pts   = −r × 10        (positive when the shorted stock falls)
weekly total          = sum of all started slots   (losses included, uncapped)
```

**Shorting, worked through:**

| Defense pick | Weekly return | Defense points |
|---|---|---|
| short TSLA | −4% | **+40** |
| short TSLA | +4% | −40 |
| short a stock that goes to ~0 / delists | −100% | **+1000** (gain floored at 0) |
| short a stock that squeezes | +30% | **−300** (loss unbounded — the "pick-six") |

- **Asymmetric on purpose:** a short's gain caps near +100%, its loss is
  unbounded — a squeeze is a high-luck swing. Uncapped for now keeps the drama.
- **Equal weight, no leverage:** every slot is one unit; a short of |x%| swings
  the same as a long of |x%|.
- **Exclusive ownership applies:** a short is a normal draft pick flagged short,
  so that ticker is off the board for everyone.
- **Deferred realism (not now):** borrow cost, dividend liability on shorts,
  halted/delisted settlement rules.

## Open questions (decide before building)

1. **Catalyst bonuses** — earnings-beat / 52-week-high bonuses in v1, or pure
   price-return first? (Cleanest anti-benching nudge, but needs an earnings feed.)
2. **Mercy cap** — uncapped for now; when, if ever, does it turn on and at what
   per-slot limit?
3. **Long-vs-short ownership** — confirm a ticker is one manager's long *or* one
   manager's short, never both.
4. **Slot eligibility** — how strictly to classify growth/momentum/value/cap
   tier, and from what data.
5. **Scoring scale** — ×10 is cosmetic; confirm the point feel.
