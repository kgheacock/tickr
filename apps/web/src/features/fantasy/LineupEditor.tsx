/**
 * Lineup editor (item 09 step 4, stock-first redesign). The roster is the spine:
 * we list every owned stock and let the manager pick which slot each one fills.
 * Because a starting slot holds exactly one stock, assigning a slot to a stock
 * pulls that slot off whichever stock currently holds it (the prior holder drops
 * to the bench). Bench is the catch-all and is non-exclusive up to its capacity.
 *
 * Per the locked anti-"benching cash" decision the only choice is *which* owned
 * stock fills each slot — never cash — so the pool is exactly the manager's
 * roster. The server (PUT /lineup) is authoritative on ownership, the long/short
 * basis, and per-group eligibility; we keep all slots assignable and surface its
 * validation errors inline. After the Monday-open lock the editor is read-only.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { PlayerGroup, SetLineupSlot } from '@tickr/shared-types';
import { ApiClientError, client } from '../../api/client';
import { SLOT_LABELS, GLOBAL_GROUPS, isPlayerGroup } from './api';
import { fmtPoints } from './points';
import type { LeagueContext } from './useLeague';
import { StockCell, SpecChips } from './StockCell';
import { PlayerDetailModal } from './PlayerDetailModal';
import { SlotSelect } from './SlotSelect';
import { Button, CategoryChip, Modal, Table, TableRow } from '../../components';
import styles from './TeamView.module.css';

const BENCH = 'bench';

interface StockRow {
  symbol: string;
  name: string | null;
  isShort: boolean;
  /** Classification groups (SpecChips strips the universal slots); [] when locked. */
  groups: PlayerGroup[];
  /** Points scored last completed week; null when locked (no roster metadata). */
  lastWeekPoints: number | null;
}

/** The configured mandatory slots, normalised to the lowercase lineup keys. */
function mandatorySlots(slots: string[]): string[] {
  // rosterConfig.slots are Title-cased ("Anchor"); the lineup slot type and the
  // saved lineup are lowercase. Normalise so eligibility, saved-pick matching,
  // and the coloured CategoryChip all align.
  return slots.map((raw) => raw.trim().toLowerCase());
}

