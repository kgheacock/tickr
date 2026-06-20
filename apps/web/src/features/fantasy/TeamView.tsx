/**
 * Team & lineup view (item 09 step 4) — a masthead with the team's running
 * week total (in-progress in-week, settled after the Friday close) above the
 * lineup editor.
 */
import { useLeagueContext } from './FantasyLayout';
import { LineupEditor } from './LineupEditor';
import styles from './TeamView.module.css';

export function TeamView() {
  const ctx = useLeagueContext();

  return (
    <div className={styles.view}>
      <LineupEditor ctx={ctx} />
    </div>
  );
}
