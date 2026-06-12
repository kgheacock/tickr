/**
 * Dashboard (item 09 step 3) — at-a-glance: my live matchup, my standings row,
 * this week's lineup status, and quick links into the team / matchup views.
 * Pure composition over the league context; no fetches of its own.
 */
import { Link } from 'react-router-dom';
import { managerLabel } from './api';
import { useLeagueContext } from './FantasyLayout';
import { fmtPoints } from './points';
import styles from './Dashboard.module.css';

export function Dashboard() {
  const ctx = useLeagueContext();
  const { league, members, myUserId, myMatchup, myStanding, lineup } = ctx;

  if (!league) return <p className={styles.loading}>Loading dashboard…</p>;

  const oppId =
    myMatchup == null
      ? null
      : myMatchup.homeUserId === myUserId
        ? (myMatchup.awayUserId ?? null)
        : myMatchup.homeUserId;
  const myPoints =
    myMatchup == null
      ? null
      : myMatchup.homeUserId === myUserId
        ? myMatchup.homePoints
        : myMatchup.awayPoints;
  const oppPoints =
    myMatchup == null
      ? null
      : myMatchup.homeUserId === myUserId
        ? myMatchup.awayPoints
        : myMatchup.homePoints;

  const lineupStatus = lineup?.locked
    ? lineup.autoFilled
      ? 'Locked (auto-filled)'
      : 'Locked'
    : lineup?.slots.length
      ? 'Set — editable until Monday open'
      : 'Not set';

  return (
    <div className={styles.grid}>
      <section className={styles.card}>
        <h2 className={styles.cardHead}>This Week&rsquo;s Matchup</h2>
        {myMatchup == null ? (
          <p className={styles.empty}>No matchup scheduled yet.</p>
        ) : oppId == null ? (
          <p className={styles.empty}>
            Bye week — you sit out, no contest.{' '}
            <span className={styles.score}>{fmtPoints(myPoints)}</span>
          </p>
        ) : (
          <div className={styles.scoreboard}>
            <div className={styles.side}>
              <span className={styles.team}>You</span>
              <span className={styles.score}>{fmtPoints(myPoints)}</span>
            </div>
            <span className={styles.vs}>vs</span>
            <div className={styles.side}>
              <span className={styles.team}>
                {managerLabel(members, oppId)}
              </span>
              <span className={styles.score}>{fmtPoints(oppPoints)}</span>
            </div>
          </div>
        )}
        {ctx.provisional && myMatchup != null && (
          <p className={styles.provisional}>
            Live · provisional through the week
          </p>
        )}
        <Link to={`/leagues/${league.id}/matchup`} className={styles.link}>
          View matchup →
        </Link>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardHead}>My Standing</h2>
        {myStanding == null ? (
          <p className={styles.empty}>Standings open after the first week.</p>
        ) : (
          <p className={styles.standingLine}>
            <span className={styles.rank}>#{myStanding.rank}</span>{' '}
            {myStanding.wins}–{myStanding.losses}
            {myStanding.ties > 0 ? `–${myStanding.ties}` : ''} ·{' '}
            {fmtPoints(myStanding.pointsFor)} PF
          </p>
        )}
        <Link to={`/leagues/${league.id}/standings`} className={styles.link}>
          View standings →
        </Link>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardHead}>My Lineup</h2>
        <p className={styles.standingLine}>{lineupStatus}</p>
        <Link to={`/leagues/${league.id}/team`} className={styles.link}>
          {lineup?.locked ? 'View team →' : 'Set lineup →'}
        </Link>
      </section>
    </div>
  );
}