export function LineupEditor({ ctx }: { ctx: LeagueContext }) {
  const { league, lineup, setLineup } = ctx;
  const locked = lineup?.locked ?? false;
  const navigate = useNavigate();

  // The pick pool is the manager's roster (owned players). fs_roster_entry is
  // exposed via /players?mine; it's the source of names + specialization chips.
  // Disabled once locked — the read-only view renders from the saved lineup.
  const rosterQuery = useQuery({
    queryKey: ['fantasy', 'roster', ctx.leagueId],
    queryFn: () => client.getRoster(ctx.leagueId),
    enabled: !locked,
  });

  const slots = useMemo(
    () => (league ? mandatorySlots(league.rosterConfig.slots) : []),
    [league],
  );
  const benchCap = league?.rosterConfig.bench ?? 0;

  // The stock list (the table's rows). Unlocked: the live roster, with names and
  // specialization chips. Locked: the frozen lineup, which carries every placed
  // symbol + its slot but no roster metadata. Sort is stable (longs then the
  // short(s), each alphabetical) so rows never jump as assignments change.
  const stocks = useMemo<StockRow[]>(() => {
    const rows: StockRow[] = locked
      ? (lineup?.slots ?? []).map((s) => ({
          symbol: s.symbol,
          name: null,
          isShort: s.isShort,
          groups: [],
          lastWeekPoints: null,
        }))
      : (rosterQuery.data?.items ?? []).map((p) => ({
          symbol: p.symbol,
          name: p.name,
          isShort: !!p.ownership.isShort,
          groups: p.groups,
          lastWeekPoints: p.lastWeekPoints,
        }));
    return rows.sort(
      (a, b) =>
        Number(a.isShort) - Number(b.isShort) ||
        a.symbol.localeCompare(b.symbol),
    );
  }, [locked, lineup, rosterQuery.data]);

  // Current slot per stock, seeded from the saved lineup; unplaced stocks bench.
  const initial = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of stocks) {
      const placed = (lineup?.slots ?? []).find((l) => l.symbol === s.symbol);
      map[s.symbol] = placed?.slot ?? BENCH;
    }
    return map;
  }, [stocks, lineup]);

  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const assignment = draft ?? initial;

  // The open stock-detail modal (clicking a roster stock, as on the waiver wire).
  const [selected, setSelected] = useState<string | null>(null);
  // The stock pending a sell (drop) confirmation; null when no prompt is open.
  const [sellTarget, setSellTarget] = useState<string | null>(null);
  // After auto-fill, the slots it still couldn't fill — drives the wire nudge.
  const [needWire, setNeedWire] = useState<string[] | null>(null);

  if (!league) return null;

  // Assigning an exclusive starting slot pulls it off the prior holder, who
  // drops to the bench. Bench is shared, so it bumps no one.
  const onAssign = (symbol: string, slot: string) => {
    const next = { ...assignment, [symbol]: slot };
    if (slot !== BENCH) {
      for (const other of Object.keys(next)) {
        if (other !== symbol && next[other] === slot) next[other] = BENCH;
      }
    }
    setDraft(next);
  };

  // Open starting positions: each configured slot the current assignment hasn't
  // filled. The editor models slots by name (one stock per slot name), so the
  // set of filled names against the unique slot list is exact. Drives the header
  // chips, whether "Auto-fill remaining" shows, and the post-fill wire nudge.
  const filledStartSlots = new Set(
    Object.values(assignment).filter((slot) => slot !== BENCH),
  );
  const openSlots = [...new Set(slots)].filter(
    (sl) => !filledStartSlots.has(sl),
  );

  // Unsaved changes: the draft assignment differs from the saved lineup. The
  // Save button only shows when dirty (a no-op draft, or none, hides it).
  const dirty =
    draft !== null &&
    stocks.some(
      (s) => (draft[s.symbol] ?? BENCH) !== (initial[s.symbol] ?? BENCH),
    );

  // Auto-fill the saved lineup server-side, then show its authoritative result
  // (dropping any local draft so the open-position chips match what landed). If
  // it still can't complete the team from the owned roster, point the manager at
  // the Waiver Wire to pick up an eligible stock for each remaining slot.
  const onAutofill = () => {
    ctx.autofill.mutate(undefined, {
      onSuccess: (next) => {
        setDraft(null);
        const filled = new Set<string>(
          next.slots.filter((s) => s.slot !== BENCH).map((s) => s.slot),
        );
        const stillOpen = [...new Set(slots)].filter((sl) => !filled.has(sl));
        if (stillOpen.length > 0) setNeedWire(stillOpen);
      },
    });
  };

  const onSave = () => {
    const out: SetLineupSlot[] = [];
    let benchIndex = 0;
    for (const s of stocks) {
      const slot = assignment[s.symbol];
      if (!slot) continue;
      if (slot === BENCH) {
        // Persist the bench only up to its capacity; any extra (an unfilled
        // starting slot pushed a stock over) is simply left unplaced — it reads
        // as benched on reload either way, and the payload stays slot-valid.
        if (benchIndex < benchCap) {
          out.push({ slot: BENCH, slotIndex: benchIndex++, symbol: s.symbol });
        }
      } else {
        out.push({
          slot: slot as SetLineupSlot['slot'],
          slotIndex: 0,
          symbol: s.symbol,
        });
      }
    }
    setLineup.mutate(out, { onSuccess: () => setDraft(null) });
  };

  const saveErr =
    setLineup.error instanceof ApiClientError
      ? setLineup.error.message
      : setLineup.error
        ? 'Could not save the lineup.'
        : null;

  return (
    <div className={styles.editor}>
      {!locked && (
        <div className={styles.openPositions}>
          <span className={styles.openLabel}>Open Positions</span>
          {openSlots.length === 0 ? (
            <span className={styles.openNone}>—</span>
          ) : (
            <span className={styles.openChips}>
              <SlotChips slots={openSlots} />
            </span>
          )}
          {openSlots.length > 0 && (
            <Button
              className={styles.autofillBtn}
              variant="secondary"
              size="sm"
              onClick={onAutofill}
              disabled={ctx.autofill.isPending}
            >
              {ctx.autofill.isPending ? 'Filling…' : 'Auto-fill remaining'}
            </Button>
          )}
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <th>Stock</th>
            <th>Specialization</th>
            <th className={styles.lastWk}>Last wk</th>
            <th>Slot</th>
            {!locked && <th className={styles.sellCol} aria-label="Sell" />}
          </tr>
        </thead>
        <tbody>
          {stocks.length === 0 && (
            <tr>
              <td colSpan={locked ? 4 : 5} className={styles.empty}>
                {rosterQuery.isLoading
                  ? 'Loading your roster…'
                  : 'No stocks on your roster yet.'}
              </td>
            </tr>
          )}
          {stocks.map((s) => {
            const current = assignment[s.symbol] ?? BENCH;
            // The slot sets the basis: any owned stock may fill Defense (it's
            // converted to a short for the week), so every classification-
            // eligible slot is offered. Mirrors the server (eligibility.ts):
            // the universal slots (Defense/Wildcard) are always eligible, the
            // earned ones must be in the stock's groups.
            const canFill = (sl: string) =>
              isPlayerGroup(sl) &&
              (GLOBAL_GROUPS.has(sl) || s.groups.includes(sl));
            const options = slots.filter(canFill);
            // Short-ness follows the *assigned* slot, not the roster entry:
            // Defense is a short, so its points read with the sign flipped.
            const slotIsShort = current === 'defense';
            const lastWk =
              s.lastWeekPoints == null
                ? null
                : slotIsShort
                  ? -s.lastWeekPoints
                  : s.lastWeekPoints;
            return (
              <TableRow
                key={s.symbol}
                className={slotIsShort ? styles.short : undefined}
              >
                <td>
                  <StockCell
                    symbol={s.symbol}
                    name={s.name}
                    onClick={() => setSelected(s.symbol)}
                    tag={
                      slotIsShort && (
                        <span className={styles.shortTag}>short</span>
                      )
                    }
                  />
                </td>
                <td>
                  <SpecChips groups={s.groups} />
                </td>
                <td
                  className={`${styles.lastWk} ${
                    lastWk == null ? '' : lastWk >= 0 ? styles.pos : styles.neg
                  }`}
                >
                  {fmtPoints(lastWk)}
                </td>
                <td>
                  {locked ? (
                    isPlayerGroup(current) ? (
                      <CategoryChip group={current}>
                        {SLOT_LABELS[current] ?? current}
                      </CategoryChip>
                    ) : (
                      <span className={styles.benchLabel}>
                        {SLOT_LABELS[current] ?? current}
                      </span>
                    )
                  ) : (
                    <SlotSelect
                      className={styles.select}
                      value={current}
                      options={[...options, BENCH]}
                      onChange={(slot) => onAssign(s.symbol, slot)}
                      aria-label={`Slot for ${s.symbol}`}
                    />
                  )}
                </td>
                {!locked && (
                  <td className={styles.sellCol}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSellTarget(s.symbol)}
                      aria-label={`Sell ${s.symbol}`}
                    >
                      Sell
                    </Button>
                  </td>
                )}
              </TableRow>
            );
          })}
        </tbody>
      </Table>

      {locked ? (
        <p className={styles.lockedNote}>
          Locked at Monday open{lineup?.autoFilled ? ' · auto-filled' : ''}. The
          lineup is frozen for the week.
        </p>
      ) : (
        <div className={styles.actions}>
          {dirty && (
            <Button onClick={onSave} disabled={setLineup.isPending}>
              {setLineup.isPending ? 'Saving…' : 'Save lineup'}
            </Button>
          )}
          {saveErr && <span className={styles.warn}>{saveErr}</span>}
        </div>
      )}

      {selected && (
        <PlayerDetailModal
          leagueId={ctx.leagueId}
          symbol={selected}
          onClose={() => setSelected(null)}
        />
      )}

      {sellTarget && (
        <SellModal
          ctx={ctx}
          symbol={sellTarget}
          onClose={() => setSellTarget(null)}
        />
      )}

      {needWire && (
        <WireModal
          slots={needWire}
          onGoToWire={() => navigate(`/leagues/${ctx.leagueId}/players`)}
          onClose={() => setNeedWire(null)}
        />
      )}
    </div>
  );
}

