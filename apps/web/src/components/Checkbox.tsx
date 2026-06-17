/**
 * Standardised checkbox with an inline label. Renders <label><input/><span/></>
 * so the whole control is clickable; the native checkbox keeps the accent tint.
 * `label` is the visible text; remaining props pass to the underlying <input>.
 */
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type'
> {
  label: ReactNode;
  /** Class applied to the wrapping <label> (positioning, layout). */
  className?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ label, className, ...rest }, ref) {
    return (
      <label
        className={className ? `${styles.wrap} ${className}` : styles.wrap}
      >
        <input ref={ref} type="checkbox" className={styles.input} {...rest} />
        <span>{label}</span>
      </label>
    );
  },
);
