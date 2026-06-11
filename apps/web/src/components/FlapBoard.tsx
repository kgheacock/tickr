import { useState } from 'react';
import styles from './FlapBoard.module.css';

interface FlapBoardProps {
  /** Ticker symbols to render, in order; each becomes one split-flap tile. */
  tickers: string[];
  /**
   * Pause the scroll. The marquee is also auto-paused under
   * `prefers-reduced-motion`, so this is for explicit/host control only.
   */
  paused?: boolean;
}

/**
 * A split-flap ticker board: an iterating, continuously-scrolling row of
 * company logos, one cream flap tile per ticker. Logos come from the public
 * branding endpoint (`/api/v1/symbols/:symbol/logo`); a symbol with no stored
 * logo 404s, in which case the tile falls back to the bare ticker glyph — so
 * the board always renders something legible. Echoes the split-flap idiom of
 * the marketing page (docs/index.html) in the SPA's newsprint surface.
 */
export function FlapBoard({ tickers, paused = false }: FlapBoardProps) {
  if (tickers.length === 0) return null;

  // Render the sequence twice so the -50% translate loops seamlessly (the
  // second run backfills the gap as the first scrolls off). The clone is
  // aria-hidden so assistive tech reads each symbol once.
  return (
    <section
      className={styles.board}
      aria-label={`Market tickers: ${tickers.join(', ')}`}
    >
      <div className={`${styles.track} ${paused ? styles.paused : ''}`}>
        <ul className={styles.run}>
          {tickers.map((symbol) => (
            <FlapTile key={symbol} symbol={symbol} />
          ))}
        </ul>
        <ul className={styles.run} aria-hidden="true">
          {tickers.map((symbol) => (
            <FlapTile key={`clone-${symbol}`} symbol={symbol} />
          ))}
        </ul>
      </div>
    </section>
  );
}

/** One flap tile: the logo image, falling back to the ticker text on 404. */
function FlapTile({ symbol }: { symbol: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <li className={styles.tile}>
      {failed ? (
        <span className={styles.glyph}>{symbol}</span>
      ) : (
        <img
          className={styles.logo}
          src={`/api/v1/symbols/${encodeURIComponent(symbol)}/logo`}
          alt={symbol}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </li>
  );
}
