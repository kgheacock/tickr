/**
 * The "short" tag that flags a Defense (short) holding — the stock scores
 * inverted, so a price drop gains points. Sits inline after a ticker (the My
 * Team roster row, the stock-report masthead) and carries a brief tooltip
 * spelling out the reversed scoring. Shared so the badge and its explanation
 * read the same everywhere a short surfaces.
 */
import { Tooltip } from '../../components';
import styles from './ShortBadge.module.css';

export function ShortBadge({ className }: { className?: string }) {
  return (
    <Tooltip
      content={
        <>
          <strong>Defense:</strong> a price decrease gains points.
        </>
      }
    >
      <span className={[styles.tag, className].filter(Boolean).join(' ')}>
        short
      </span>
    </Tooltip>
  );
}
