/**
 * Team & lineup view (item 09 step 4) — the lock countdown to Monday open, the
 * lineup editor, and (once the week is scored) the per-slot FS-05 breakdown.
 */
import { useEffect, useState } from 'react';
import { SLOT_LABELS } from './api';
import { useLeagueContext } from './FantasyLayout';
import { LineupEditor } from './LineupEditor';
import { fmtPercent, fmtPoints } from './points';
import styles from './TeamView.module.css';

// Lineups lock Monday at market open (9:30 ET). Mirror lock.ts / matchups.ts'
// fixed ET-standard offset (UTC-5) for the countdown — exact to the minute is
// not the point; the server-side lock job is authoritative.
const ET_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function nextMondayOpen(now: Date): Date {
  const et = new Date(now.getTime() - ET_OFFSET_MS);
  const daysUntilMonday = (1 - et.getUTCDay() + 7) % 7 || 7;
  const open = new Date(et);
  open.setUTCDate(et.getUTCDate() + daysUntilMonday);
  open.setUTCHours(9, 30, 0, 0);
  return new Date(open.getTime() + ET_OFFSET_MS);
}

function countdown(ms: number): string {
  if (ms <= 0) return 'locking…';
  const d = Math.floor(ms / DAY_MS);
  const h = Math.floor((ms % DAY_MS) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function TeamView() {
  const ctx = useLeagueContext();
  const { lineup, scores, myUserId } = ctx;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const myScore = scores.find((s) => s.userId === myUserId);

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <h2 className={styles.title}>My Team</h2>
        {lineup && !lineup.locked && (
          <span className={styles.lockClock}>
            Locks in {countdown(nextMondayOpen(new Date(now)).getTime() - now)}
          </span>
        )}
      </div>

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
                  <td>
                    {SLOT_LABELS[b.slot] ?? b.slot}
                    {b.isShort && (
                      <span className={styles.shortTag}>short</span>
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
