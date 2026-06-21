/**
 * Dashboard (item 09 step 3) — the league's front page. Two newspaper "stories"
 * stacked: the current week's score leaderboard (live off the shared
 * `useLeague` context — the same `scores.updated` stream the rest of the app
 * follows), and the season-long win standings (a settled-only tally fetched
 * from `/wins`). Both are read-only boards; all the writes live on My Team.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Rule, Table } from '../../components';
import { client } from '../../api/client';
import { useLeagueContext, managerLabel } from './FantasyLayout';
import { fantasyKeys } from './api';
import { SignedNumber } from './SignedNumber';
import styles from './Dashboard.module.css';

export function Dashboard() {
  const ctx = useLeagueContext();
  const { leagueId, season, members, myUserId } = ctx;

  // The season win standings settle a week at a time, so they're a plain REST
  // read keyed by season — independent of the live weekly overlay above.
  const wins = useQuery({
    queryKey: fantasyKeys.wins(leagueId, season),
    queryFn: () => client.getSeasonWins(leagueId, season),
  });

  // In-week totals are provisional until the Friday close settles them; surface
  // that so a moving board isn't mistaken for the final result.
  const isLive = ctx.provisional || ctx.scores.some((s) => s.provisional);
  const winEntries = wins.data?.entries ?? [];
  const weeksCounted = wins.data?.weeks ?? 0;

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <div className={styles.head}>
          <h2 className={styles.headline}>The Leaderboard</h2>
          {ctx.ranking.length > 0 && (
            <Badge>{isLive ? 'Live · in progress' : 'Final'}</Badge>
          )}
        </div>
        <Rule weight="section" />
        <Table>
          <thead>
            <tr>
              <th className={styles.pos}>Pos</th>
              <th>Team</th>
              <th className={styles.num}>Points</th>
            </tr>
          </thead>
          <tbody>
            {ctx.ranking.length === 0 ? (
              <tr>
                <td className={styles.empty} colSpan={3}>
                  No scores yet — the board fills in as the week is played.
                </td>
              </tr>
            ) : (
              ctx.ranking.map((r) => {
                const mine = r.userId === myUserId;
                const label = managerLabel(members, r.userId);
                // The owner's name below the team name, as secondary text. Hidden
                // when it would just repeat the line above (no team name set, so
                // the label already is the display name).
                const owner = members.get(r.userId)?.displayName;
                const ownerLine = owner && owner !== label ? owner : null;
                return (
                  <tr
                    key={r.userId}
                    className={[
                      r.rank === 1 ? styles.leader : '',
                      mine ? styles.mine : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <td className={styles.pos}>{r.rank}</td>
                    <td className={styles.team}>
                      <span className={styles.teamLine}>
                        {label}
                        {mine && <span className={styles.youTag}>You</span>}
                      </span>
                      {ownerLine && (
                        <span className={styles.ownerName}>{ownerLine}</span>
                      )}
                    </td>
                    <td className={styles.num}>
                      <SignedNumber
                        value={r.totalPoints}
                        className={styles.points}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </section>

      <section className={styles.section}>
        <div className={styles.head}>
          <h2 className={styles.headline}>Win Leaders</h2>
          {weeksCounted > 0 && (
            <span className={styles.note}>
              {weeksCounted} {weeksCounted === 1 ? 'week' : 'weeks'} counted
            </span>
          )}
        </div>
        <Rule weight="section" />
        <Table>
          <thead>
            <tr>
              <th className={styles.pos}>Pos</th>
              <th>Team</th>
              <th className={styles.num}>Wins</th>
              <th className={styles.num}>Points For</th>
            </tr>
          </thead>
          <tbody>
            {winEntries.length === 0 ? (
              <tr>
                <td className={styles.empty} colSpan={4}>
                  {wins.isLoading
                    ? 'Tallying the season…'
                    : 'No wins yet — they tally up as each week settles.'}
                </td>
              </tr>
            ) : (
              winEntries.map((e, i) => {
                const mine = e.userId === myUserId;
                // Win standings carry no rank field; the array is pre-sorted, so
                // the place is the row index (ties keep their listed order).
                const leader = i === 0 && e.wins > 0;
                return (
                  <tr
                    key={e.userId}
                    className={[
                      leader ? styles.leader : '',
                      mine ? styles.mine : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <td className={styles.pos}>{i + 1}</td>
                    <td className={styles.team}>
                      {managerLabel(members, e.userId)}
                      {mine && <span className={styles.youTag}>You</span>}
                    </td>
                    <td className={`${styles.num} ${styles.wins}`}>{e.wins}</td>
                    <td className={styles.num}>
                      <SignedNumber value={e.pointsFor} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </section>
    </div>
  );
}
