/**
 * Newspaper masthead — the flag line: a small label flush-left, the serif
 * wordmark centred, and a second label flush-right (e.g. the edition date).
 * Lifted out of the landing page so the brand flag is a reusable primitive.
 *
 * The wordmark is the page's <h1>; render at most one Masthead per page.
 */
import type { ReactNode } from 'react';
import styles from './Masthead.module.css';

export interface MastheadProps {
  /** Centre wordmark — the brand, set as the page <h1>. */
  wordmark: ReactNode;
  /** Flush-left flag label (e.g. an edition/section flag). */
  left?: ReactNode;
  /** Flush-right flag label (e.g. the edition date). */
  right?: ReactNode;
  className?: string;
}

export function Masthead({ wordmark, left, right, className }: MastheadProps) {
  const classes = [styles.masthead];
  if (className) classes.push(className);
  return (
    <header className={classes.join(' ')}>
      <span className={styles.flag}>{left}</span>
      <h1 className={styles.wordmark}>{wordmark}</h1>
      <span className={`${styles.flag} ${styles.right}`}>{right}</span>
    </header>
  );
}
