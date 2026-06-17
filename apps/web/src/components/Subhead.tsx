/**
 * Editorial standfirst — the masthead "deck": a centred, uppercase, tracked
 * sans line that summarises the publication beneath the flag, set between the
 * masthead rules. Lifted from the landing page so the standfirst reads the same
 * wherever a masthead appears.
 *
 * Owns the type treatment only; the vertical breathing room between the rules
 * is layout and stays with the caller via `className`.
 */
import type { ReactNode } from 'react';
import styles from './Subhead.module.css';

export interface SubheadProps {
  children: ReactNode;
  /** Extra classes — typically the caller's vertical padding. */
  className?: string;
}

export function Subhead({ children, className }: SubheadProps) {
  const classes = [styles.subhead];
  if (className) classes.push(className);
  return <p className={classes.join(' ')}>{children}</p>;
}
