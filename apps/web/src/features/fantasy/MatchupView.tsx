/**
 * Matchup view (item 09 step 5) — the manager's head-to-head with live per-slot
 * contributions for both teams, plus the rest of the week's scoreboard. Points
 * and breakdowns update from the `matchup` topic through the week (the hook
 * overlays `matchup.updated`); the Friday settle finalizes them.
 */
import type { Matchup, WeeklyScore } from '@tickr/shared-types';
import { managerLabel, SLOT_LABELS } from './api';
import { useLeagueContext } from './FantasyLayout';
import { fmtPercent, fmtPoints } from './points';
import styles from './MatchupView.module.css';

function TeamColumn({
  label,
  score,
  isWinner,
}: {
  label: string;
  score: WeeklyScore | undefined;
  isWinner: boolean;
}) {
  return (
    <div className={`${styles.team} ${isWinner ? styles.winner : ''}`}>
      <div className={styles.teamHead}>
        <span className={styles.teamName}>{label}</span>
        <span className={styles.teamTotal}>
          {fmtPoints(score?.totalPoints ?? null)}
        </span>
      </div>
      {score && score.breakdown.length > 0 ? (
        <ul className={styles.slotList}>
          {score.breakdown.map((b, i) => (
            <li key={`${b.slot}-${b.symbol}-${i}`} className={styles.slotRow}>
              <span className={styles.slotName}>
                {SLOT_LABELS[b.slot] ?? b.slot}
              </span>
              <span className={styles.slotSym}>{b.symbol}</span>
              <span className={styles.slotRet}>{fmtPercent(b.returnPct)}</span>
              <span
                className={`${styles.slotPts} ${b.points >= 0 ? styles.pos : styles.neg}`}
              >
                {fmtPoints(b.points)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>No started slots scored yet.</p>
      )}
    </div>
  );
}

export function MatchupView() {
  const ctx = useLeagueContext();
  const { matchups, scores, members, myMatchup, myUserId, provisional } = ctx;

  const scoreOf = (userId: string | null | undefined) =>
    userId ? scores.find((s) => s.userId === userId) : undefined;

  const others = matchups.filter((m) => m.id !== myMatchup?.id);

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <h2 className={styles.title}>Matchup</h2>
        {provisional && <span className={styles.live}>● live</span>}
      </div>

      {myMatchup == null ? (
        <p className={styles.empty}>No matchup scheduled for you this week.</p>
      ) : myMatchup.awayUserId == null ? (
        <p className={styles.empty}>
          Bye week — {managerLabel(members, myMatchup.homeUserId)} sits out.
        </p>
      ) : (
        <div className={styles.headToHead}>
          <TeamColumn
            label={
              myMatchup.homeUserId === myUserId
                ? 'You'
                : managerLabel(members, myMatchup.homeUserId)
            }
            score={scoreOf(myMatchup.homeUserId)}
            isWinner={myMatchup.winnerUserId === myMatchup.homeUserId}
          />
          <span className={styles.vs}>vs</span>
          <TeamColumn
            label={
              myMatchup.awayUserId === myUserId
                ? 'You'
                : managerLabel(members, myMatchup.awayUserId)
            }
            score={scoreOf(myMatchup.awayUserId)}
            isWinner={myMatchup.winnerUserId === myMatchup.awayUserId}
          />
        </div>
      )}

      {others.length > 0 && (
        <section className={styles.around}>
          <h3 className={styles.aroundHead}>Around the league</h3>
          <ul className={styles.aroundList}>
            {others.map((m: Matchup) => (
              <li key={m.id} className={styles.aroundRow}>
                <span className={styles.aroundTeam}>
                  {managerLabel(members, m.homeUserId)}
                </span>
                <span className={styles.aroundScore}>
                  {fmtPoints(m.homePoints)}
                </span>
                <span className={styles.aroundVs}>
                  {m.awayUserId == null ? 'bye' : '–'}
                </span>
                <span className={styles.aroundScore}>
                  {fmtPoints(m.awayPoints)}
                </span>
                <span className={styles.aroundTeam}>
                  {managerLabel(members, m.awayUserId)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
