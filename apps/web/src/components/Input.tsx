/**
 * Standardised text input. A thin wrapper over the native <input> so every
 * `type` (text, email, number, search…) and native prop pass straight through;
 * it only owns the newsprint styling and the accent focus ring.
 *
 * Forwards a ref and stays controlled — drop-in for the bare <input>s the forms
 * used before.
 */
import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './Input.module.css';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={className ? `${styles.input} ${className}` : styles.input}
      {...rest}
    />
  );
});
