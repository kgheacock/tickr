/**
 * Standings view (item 09 step 6) — the ranked table with the FS-06 tiebreaker
 * columns (W-L-T, points for / against) exposed, plus the week's schedule of
 * head-to-heads beneath it.
 */
import { managerLabel } from './api';
import { useLeagueContext } from './FantasyLayout';
import { fmtPoints } from './points';
import styles from './StandingsView.module.css';

export function StandingsView() {
  const ctx = useLeagueContext();
  const { standings, members, matchups, myUserId } = ctx;

  return (
    <div className={styles.view}>
      <h2 className={styles.title}>Standings</h2>
      {standings.length === 0 ? (
        <p className={styles.empty}>
          Standings open once the first week settles.
        </p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.num}>#</th>
              <th>Manager</th>
              <th className={styles.num}>W</th>
              <th className={styles.num}>L</th>
              <th className={styles.num}>T</th>
              <th className={styles.num}>PF</th>
              <th className={styles.num}>PA</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((s) => (
              <tr
                key={s.userId}
                className={s.userId === myUserId ? styles.me : ''}
              >
                <td className={styles.num}>{s.rank}</td>
                <td>{managerLabel(members, s.userId)}</td>
                <td className={styles.num}>{s.wins}</td>
                <td className={styles.num}>{s.losses}</td>
                <td className={styles.num}>{s.ties}</td>
                <td className={styles.num}>{fmtPoints(s.pointsFor)}</td>
                <td className={styles.num}>{fmtPoints(s.pointsAgainst)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className={styles.schedule}>
        <h3 className={styles.scheduleHead}>Week {ctx.week} schedule</h3>
        {matchups.length === 0 ? (
          <p className={styles.empty}>No matchups scheduled.</p>
        ) : (
          <ul className={styles.scheduleList}>
            {matchups.map((m) => (
              <li key={m.id} className={styles.scheduleRow}>
                <span>{managerLabel(members, m.homeUserId)}</span>
                <span className={styles.vs}>
                  {m.awayUserId == null ? 'bye' : 'vs'}
                </span>
                <span>
                  {m.awayUserId == null
                    ? '—'
                    : managerLabel(members, m.awayUserId)}
                </span>
                <span className={styles.statusTag}>{m.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
