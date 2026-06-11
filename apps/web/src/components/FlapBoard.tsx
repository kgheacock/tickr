import { useEffect, useState } from 'react';
import styles from './FlapBoard.module.css';

interface FlapBoardProps {
  /** Symbols to flip through, in order; the board cycles them indefinitely. */
  tickers: string[];
  /** Milliseconds each logo is held before the flap drops to the next. */
  intervalMs?: number;
}

/**
 * A single split-flap tile that flips through company logos — one "flapboard
 * logo flipper". On each tick it advances to the next ticker and drops a fresh
 * flap showing that symbol's logo (from `/api/v1/symbols/:symbol/logo`). A
 * symbol with no stored logo 404s and the flap falls back to the bare ticker
 * glyph, so it always shows something legible. Used as the drop cap on the
 * landing page. Decorative: marked `aria-hidden`, and under
 * `prefers-reduced-motion` it still cycles but without the flip animation.
 */
export function FlapBoard({ tickers, intervalMs = 2600 }: FlapBoardProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (tickers.length <= 1) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % tickers.length),
      intervalMs,
    );
    return () => clearInterval(id);
  }, [tickers.length, intervalMs]);

  const symbol = tickers[index];
  if (!symbol) return null;

  return (
    <span className={styles.flap} aria-hidden="true">
      {/* `key` remounts the leaf each change so the drop animation replays. */}
      <span key={index} className={styles.leaf}>
        <FlapFace symbol={symbol} />
      </span>
    </span>
  );
}

/** One flap face: the logo image, falling back to the ticker glyph on 404. */
function FlapFace({ symbol }: { symbol: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className={styles.glyph}>{symbol}</span>;
  }
  return (
    <img
      className={styles.logo}
      src={`/api/v1/symbols/${encodeURIComponent(symbol)}/logo`}
      alt=""
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
