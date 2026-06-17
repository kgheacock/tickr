/**
 * Labelled form field — pairs the standard uppercase sans label with a control
 * (an <Input>, <Select>, or anything else passed as children) stacked beneath
 * it. Renders a <label> so clicking the text focuses the control.
 *
 * This is the canonical way to label a field in the Fantasy Street forms; the
 * `.label` treatment used to be copied into every form's CSS module.
 */
import { type ReactNode } from 'react';
import styles from './Field.module.css';

export interface FieldProps {
  label: ReactNode;
  /** Extra class on the wrapping <label> (e.g. width constraints). */
  className?: string;
  children: ReactNode;
}

export function Field({ label, className, children }: FieldProps) {
  return (
    <label
      className={className ? `${styles.field} ${className}` : styles.field}
    >
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}
