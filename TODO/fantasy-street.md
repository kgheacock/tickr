# Fantasy Street — seasonal head-to-head stock league (epic outline)

**Status:** `idea` — outline only. Each feature below is a cluster of **user
stories**, not a build plan. When greenlit, these become numbered TODO items.

**Track:** v2 game mode. The [v1 README](README.md) scopes "seasons" out of v1;
Fantasy Street **is** that seasons concept, layered on the existing market-data
corpus. Background: [docs/00-overview.md](../docs/00-overview.md),
[docs/04-game-mechanics.md](../docs/04-game-mechanics.md).

---

## Concept

Parody fantasy football, but the "players" are stocks. Small groups (4–12)
**draft** the S&P 500 with **exclusive ownership** (one manager per ticker),
field a **weekly lineup** of position-typed slots, and play **head-to-head**
into playoffs. Skill comes from drafting, start/sit, and trades; luck comes
from the weekly head-to-head schedule and real market variance.

In-game, stocks are surfaced as **players**: you scout an inventory, open a
player's detail view, and draft them onto your team.

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

---

## User stories

### Players (stocks)
- As a manager, I want to browse the full inventory of players (stocks), so
  that I can scout who to draft or pick up.
- As a manager, I want to filter the inventory by group (anchor, growth,
  momentum, value, defense, wildcard) and see who's already owned, so that I
  can find candidates for a specific slot.
- As a manager, I want to open a player's detail view — recent performance,
  price history, the slots they qualify for, and their ownership status — so
  that I can make an informed pick.

### Leagues & membership
- As a manager, I want to create a league and invite 3–11 friends, so that we
  can compete in a small private group.
- As a manager, I want to join a league from an invite, so that I can take part
  without setup hassle.
- As a manager, I want to find and look up open leagues, so that I can join a
  game even without a direct invite.
- As a commissioner, I want to set league size, season length, and roster
  slots, so that the league fits our group.

### Positions & ownership
- As a manager, I want each stock to be ownable by only one person in my
  league, so that drafting involves real scarcity and competition.
- As a manager, I want defined roster positions (anchor, growth, momentum,
  value, defense, wildcard), so that I must build a balanced team instead of
  grabbing only the hottest names.
- As a manager, I want to see which stocks are eligible for each slot, so that
  I know my options while drafting and setting lineups.

### The draft
- As a manager, I want to join a live draft where we take turns picking stocks,
  so that drafting is a shared, social event.
- As a manager, I want a pick timer and a live draft board, so that the draft
  keeps moving and I can see what's been taken.
- As a manager, I want a sensible stock auto-picked for me if I'm offline or
  out of time, so that the draft isn't held up and I'm never left with an empty
  roster.

### Rosters & weekly lineups
- As a manager, I want to set my starting lineup each week from my roster, so
  that I decide who plays.
- As a manager, I want my lineup to lock when the market opens Monday, so that
  everyone commits before the week plays out.
- As a manager, I want any slot I forget to set to be auto-filled with my best
  option, so that I never field an empty slot.
- As a manager, I want only a few bench spots, so that start/sit choices are
  meaningful commitments rather than free insurance.

### Scoring
- As a manager, I want my weekly score to come from how my started stocks moved
  that week, so that good picks are rewarded.
- As a manager, I want losses to count against me, so that risky picks carry
  real downside and a balanced team matters.
- As a manager, I want to see how each slot contributed to my weekly score, so
  that I understand why I won or lost.

### Shorting (the Defense slot)
- As a manager, I want my Defense slot to be a short that earns points when the
  stock falls, so that I can profit in down markets and hedge my team.
- As a manager, I want shorting a name to use up that stock for the whole
  league, so that betting against a stock is a real strategic tradeoff.
- As a manager, I want a short squeeze to genuinely hurt, so that the Defense
  slot carries real risk, not free insurance.

### Matchups, schedule & standings
- As a manager, I want to face one opponent each week and win or lose on total
  points, so that a great week can still lose to a luckier one.
