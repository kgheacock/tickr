/**
 * Standardised dropdown. Wraps the native <select>; <option> children and all
 * native props pass through. Styled to match <Input> (sans face, radius-md) so
 * inputs and selects sit on the same baseline — deliberately unifying the
 * earlier mono/radius-sm divergence in the inventory filter bar.
 */
import { forwardRef, type SelectHTMLAttributes } from 'react';
import styles from './Select.module.css';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={className ? `${styles.select} ${className}` : styles.select}
        {...rest}
      >
        {children}
      </select>
    );
  },
);
