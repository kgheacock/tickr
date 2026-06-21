/**
 * Badge — a small outlined uppercase pill for inline status tags, e.g. the
 * "In progress" marker on a not-yet-settled week's score. Accent (blue) spot-ink
 * by default; `tone="caution"` switches to a goldenrod ink for a provisional /
 * projected (not-yet-final) state. Spacing is left to the caller (flex gap or a
 * margin via `className`) so the pill stays placement-agnostic.
 */
import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export interface BadgeProps {
  children: ReactNode;
  tone?: 'accent' | 'caution';
  className?: string;
}

export function Badge({ children, tone = 'accent', className }: BadgeProps) {
  const classes = [
    styles.badge,
    tone === 'caution' && styles.caution,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <span className={classes}>{children}</span>;
}
