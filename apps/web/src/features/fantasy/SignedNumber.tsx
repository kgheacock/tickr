/**
 * The one way fantasy-street renders a signed points figure: a bold +/− sign in
 * front of the value (both in normal ink), followed by a colored direction
 * triangle — green ▲ for a gain, red ▼ for a loss. The sign carries the meaning
 * in text (monochrome- and screen-reader-safe; the triangle is decorative and
 * aria-hidden); the triangle is the at-a-glance color/shape cue. Zero is
 * neutral: no sign, no triangle.
 *
 * Every points figure goes through here — table cells, stat lists, recap
 * scorelines, chart tooltips — so the convention can't drift between views.
 */
import { fmtPercent, fmtPoints, signOf } from './points';
import styles from './SignedNumber.module.css';

export interface SignedNumberProps {
  value: number | null | undefined;
  /** `points` (default) or `percent` — selects the formatter. */
  format?: 'points' | 'percent';
  /** Extra classes (typography/size) merged onto the figure wrapper. */
  className?: string;
}

export function SignedNumber({
  value,
  format = 'points',
  className,
}: SignedNumberProps) {
  const text = format === 'percent' ? fmtPercent(value) : fmtPoints(value);
  // fmtPoints/fmtPercent emit a leading '+' or '−' (U+2212) on non-zero values;
  // split it off so the sign can be weighted on its own.
  const hasSign = text[0] === '+' || text[0] === '−';
  const sign = hasSign ? text[0] : '';
  const body = hasSign ? text.slice(1) : text;
  const dir = signOf(value);
  const cls = [styles.figure, className].filter(Boolean).join(' ');
  return (
    <span className={cls}>
      {sign && <span className={styles.sign}>{sign}</span>}
      {body}
      {dir !== 'flat' && (
        <span className={styles[dir]} aria-hidden="true">
          {dir === 'pos' ? '▲' : '▼'}
        </span>
      )}
    </span>
  );
}
