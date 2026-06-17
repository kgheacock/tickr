/**
 * Editorial "kicker" — the small brick-red, letter-spaced eyebrow that sits
 * above a headline (the newspaper section label). Standardised out of the
 * landing masthead and the Modal header so the eyebrow reads the same wherever
 * it appears.
 *
 * The component owns only the type treatment and colour. Spacing beneath it is
 * layout, so it stays with the caller — pass a `className` for the gap to the
 * headline that follows.
 */
import type { ReactNode } from 'react';
import styles from './Kicker.module.css';

export interface KickerProps {
  children: ReactNode;
  /** Extra classes — typically the caller's spacing below the eyebrow. */
  className?: string;
}

export function Kicker({ children, className }: KickerProps) {
  const classes = [styles.kicker];
  if (className) classes.push(className);
  return <p className={classes.join(' ')}>{children}</p>;
}
