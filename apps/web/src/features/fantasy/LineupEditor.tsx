/**
 * Lineup editor (item 09 step 4). Per the locked anti-"benching cash" decision,
 * the only choice is *which* owned stock fills each mandatory slot — so the
 * editable pool is exactly the manager's roster (the symbols already across
 * their lineup + bench), reassigned among the configured slots. The server
 * (PUT /lineup) enforces ownership + slot eligibility and returns the saved
 * lineup; we surface its validation errors inline. After the Monday-open lock
 * the editor is read-only.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SetLineupSlot } from '@tickr/shared-types';
import { ApiClientError, client } from '../../api/client';
import { SLOT_LABELS } from './api';
import type { LeagueContext } from './useLeague';
import styles from './TeamView.module.css';

interface SlotRow {
  slot: SetLineupSlot['slot'];
  slotIndex: number;
  key: string;
  label: string;
}

/** The configured starting slots, then the bench depth, in canonical order. */
function buildRows(slots: string[], bench: number): SlotRow[] {
  const rows: SlotRow[] = slots.map((slot, i) => ({
    slot: slot as SetLineupSlot['slot'],
    slotIndex: 0,
    key: `${slot}#0#${i}`,
    label: SLOT_LABELS[slot] ?? slot,
  }));
  for (let i = 0; i < bench; i++) {
    rows.push({
      slot: 'bench',
      slotIndex: i,
      key: `bench#${i}`,
      label: bench > 1 ? `Bench ${i + 1}` : 'Bench',
    });
  }
  return rows;
}

export function LineupEditor({ ctx }: { ctx: LeagueContext }) {
  const { league, lineup, setLineup } = ctx;

  const rows = useMemo(
    () =>
      league
        ? buildRows(league.rosterConfig.slots, league.rosterConfig.bench)
        : [],
    [league],
  );

  // The pick pool is the manager's roster (owned players), not the current
  // lineup — an unset lineup has no slots yet, so deriving the pool from the
  // lineup would be empty. fs_roster_entry is exposed via /players?mine.
  const rosterQuery = useQuery({
    queryKey: ['fantasy', 'roster', ctx.leagueId],
    queryFn: () => client.getRoster(ctx.leagueId),
    enabled: !(lineup?.locked ?? false),
  });
  // A short can only fill Defense; longs fill every other slot. The server is
  // authoritative; this just keeps each dropdown to the eligible side.
  const pools = useMemo(() => {
    const items = rosterQuery.data?.items ?? [];
    const longs = items
      .filter((p) => !p.ownership.isShort)
      .map((p) => p.symbol)
      .sort();
    const shorts = items
      .filter((p) => p.ownership.isShort)
      .map((p) => p.symbol)
      .sort();
    // Defense is short-only; long slots take longs; bench takes anything owned.
    return { longs, shorts, bench: [...longs, ...shorts].sort() };
  }, [rosterQuery.data]);

  // Current assignment keyed by row; seeded from the saved lineup.
  const initial = useMemo(() => {
    const map: Record<string, string> = {};
    for (const r of rows) {
      const match = (lineup?.slots ?? []).find(
        (s) => s.slot === r.slot && s.slotIndex === r.slotIndex,
      );
      map[r.key] = match?.symbol ?? '';
    }
    return map;
  }, [rows, lineup]);

  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const assignment = draft ?? initial;
  const locked = lineup?.locked ?? false;

  if (!league) return null;

  const dupes = new Set(
    Object.values(assignment).filter(
      (sym, i, arr) => sym !== '' && arr.indexOf(sym) !== i,
    ),
  );

  const onPick = (key: string, symbol: string) =>
    setDraft({ ...assignment, [key]: symbol });

  const onSave = () => {
    const slots: SetLineupSlot[] = rows
      .filter((r) => assignment[r.key])
      .map((r) => ({
        slot: r.slot,
        slotIndex: r.slotIndex,
        symbol: assignment[r.key] ?? '',
      }));
    setLineup.mutate(slots, { onSuccess: () => setDraft(null) });
  };

  const saveErr =
    setLineup.error instanceof ApiClientError
      ? setLineup.error.message
      : setLineup.error
        ? 'Could not save the lineup.'
        : null;

  return (
    <div className={styles.editor}>
      <table className={styles.slots}>
        <thead>
          <tr>
            <th>Slot</th>
            <th>Stock</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sym = assignment[r.key] ?? '';
            const pool =
              r.slot === 'defense'
                ? pools.shorts
                : r.slot === 'bench'
                  ? pools.bench
                  : pools.longs;
            return (
              <tr
                key={r.key}
                className={r.slot === 'defense' ? styles.short : ''}
              >
                <td className={styles.slotName}>
                  {r.label}
                  {r.slot === 'defense' && (
                    <span className={styles.shortTag}>short</span>
                  )}
                </td>
                <td>
                  {locked ? (
                    <span className={styles.symbol}>{sym || '—'}</span>
                  ) : (
                    <select
                      className={`${styles.select} ${dupes.has(sym) ? styles.dupe : ''}`}
                      value={sym}
                      onChange={(e) => onPick(r.key, e.target.value)}
                    >
                      <option value="">— empty —</option>
                      {/* Keep the saved pick selectable even if it isn't in
                          the eligible pool (e.g. a bench long in Defense). */}
                      {(pool.includes(sym) || sym === ''
                        ? pool
                        : [sym, ...pool]
                      ).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {locked ? (
        <p className={styles.lockedNote}>
          Locked at Monday open{lineup?.autoFilled ? ' · auto-filled' : ''}. The
          lineup is frozen for the week.
        </p>
      ) : (
        <div className={styles.actions}>
          <button
            className={styles.save}
            onClick={onSave}
            disabled={setLineup.isPending || dupes.size > 0}
          >
            {setLineup.isPending ? 'Saving…' : 'Save lineup'}
          </button>
          <button
            className={styles.autofill}
            onClick={() => ctx.autofill.mutate()}
            disabled={ctx.autofill.isPending}
          >
            {ctx.autofill.isPending ? 'Filling…' : 'Auto-fill remaining'}
          </button>
          {dupes.size > 0 && (
            <span className={styles.warn}>
              Each stock can fill only one slot.
            </span>
          )}
          {saveErr && <span className={styles.warn}>{saveErr}</span>}
        </div>
      )}
    </div>
  );
}
