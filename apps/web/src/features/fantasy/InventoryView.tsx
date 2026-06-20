/**
 * Stock inventory — the league's "waiver wire" board. A filterable, paginated
 * listing of every stock: symbol, specialization, who holds it (or Available), and
 * the points it has scored so far this week. Each row opens the stock report
 * (price chart + previous scoring); unowned rows carry a Buy button for an
 * immediate free-agent add (paired with a drop when the roster is full), gated
 * by the lineup lock like every real-time roster mutation.
 */
import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { PlayerInventoryItem } from '@tickr/shared-types';
import { ApiClientError, client } from '../../api/client';
import { useLeagueContext } from './FantasyLayout';
import type { LeagueContext } from './useLeague';
import { SPECIALIZATIONS } from './api';
import { SignedNumber } from './SignedNumber';
import { PlayerDetailModal } from './PlayerDetailModal';
import { SellModal } from './SellModal';
import { StockCell, SpecChips } from './StockCell';
import { StockMasthead } from './StockMasthead';
import { SlotSelect } from './SlotSelect';
import { StockSelect } from './StockSelect';
import {
  Input,
  Checkbox,
  Button,
  Modal,
  Field,
  Table,
  TableRow,
  SortHeader,
  nextSort,
  type SortState,
} from '../../components';
import styles from './InventoryView.module.css';

const PAGE_SIZE = 25;

function ownerCell(item: PlayerInventoryItem) {
  if (!item.ownership.owned) {
    return <span className={styles.unowned}>—</span>;
  }
  return (
    <span className={styles.owner}>
      {item.ownership.ownerTeam ?? 'A manager'}
    </span>
  );
}

