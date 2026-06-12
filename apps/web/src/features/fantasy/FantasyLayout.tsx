/**
 * League dashboard shell (item 09 step 1). Owns the single `useLeague` instance
 * for a league and shares it with the nested team / matchup / standings views
 * via the router's Outlet context, so the REST + live WS state is loaded once.
 */
import { useState } from 'react';
import { NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { DEFAULT_SEASON, DEFAULT_WEEK, managerLabel } from './api';
import { useLeague, type LeagueContext } from './useLeague';
import styles from './FantasyLayout.module.css';

export function FantasyLayout() {
  const { id = '' } = useParams();
  // Single-week server-side today; season fixed at 1. The week state is here so
  // a future schedule view can drive it without re-architecting.
  const [week] = useState(DEFAULT_WEEK);
  const ctx = useLeague(id, { week, season: DEFAULT_SEASON });

  if (ctx.error) {
    return (
      <div className={styles.shell}>
        <p className={styles.error}>
          Couldn&rsquo;t load this league. It may not exist, or you&rsquo;re not
          a member.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <NavLink to="/leagues" className={styles.back}>
            ← Leagues
          </NavLink>
          <span
            className={`${styles.live} ${ctx.connected ? styles.liveOn : styles.liveOff}`}
            title={ctx.connected ? 'Live' : 'Reconnecting…'}
          >
            {ctx.connected ? '● Live' : '○ Offline'}
          </span>
        </div>
        <h1 className={styles.name}>{ctx.league?.name ?? 'League'}</h1>
        <p className={styles.meta}>
          {ctx.league ? (
            <>
              {ctx.league.members.length}/{ctx.league.size} managers ·{' '}
              <span className={styles.status}>{ctx.league.status}</span> · Week{' '}
              {ctx.week}
            </>
          ) : (
            'Loading…'
          )}
        </p>
        <nav className={styles.nav}>
          <NavLink
            to={`/leagues/${id}`}
            end
            className={({ isActive }) =>
              isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab
            }
          >
            Dashboard
          </NavLink>
          <NavLink
            to={`/leagues/${id}/team`}
            className={({ isActive }) =>
              isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab
            }
          >
            My Team
          </NavLink>
          <NavLink
            to={`/leagues/${id}/matchup`}
            className={({ isActive }) =>
              isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab
            }
          >
            Matchup
          </NavLink>
          <NavLink
            to={`/leagues/${id}/standings`}
            className={({ isActive }) =>
              isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab
            }
          >
            Standings
          </NavLink>
        </nav>
      </header>
      <main className={styles.body}>
        <Outlet context={ctx} />
      </main>
    </div>
  );
}

/** Typed accessor for the league context the layout shares with its routes. */
export function useLeagueContext(): LeagueContext {
  return useOutletContext<LeagueContext>();
}

export { managerLabel };
