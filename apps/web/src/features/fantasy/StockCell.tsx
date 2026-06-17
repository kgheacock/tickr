/**
 * Shared stock-row cells — the logo + symbol/company identity cell and the
 * specialization-chip cell that make up a "waiver wire row". Extracted from
 * InventoryView so the My Team roster (LineupEditor) renders an identical row;
 * both the waiver wire and the team list read the same way as a result.
 */
import { useState, type ReactNode } from 'react';
import type { PlayerGroup } from '@tickr/shared-types';
import { SLOT_LABELS, specializationsOf } from './api';
import { CategoryChip } from '../../components';
import styles from './StockCell.module.css';

/** The stored company icon (symbol_branding), the square brand mark also used on
 *  the landing tape — served from our own API, not a third party. */
function iconUrl(symbol: string): string {
  return `/api/v1/symbols/${encodeURIComponent(symbol)}/icon`;
}

/**
 * The company icon on a white tile. The tile is a fixed square, so the
 * ticker/name beside it stays at a constant position and variable-sized marks
 * scale to fit. A missing icon (the endpoint 404s) falls back to a monogram.
 */
export function StockLogo({
  symbol,
  size = 'sm',
}: {
  symbol: string;
  size?: 'sm' | 'lg';
}) {
  const [failed, setFailed] = useState(false);
  const cls = `${styles.logo} ${size === 'lg' ? styles.logoLg : ''}`;
  return (
    <span className={cls}>
      {failed ? (
        <span className={styles.monogram}>{symbol.charAt(0)}</span>
      ) : (
        <img
          src={iconUrl(symbol)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

/** Ticker over company name. `tag` sits inline after the symbol (e.g. "short").
 *  Pass `onClick` to make the cell a button that opens the stock's detail. */
export function StockCell({
  symbol,
  name,
  tag,
  onClick,
}: {
  symbol: string;
  name: string | null;
  tag?: ReactNode;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <StockLogo symbol={symbol} />
      <span className={styles.text}>
        <span className={styles.symbolLine}>
          <span className={styles.symbol}>{symbol}</span>
          {tag}
        </span>
        <span className={styles.company}>{name ?? '—'}</span>
      </span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={`${styles.stockCell} ${styles.stockButton}`}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }
  return <span className={styles.stockCell}>{inner}</span>;
}

/**
 * A stock's earned specialization chips (universal slots stripped), or a dash.
 * The chips show a single initial (G, V, M, A) to stay compact; the colour key
 * and tooltip carry the meaning, and the stock detail spells the label in full.
 */
export function SpecChips({ groups }: { groups: PlayerGroup[] }) {
  const specs = specializationsOf(groups);
  return (
    <span className={styles.chips}>
      {specs.length === 0 ? (
        <span className={styles.chipMuted}>—</span>
      ) : (
        specs.map((g) => (
          <CategoryChip key={g} group={g}>
            {(SLOT_LABELS[g] ?? g).charAt(0)}
          </CategoryChip>
        ))
      )}
    </span>
  );
}
