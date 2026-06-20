/**
 * Stock identity header — the logo beside the ticker over the company name, the
 * masthead the Modal renders under its kicker. Shared by the stock report and the
 * buy/sell transaction dialogs so every stock-scoped modal opens with the same
 * identity block. Lives with the feature (not the generic components library)
 * because it leans on the FS-specific StockLogo.
 */
import type { ReactNode } from 'react';
import { StockLogo } from './StockCell';
import styles from './StockMasthead.module.css';

export interface StockMastheadProps {
  symbol: string;
  /** Company name shown under the ticker; the line is omitted when absent. */
  name?: string | null;
  /** Logo + type scale. 'lg' (default) for modal headers, 'sm' inline. */
  size?: 'sm' | 'lg';
  /** Sits inline after the ticker (e.g. a "short" flag), mirroring StockCell. */
  tag?: ReactNode;
}

export function StockMasthead({
  symbol,
  name,
  size = 'lg',
  tag,
}: StockMastheadProps) {
  const root = `${styles.masthead} ${size === 'sm' ? styles.sm : ''}`;
  return (
    <div className={root}>
      <StockLogo symbol={symbol} size={size} />
      <div className={styles.titleText}>
        <span className={styles.tickerLine}>
          <span className={styles.ticker}>{symbol}</span>
          {tag}
        </span>
        {name && <span className={styles.companyName}>{name}</span>}
      </div>
    </div>
  );
}
