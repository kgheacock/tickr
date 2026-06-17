/**
 * Team & lineup view (item 09 step 4) — the lineup editor and (once the week is
 * scored) the per-slot FS-05 breakdown.
 */
import { SLOT_LABELS, isPlayerGroup } from './api';
import { useLeagueContext } from './FantasyLayout';
import { LineupEditor } from './LineupEditor';
import { CategoryChip } from '../../components';
import { fmtPercent, fmtPoints } from './points';
import styles from './TeamView.module.css';

export function TeamView() {
  const ctx = useLeagueContext();
  const { scores, myUserId } = ctx;

  const myScore = scores.find((s) => s.userId === myUserId);

  return (
    <div className={styles.view}>
      <LineupEditor ctx={ctx} />

      {myScore && myScore.breakdown.length > 0 && (
        <section className={styles.breakdown}>
          <h3 className={styles.breakdownHead}>
            Week {ctx.week} score{' '}
            <span className={styles.total}>
              {fmtPoints(myScore.totalPoints)}
            </span>
            {myScore.provisional && (
              <span className={styles.prov}>provisional</span>
            )}
          </h3>
          <table className={styles.scoreTable}>
            <thead>
              <tr>
                <th>Slot</th>
                <th>Stock</th>
                <th className={styles.num}>Return</th>
                <th className={styles.num}>Points</th>
              </tr>
            </thead>
            <tbody>
              {myScore.breakdown.map((b, i) => (
                <tr key={`${b.slot}-${b.symbol}-${i}`}>
                  <td className={styles.slotName}>
                    {isPlayerGroup(b.slot) ? (
                      <CategoryChip group={b.slot}>
                        {SLOT_LABELS[b.slot] ?? b.slot}
                      </CategoryChip>
                    ) : (
                      (SLOT_LABELS[b.slot] ?? b.slot)
                    )}
                  </td>
                  <td>{b.symbol}</td>
                  <td className={styles.num}>{fmtPercent(b.returnPct)}</td>
                  <td
                    className={`${styles.num} ${b.points >= 0 ? styles.pos : styles.neg}`}
                  >
                    {fmtPoints(b.points)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