export function InventoryView() {
  const ctx = useLeagueContext();
  const { leagueId } = ctx;
  // Buying is a real-time roster mutation, so it follows the lineup lock — only
  // open while this week's lineup is unlocked (mirrors trades/waivers server-side).
  const locked = ctx.lineup?.locked ?? false;

  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState>({ key: 'lastWk', dir: 'desc' });
  const [selected, setSelected] = useState<string | null>(null);
  // The unowned stock pending a buy confirmation; null when no prompt is open.
  // Carries the name so the dialog masthead can show the company line.
  const [buyTarget, setBuyTarget] = useState<{
    symbol: string;
    name: string | null;
  } | null>(null);
  // The owned stock pending a sell confirmation, reached from the stock report.
  const [sellTarget, setSellTarget] = useState<{
    symbol: string;
    name: string | null;
  } | null>(null);

  // The caller's roster powers the "is my team full?" check and the drop-picker
  // a full-roster buy needs. Shares LineupEditor's query key, so it's deduped.
  const rosterQuery = useQuery({
    queryKey: ['fantasy', 'roster', leagueId],
    queryFn: () => client.getRoster(leagueId),
    enabled: !locked,
  });
  const rosterItems = useMemo(
    () => rosterQuery.data?.items ?? [],
    [rosterQuery.data],
  );
  const rosterCap = ctx.league
    ? ctx.league.rosterConfig.slots.length + ctx.league.rosterConfig.bench
    : 0;

  // Reset to the first page whenever a filter narrows the result set.
  const onFilter = (fn: () => void) => {
    fn();
    setPage(0);
  };

  // A header click re-sorts the whole list, so jump back to the first page.
  const onSort = (key: string) =>
    onFilter(() => setSort((cur) => nextSort(cur, key)));

  const sortKey = sort.key === 'lastWk' ? 'lastWk' : 'symbol';

  const players = useQuery({
    queryKey: [
      'fantasy',
      'inventory',
      leagueId,
      group,
      q,
      availableOnly,
      page,
      sortKey,
      sort.dir,
    ],
    queryFn: () =>
      client.getPlayers(leagueId, {
        group: group || undefined,
        q: q.trim() || undefined,
        available: availableOnly || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        sort: sortKey,
        dir: sort.dir,
      }),
    placeholderData: keepPreviousData,
  });

  const data = players.data;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className={styles.view}>
      <div className={styles.controls}>
        <Input
          className={styles.search}
          type="search"
          placeholder="Search ticker…"
          value={q}
          onChange={(e) => onFilter(() => setQ(e.target.value))}
          aria-label="Search ticker"
        />
        <SlotSelect
          className={styles.specFilter}
          value={group}
          options={['', ...SPECIALIZATIONS]}
          onChange={(g) => onFilter(() => setGroup(g))}
          labels={{ '': 'All specializations' }}
          aria-label="Filter by specialization"
        />
        <Checkbox
          className={styles.toggle}
          label="Available only"
          checked={availableOnly}
          onChange={(e) => onFilter(() => setAvailableOnly(e.target.checked))}
        />
      </div>

      <Table>
        <thead>
          <tr>
            <SortHeader sortKey="symbol" sort={sort} onSort={onSort}>
              Stock
            </SortHeader>
            <th>Specialization</th>
            <th>Owner</th>
            <SortHeader
              sortKey="lastWk"
              sort={sort}
              onSort={onSort}
              className={styles.num}
            >
              This wk
            </SortHeader>
            {!locked && <th className={styles.buyCol} aria-label="Buy" />}
          </tr>
        </thead>
        <tbody>
          {players.isLoading && (
            <tr>
              <td colSpan={locked ? 4 : 5} className={styles.empty}>
                Loading inventory…
              </td>
            </tr>
          )}
          {players.error && !data && (
            <tr>
              <td colSpan={locked ? 4 : 5} className={styles.empty}>
                Couldn’t load the inventory.
              </td>
            </tr>
          )}
          {data && data.items.length === 0 && (
            <tr>
              <td colSpan={locked ? 4 : 5} className={styles.empty}>
                No stocks match these filters.
              </td>
            </tr>
          )}
          {data?.items.map((item) => (
            <TableRow
              key={item.symbol}
              clickable
              onClick={() => setSelected(item.symbol)}
              tabIndex={0}
              role="button"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelected(item.symbol);
                }
              }}
            >
              <td>
                <StockCell symbol={item.symbol} name={item.name} />
              </td>
              <td>
                <SpecChips groups={item.groups} />
              </td>
              <td>{ownerCell(item)}</td>
              <td className={styles.num}>
                <SignedNumber value={item.currentWeekPoints} />
              </td>
              {!locked && (
                <td className={styles.buyCol}>
                  {!item.ownership.owned && (
                    <Button
                      variant="ghost"
                      size="sm"
                      // The row opens the stock report; keep the click on Buy.
                      onClick={(e) => {
                        e.stopPropagation();
                        setBuyTarget({ symbol: item.symbol, name: item.name });
                      }}
                      aria-label={`Buy ${item.symbol}`}
                    >
                      Buy
                    </Button>
                  )}
                </td>
              )}
            </TableRow>
          ))}
        </tbody>
      </Table>

      <div className={styles.pager}>
        <span className={styles.range}>
          {from}–{to} of {total.toLocaleString()}
        </span>
        <div className={styles.pageBtns}>
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← Prev
          </Button>
          <span className={styles.pageNum}>
            {page + 1} / {pageCount}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </Button>
        </div>
      </div>

      {selected && (
        <PlayerDetailModal
          ctx={ctx}
          symbol={selected}
          onClose={() => setSelected(null)}
          // The report hands the trade to a confirm dialog, closing itself
          // first so the warning stands alone.
          onRequestBuy={(symbol, name) => {
            setSelected(null);
            setBuyTarget({ symbol, name });
          }}
          onRequestSell={(symbol, name) => {
            setSelected(null);
            setSellTarget({ symbol, name });
          }}
        />
      )}

      {buyTarget && (
        <BuyModal
          ctx={ctx}
          symbol={buyTarget.symbol}
          name={buyTarget.name}
          roster={rosterItems}
          full={rosterCap > 0 && rosterItems.length >= rosterCap}
          onClose={() => setBuyTarget(null)}
        />
      )}

      {sellTarget && (
        <SellModal
          ctx={ctx}
          symbol={sellTarget.symbol}
          name={sellTarget.name}
          onClose={() => setSellTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * Confirm-then-buy dialog for claiming an unowned stock. When the roster is full
 * the buy must shed a stock, so we surface a drop-picker; otherwise it's a plain
 * confirm. Long basis only — the wire doesn't expose shorting.
 */
function BuyModal({
  ctx,
  symbol,
  name,
  roster,
  full,
  onClose,
}: {
  ctx: LeagueContext;
  symbol: string;
  name: string | null;
  roster: PlayerInventoryItem[];
  full: boolean;
  onClose: () => void;
}) {
  const { buyPlayer } = ctx;
  const [dropSymbol, setDropSymbol] = useState<string>(
    () => roster[0]?.symbol ?? '',
  );
  const err =
    buyPlayer.error instanceof ApiClientError
      ? buyPlayer.error.message
      : buyPlayer.error
        ? 'Could not buy this stock.'
        : null;

  // A full roster with no droppable stock is unactionable — guard the confirm.
  const blocked = full && !dropSymbol;

  // The mutation lives on the shared league context, so its error outlives this
  // modal — clear it on close so the next Buy prompt opens clean.
  const close = () => {
    buyPlayer.reset();
    onClose();
  };

  const onConfirm = () => {
    buyPlayer.mutate(
      {
        addSymbol: symbol,
        dropSymbol: full ? dropSymbol : undefined,
        isShort: false,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      onClose={close}
      kicker="Buy"
      label={`Buy ${symbol}`}
      masthead={<StockMasthead symbol={symbol} name={name} />}
    >
      <p className={styles.confirmBody}>
        {full ? (
          <>
            Your team is full, so buying <strong>{symbol}</strong> drops a stock
            in the same move. Choose which to let go.
          </>
        ) : (
          <>
            Add <strong>{symbol}</strong> to your team off the wire?
          </>
        )}
      </p>
      {full && (
        <Field label="Drop to make room">
          <StockSelect
            value={dropSymbol}
            options={roster}
            onChange={setDropSymbol}
            aria-label="Drop to make room"
          />
        </Field>
      )}
      {err && <p className={styles.warn}>{err}</p>}
      <div className={styles.modalActions}>
        <Button onClick={onConfirm} disabled={buyPlayer.isPending || blocked}>
          {buyPlayer.isPending
            ? 'Buying…'
            : full
              ? `Buy ${symbol} · Drop ${dropSymbol}`
              : `Buy ${symbol}`}
        </Button>
        <Button
          variant="secondary"
          onClick={close}
          disabled={buyPlayer.isPending}
        >
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