/** A row of slot CategoryChips (Title-cased labels), shared by the header's
 *  open-positions list and the wire nudge. Slots are always coloured groups. */
function SlotChips({ slots }: { slots: string[] }) {
  return (
    <>
      {slots.map((sl) =>
        isPlayerGroup(sl) ? (
          <CategoryChip key={sl} group={sl} noTooltip>
            {SLOT_LABELS[sl] ?? sl}
          </CategoryChip>
        ) : (
          <span key={sl}>{SLOT_LABELS[sl] ?? sl}</span>
        ),
      )}
    </>
  );
}

/** Shown when auto-fill can't complete the lineup from the owned roster: the
 *  manager must pick up an eligible stock for each still-open slot from the
 *  Waiver Wire. */
function WireModal({
  slots,
  onGoToWire,
  onClose,
}: {
  slots: string[];
  onGoToWire: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} kicker="Lineup" title="Your team isn’t complete">
      <p className={styles.confirmBody}>
        Auto-fill couldn’t fill every slot from the stocks you own. Pick up an
        eligible stock from the Waiver Wire for:
      </p>
      <div className={`${styles.openChips} ${styles.wireSlots}`}>
        <SlotChips slots={slots} />
      </div>
      <div className={styles.actions}>
        <Button onClick={onGoToWire}>Go to Waiver Wire</Button>
        <Button variant="secondary" onClick={onClose}>
          Not now
        </Button>
      </div>
    </Modal>
  );
}

/** Confirm-then-drop dialog for selling an owned stock back to the wire. */
function SellModal({
  ctx,
  symbol,
  onClose,
}: {
  ctx: LeagueContext;
  symbol: string;
  onClose: () => void;
}) {
  const { sellPlayer } = ctx;
  const err =
    sellPlayer.error instanceof ApiClientError
      ? sellPlayer.error.message
      : sellPlayer.error
        ? 'Could not sell this stock.'
        : null;

  // The mutation lives on the shared league context, so its error outlives this
  // modal — clear it on close so the next Sell prompt opens clean.
  const close = () => {
    sellPlayer.reset();
    onClose();
  };

  const onConfirm = () => sellPlayer.mutate(symbol, { onSuccess: onClose });

  return (
    <Modal onClose={close} kicker="Transaction" title={`Sell ${symbol}`}>
      <p className={styles.confirmBody}>
        Drop <strong>{symbol}</strong> from your team and return it to the wire?
        This opens a roster spot and can’t be undone.
      </p>
      {err && <p className={styles.warn}>{err}</p>}
      <div className={styles.actions}>
        <Button onClick={onConfirm} disabled={sellPlayer.isPending}>
          {sellPlayer.isPending ? 'Selling…' : `Sell ${symbol}`}
        </Button>
        <Button
          variant="secondary"
          onClick={close}
          disabled={sellPlayer.isPending}
        >
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
