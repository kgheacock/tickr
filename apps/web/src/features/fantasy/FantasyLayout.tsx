/**
 * League dashboard shell (item 09 step 1). Owns the single `useLeague` instance
 * for a league and shares it with the nested team / matchup / standings views
 * via the router's Outlet context, so the REST + live WS state is loaded once.
 */
import { useState } from 'react';
import { NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { Paper, Rule, Subhead, Tabs } from '../../components';
import { DEFAULT_SEASON, DEFAULT_WEEK, managerLabel } from './api';
import { useLeague, type LeagueContext } from './useLeague';
import styles from './FantasyLayout.module.css';

/** Roman numerals for the week label, to match the landing masthead's
 *  "Est. MMXXVI" treatment. Weeks are small positive integers. */
function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let remaining = Math.max(0, Math.floor(n));
  let out = '';
  for (const [value, symbol] of table) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
}

export function FantasyLayout() {
  const { id = '' } = useParams();
  // Single-week server-side today; season fixed at 1. The week state is here so
  // a future schedule view can drive it without re-architecting.
  const [week] = useState(DEFAULT_WEEK);
  const ctx = useLeague(id, { week, season: DEFAULT_SEASON });

  if (ctx.error) {
    return (
      <Paper width="960px">
        <p className={styles.error}>
          Couldn&rsquo;t load this league. It may not exist, or you&rsquo;re not
          a member.
        </p>
      </Paper>
    );
  }

  return (
    <Paper width="960px">
      <header className={styles.header}>
        <div className={styles.masthead}>
          <NavLink to="/" className={styles.back}>
            ← Home
          </NavLink>
          <h1 className={styles.name}>{ctx.league?.name ?? 'League'}</h1>
          {ctx.league && (
            <Subhead className={styles.week}>Week {toRoman(ctx.week)}</Subhead>
          )}
        </div>
        <Tabs
          className={styles.nav}
          items={[
            { to: `/leagues/${id}`, label: 'Dashboard', end: true },
            { to: `/leagues/${id}/team`, label: 'My Team' },
            { to: `/leagues/${id}/players`, label: 'Waiver Wire' },
            { to: `/leagues/${id}/matchup`, label: 'Matchup' },
            { to: `/leagues/${id}/standings`, label: 'Standings' },
          ]}
        />
      </header>
      <Rule weight="heavy" className={styles.headRule} />
      <main className={styles.body}>
        <Outlet context={ctx} />
      </main>
    </Paper>
  );
}

/** Typed accessor for the league context the layout shares with its routes. */
export function useLeagueContext(): LeagueContext {
  return useOutletContext<LeagueContext>();
}

export { managerLabel };
