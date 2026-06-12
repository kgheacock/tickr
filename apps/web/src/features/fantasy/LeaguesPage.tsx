/**
 * League list (item 09 step 1) — the entry point into the dashboard: the
 * leagues the manager belongs to, each linking to its dashboard. Open leagues
 * to join are out of scope for this read slice (creation/join live in FS-01).
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { client } from '../../api/client';
import { fantasyKeys } from './api';
import styles from './LeaguesPage.module.css';

export function LeaguesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: fantasyKeys.myLeagues,
    queryFn: () => client.listLeagues('mine'),
  });

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <Link to="/" className={styles.back}>
          ← tickr
        </Link>
        <h1 className={styles.title}>My Leagues</h1>
      </header>

      {isLoading ? (
        <p className={styles.note}>Loading leagues…</p>
      ) : error ? (
        <p className={styles.note}>Couldn&rsquo;t load your leagues.</p>
      ) : !data || data.items.length === 0 ? (
        <p className={styles.note}>
          You&rsquo;re not in any leagues yet. Ask a commissioner for an invite.
        </p>
      ) : (
        <ul className={styles.list}>
          {data.items.map((l) => (
            <li key={l.id} className={styles.row}>
              <Link to={`/leagues/${l.id}`} className={styles.league}>
                <span className={styles.leagueName}>{l.name}</span>
                <span className={styles.leagueMeta}>
                  {l.memberCount}/{l.size} managers ·{' '}
                  <span className={styles.status}>{l.status}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
