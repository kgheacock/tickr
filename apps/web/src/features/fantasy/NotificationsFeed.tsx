/**
 * League feed (item 11) — the manager's reminders and weekly recaps, newest
 * first, surfaced on the dashboard and updated live over WS. Reminders nudge the
 * manager before the Monday lock / a scheduled draft; recaps recount the settled
 * week (weekly placement, biggest mover & blowup, league high/low) from the
 * FS-05 breakdown. Read state is per-notification; tapping one marks it read.
 */
import { useMemo } from 'react';
import type {
  LeagueMember,
  Notification,
  RecapPayload,
} from '@tickr/shared-types';
import { managerLabel } from './api';
import { SignedNumber } from './SignedNumber';
import { useNotifications } from './useNotifications';
import styles from './NotificationsFeed.module.css';

const KIND_LABEL: Record<Notification['kind'], string> = {
  lineup_reminder: 'Reminder',
  draft_reminder: 'Draft',
  recap: 'Recap',
};

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th"… */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function RecapBody({
  payload,
  members,
}: {
  payload: RecapPayload;
  members: Map<string, LeagueMember>;
}) {
  const isLeader = payload.rank === 1;
  return (
    <div className={styles.recap}>
      <p className={styles.recapHead}>
        <span className={isLeader ? styles.rankTop : styles.rank}>
          {ordinal(payload.rank)} of {payload.fieldSize}
        </span>{' '}
        <>
          week {payload.week} — <SignedNumber value={payload.myScore} /> pts
        </>
      </p>
      <dl className={styles.recapStats}>
        {payload.biggestMover && (
          <div>
            <dt>Top mover</dt>
            <dd>
              {payload.biggestMover.symbol}{' '}
              <SignedNumber value={payload.biggestMover.points} />
            </dd>
          </div>
        )}
        {payload.biggestBlowup && (
          <div>
            <dt>Blowup</dt>
            <dd>
              {payload.biggestBlowup.symbol}{' '}
              <SignedNumber value={payload.biggestBlowup.points} />
            </dd>
          </div>
        )}
        <div>
          <dt>League high</dt>
          <dd>
            {managerLabel(members, payload.leagueHigh.userId)} ·{' '}
            <SignedNumber value={payload.leagueHigh.totalPoints} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

function body(
  n: Notification,
  members: Map<string, LeagueMember>,
): React.ReactNode {
  switch (n.kind) {
    case 'lineup_reminder':
      return (
        <p className={styles.reminder}>
          Your lineup isn&rsquo;t set — fill it before Monday&rsquo;s open or
          it&rsquo;s auto-filled for you.
        </p>
      );
    case 'draft_reminder':
      return (
        <p className={styles.reminder}>
          Your draft is scheduled. Get ready — picks go live when the
          commissioner starts it.
        </p>
      );
    case 'recap':
      return (
        <RecapBody
          payload={n.payload as unknown as RecapPayload}
          members={members}
        />
      );
  }
}

export function NotificationsFeed({
  leagueId,
  members,
}: {
  leagueId: string;
  members: Map<string, LeagueMember>;
}) {
  const { notifications, unread, isLoading, markRead } =
    useNotifications(leagueId);
  const items = useMemo(() => notifications.slice(0, 20), [notifications]);

  return (
    <section className={styles.card}>
      <h2 className={styles.cardHead}>
        League Feed
        {unread > 0 && <span className={styles.badge}>{unread}</span>}
      </h2>
      {isLoading ? (
        <p className={styles.empty}>Loading feed…</p>
      ) : items.length === 0 ? (
        <p className={styles.empty}>No reminders or recaps yet.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((n) => (
            <li
              key={n.id}
              className={n.readAt == null ? styles.unread : styles.item}
            >
              <div className={styles.meta}>
                <span className={styles.kind}>{KIND_LABEL[n.kind]}</span>
                <span className={styles.when}>{fmtWhen(n.createdAt)}</span>
              </div>
              {body(n, members)}
              {n.readAt == null && (
                <button
                  type="button"
                  className={styles.markRead}
                  onClick={() => markRead.mutate(n.id)}
                  disabled={markRead.isPending}
                >
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