- As a manager, I want a season schedule, so that I know who I play and when.
- As a manager, I want standings with clear tiebreakers, so that I can track my
  playoff position.

### Waivers & trades
- As a manager, I want to pick up undrafted stocks during the season, so that I
  can adapt as the market moves.
- As a manager, I want waiver priority to favor lower-ranked managers, so that
  the league stays competitive.
- As a manager, I want to propose and accept trades with other managers, so
  that I can reshape my team mid-season.

### Season & playoffs
- As a manager, I want a short regular season followed by playoffs, so that the
  season stays exciting and the best teams are tested.
- As a manager, I want a champion crowned and past seasons remembered, so that
  bragging rights carry over year to year.

### Spectating & following along
- As a manager, I want a dashboard showing my team, matchup, and standings, so
  that I can manage everything in one place.
- As a manager, I want to watch my matchup update through the week, so that
  following the action is fun.

### Filling out a league
- As a commissioner, I want to fill empty spots with auto-managers, so that we
  can play even without a full group.

### Reminders & recaps
- As a manager, I want a reminder each week to set my team before the Monday
  lock, so that I never get auto-filled by accident.
- As a manager, I want a reminder when the draft is about to start, so that I
  don't miss it.
- As a manager, I want a weekly recap of my matchup and the league — final
  scores, biggest movers, notable wins and blowups — so that I can relive the
  week and keep tabs on my rivals.

### Running the league
- As a commissioner, I want to manage settings, resolve scoring disputes, and
  advance the season, so that I can keep the league fair and running.

---

## Scoring rules (reference)

Product rules behind the stories above — not implementation detail.

Weekly return `r` = (this Friday close − last Friday close) / last Friday
close, as a percent.

```
long slot points     =  r × 10
defense (short) pts   = −r × 10        (you score positive when the stock falls)
weekly total          = sum of all started slots   (losses included, uncapped)
```

**Shorting, worked through:**

| Defense pick | Weekly return | Defense points |
|---|---|---|
| short TSLA | −4% | **+40** |
| short TSLA | +4% | −40 |
| short a stock that goes to ~0 / delists | −100% | **+1000** (gain is floored at 0) |
| short a stock that squeezes | +30% | **−300** (loss is unbounded — the "pick-six") |

- **Asymmetric on purpose:** a short's gain caps near +100% (a stock can only
  fall to 0) but its loss is unbounded — a squeeze is a high-luck swing.
  Uncapped for now keeps that drama.
- **Equal weight, no leverage:** every slot is one unit; a short of |x%| swings
  the same as a long of |x%|.
- **Exclusive ownership applies:** a short is a normal draft pick flagged short,
  so that ticker is then off the board for everyone — spend a pick to bet
  against a name, or let a rival roster it long.
- **Deferred realism (not now):** borrow cost, dividend liability on shorts,
  and halted/delisted settlement rules.

---

## Open questions (decide before building)

1. **Catalyst bonuses** — add earnings-beat / 52-week-high bonuses, or ship
   pure price-return first? (Cleanest anti-benching nudge, but needs an
   earnings feed.)
2. **Mercy cap** — uncapped for now; when, if ever, does it turn on and at what
   per-slot limit?
3. **Long-vs-short ownership** — confirm a ticker is one manager's long *or* one
   manager's short, never both.
4. **Slot eligibility** — how strictly to classify growth/momentum/value/cap
   tier, and from what data.
5. **Scoring scale** — ×10 is cosmetic; confirm the point feel.

---

## Rough order

Leagues → positions/ownership → player inventory & detail → live draft →
rosters & lineups → scoring (with shorting) → matchups & standings → waivers &
trades → season & playoffs. Dashboard spans all of it; auto-managers,
reminders & recaps, and commissioner tools are cross-cutting. Split into
numbered TODO items and add them under a v2 section of the
[README](README.md) when this is greenlit.
