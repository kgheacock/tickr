import { useState } from 'react';
import styles from './TickerTape.module.css';

interface TickerTapeProps {
  /** Symbols to run across the tape, in order. The tape loops them forever. */
  tickers: string[];
  /** Editorial label printed in the fixed cell at the head of the strip. */
  label?: string;
}

/**
 * A market-data strip for the landing masthead: an endless ticker tape of
 * company logos scrolling under a fixed editorial label, framed like the
 * "markets at a glance" band on a financial front page. Decorative — the
 * running quotes are `aria-hidden`, and under `prefers-reduced-motion` the
 * tape holds still instead of scrolling.
 *
 * Each quote is purely the symbol's logo (from `/api/v1/symbols/:symbol/logo`).
 * A symbol with no stored logo (the endpoint 404s) drops out of the tape
 * entirely, so the strip shows only real brand marks.
 */
export function TickerTape({ tickers, label = 'The Tape' }: TickerTapeProps) {
  // The run is duplicated so the track can translate exactly -50% and seam
  // back to the start with no visible jump.
  const run = [...tickers, ...tickers];

  return (
    <section className={styles.ribbon} aria-label="Market tickers">
      <span className={styles.label}>{label}</span>
      <div className={styles.window}>
        <div className={styles.track}>
          {run.map((symbol, i) => (
            <Quote key={`${symbol}-${i}`} symbol={symbol} />
          ))}
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
