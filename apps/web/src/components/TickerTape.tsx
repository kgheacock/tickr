import { useState, type ReactNode } from 'react';
import styles from './TickerTape.module.css';

interface TickerTapeProps {
  /** Logo mode: symbols to run across the tape, in order. The tape loops them
   *  forever, each rendered as the symbol's brand logo. */
  tickers?: string[];
  /** Content mode: arbitrary cells (e.g. a league's live standings) to run
   *  across the tape instead of logos. Takes precedence over `tickers`. */
  items?: ReactNode[];
  /** Editorial label printed in the fixed cell at the head of the strip. */
  label?: string;
}

/**
 * An endless ticker tape scrolling under a fixed editorial label, framed like
 * the "markets at a glance" band on a financial front page. Two modes: a strip
 * of brand `logos` (the landing masthead) or arbitrary `items` (the league
 * standings band). Decorative in both — the running cells are `aria-hidden`, and
 * under `prefers-reduced-motion` the tape holds still instead of scrolling.
 *
 * In logo mode each quote is the symbol's logo (`/api/v1/symbols/:symbol/logo`);
 * a symbol with no stored logo (the endpoint 404s) drops out of the tape, so the
 * strip shows only real brand marks.
 */
export function TickerTape({
  tickers,
  items,
  label = 'The Tape',
}: TickerTapeProps) {
  // The run is duplicated so the track can translate exactly -50% and seam back
  // to the start with no visible jump. `copy` keeps the two passes' keys unique.
  const renderRun = (copy: number): ReactNode[] =>
    items
      ? items.map((node, i) => (
          <span
            key={`item-${copy}-${i}`}
            className={styles.quote}
            aria-hidden="true"
          >
            {node}
          </span>
        ))
      : (tickers ?? []).map((symbol, i) => (
          <Quote key={`${symbol}-${copy}-${i}`} symbol={symbol} />
        ));

  return (
    <section className={styles.ribbon} aria-label={`${label} ticker`}>
      <span className={styles.label}>{label}</span>
      <div className={styles.window}>
        <div className={styles.track}>
          {renderRun(0)}
          {renderRun(1)}
        </div>
      </div>
    </section>
  );
}

/** One quote: just the brand logo. Symbols whose logo 404s render nothing. */
function Quote({ symbol }: { symbol: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;

  return (
    <span className={styles.quote} aria-hidden="true">
      <img
        className={styles.logo}
        src={`/api/v1/symbols/${encodeURIComponent(symbol)}/logo`}
        alt=""
        decoding="async"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
