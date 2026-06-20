/**
 * Badge — a small outlined uppercase pill for inline status tags, e.g. the
 * "In progress" marker on a not-yet-settled week's score. Accent (blue) spot-ink
 * by default, matching the newsprint UI. Spacing is left to the caller (flex gap
 * or a margin via `className`) so the pill stays placement-agnostic.
 */
import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export interface BadgeProps {
  children: ReactNode;
  className?: string;
}

export function Badge({ children, className }: BadgeProps) {
  return (
    <span className={className ? `${styles.badge} ${className}` : styles.badge}>
      {children}
    </span>
  );
}
