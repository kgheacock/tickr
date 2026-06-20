/**
 * League dashboard shell (item 09 step 1). Owns the single `useLeague` instance
 * for a league and shares it with the nested team / waiver views via the
 * router's Outlet context, so the REST + live WS state is loaded once.
 */
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import {
  IconButton,
  Paper,
  Rule,
  Subhead,
  Tabs,
  TickerTape,
} from '../../components';
import { DEFAULT_SEASON, DEFAULT_WEEK, managerLabel } from './api';
import { SignedNumber } from './SignedNumber';
import { useLeague, type LeagueContext } from './useLeague';
import styles from './FantasyLayout.module.css';

/* Monotone editorial glyphs — single-weight strokes that read as copy-edit
   marks against the serif wordmark. All inherit `currentColor`. */
const ICON = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
} as const;
const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const PencilIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <path
      d="M14.5 5.5l4 4M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"
      {...stroke}
    />
  </svg>
);
const CheckIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <path d="M5 13l4 4L19 6" {...stroke} />
  </svg>
);
const CloseIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" {...stroke} />
  </svg>
);

/**
 * The masthead wordmark with an inline rename affordance. In view mode the team
 * name is the serif wordmark with a monotone pencil flexed to its right and a
 * dashed copy-edit underline on hover; clicking the pencil swaps to an editable
 * field flanked by a checkmark (persist) and an × (discard). Enter saves, Escape
 * discards. The pencil only renders when the viewer owns the team (`canEdit`).
 */
function TeamNameMasthead({
  name,
  canEdit,
  saving,
  onSave,
}: {
  name: string;
  canEdit: boolean;
  saving: boolean;
  onSave: (next: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Entering edit mode: seed the draft from the live name and select it so a
  // fresh name overwrites in one keystroke. Keyed on the edit transition only
  // (not `name`) so a concurrent live rename never stomps an open draft; we read
  // the latest `name` via the ref-free closure at the moment editing opens.
  const seed = useRef(name);
  seed.current = name;
  useEffect(() => {
    if (!editing) return;
    setDraft(seed.current);
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [editing]);

  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && !saving;

  const commit = async () => {
    if (!canSave) return;
    if (trimmed !== name) await onSave(trimmed);
    setEditing(false);
  };
  const cancel = () => setEditing(false);

  if (!editing) {
    return (
      <div className={styles.nameWrap}>
        <h1 className={`${styles.name} ${canEdit ? styles.editable : ''}`}>
          {name}
        </h1>
        {canEdit && (
          <span className={styles.anchor}>
            <IconButton
              size="sm"
              className={styles.pencil}
              aria-label="Rename team"
              onClick={() => setEditing(true)}
            >
              <PencilIcon />
            </IconButton>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`${styles.nameWrap} ${styles.editingWrap}`}>
      <input
        ref={inputRef}
        className={`${styles.name} ${styles.nameInput}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') cancel();
        }}
        aria-label="Team name"
        maxLength={60}
      />
      <span className={styles.editActions}>
        <IconButton
          size="sm"
          className={styles.confirm}
          aria-label="Save team name"
          onClick={() => void commit()}
          disabled={!canSave}
        >
          <CheckIcon />
        </IconButton>
        <IconButton
          size="sm"
          tone="danger"
          aria-label="Discard team name change"
          onClick={cancel}
          disabled={saving}
        >
          <CloseIcon />
        </IconButton>
      </span>
    </div>
  );
}

/** Roman numerals for the week flag and the founding year, to match the
 *  landing masthead's "Est. MMXXVI" treatment. Inputs are positive integers. */
function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let remaining = Math.max(0, Math.floor(n));
  let out = '';
  for (const [value, symbol] of table) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
}

export function FantasyLayout() {
  const { id = '' } = useParams();
  // Single-week server-side today; season fixed at 1. The week state is here so
  // a future schedule view can drive it without re-architecting.
  const [week] = useState(DEFAULT_WEEK);
  const ctx = useLeague(id, { week, season: DEFAULT_SEASON });

  // The masthead wordmark is the manager's team (their team name, or display
  // name until they've set one); the league flies in the standfirst below.
  const me = ctx.myUserId ? ctx.members.get(ctx.myUserId) : null;
  const teamName = me?.teamName ?? me?.displayName ?? 'My Team';
  const startYear = ctx.league
    ? new Date(ctx.league.createdAt).getFullYear()
    : null;

  // The standings band: every team's place + live weekly points, run as a
  // ticker tape under the masthead so the whole league is visible on any page.
  const tapeItems = ctx.ranking.map((r) => (
    <span className={styles.tapeItem}>
      <span className={styles.tapeTeam}>
        {managerLabel(ctx.members, r.userId)}
      </span>
      <SignedNumber value={r.totalPoints} />
    </span>
  ));

  if (ctx.error) {
    return (
      <Paper width="960px">
        <p className={styles.error}>
          Couldn&rsquo;t load this league. It may not exist, or you&rsquo;re not
          a member.
        </p>
      </Paper>
    );
  }

  return (
    <Paper width="960px">
      <header className={styles.header}>
        <div className={styles.masthead}>
          <NavLink to="/" className={styles.back}>
            ← Home
          </NavLink>
          <TeamNameMasthead
            name={teamName}
            canEdit={!!me}
            saving={ctx.renameTeam.isPending}
            onSave={(next) =>
              ctx.renameTeam.mutateAsync({
                userId: ctx.myUserId!,
                teamName: next,
              })
            }
          />
          {ctx.league && (
            <Subhead className={styles.week}>Week {toRoman(ctx.week)}</Subhead>
          )}
        </div>
        <Rule weight="heavy" className={styles.mastRule} />
        {ctx.league && (
          <Subhead className={styles.standfirst}>
            {ctx.league.name} Stock League · Est. {toRoman(startYear ?? 0)}
          </Subhead>
        )}
        <Rule weight="thin" />
        {tapeItems.length > 0 && (
          <TickerTape label="Standings" items={tapeItems} />
        )}
        <Tabs
          className={styles.nav}
          items={[
            { to: `/leagues/${id}`, label: 'Dashboard', end: true },
            { to: `/leagues/${id}/team`, label: 'My Team' },
            { to: `/leagues/${id}/players`, label: 'Waiver Wire' },
          ]}
        />
      </header>
      <main className={styles.body}>
        <Outlet context={ctx} />
      </main>
    </Paper>
  );
}

/** Typed accessor for the league context the layout shares with its routes. */
export function useLeagueContext(): LeagueContext {
  return useOutletContext<LeagueContext>();
}

export { managerLabel };
