/**
 * Standardised action button for the Fantasy Street UI — the newsprint
 * treatment lifted out of the create-league form so every CTA reads the same.
 *
 * Variants: `primary` (filled editorial blue, the affirmative action),
 * `secondary` (outlined, the cancel/neutral action) and `ghost` (an inline
 * text/link button with no chrome, e.g. "+ Add manager").
 *
 * `type` defaults to "button" on purpose: most of our buttons live inside
 * <form>s and a default of "submit" would fire the form by accident. Pass
 * `type="submit"` explicitly for the form's primary action.
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = 'primary', size = 'md', type = 'button', className, ...rest },
    ref,
  ) {
    const classes = [styles.button, styles[variant]];
    // Ghost is an inline link with no padding, so the size scale doesn't apply.
    if (variant !== 'ghost') classes.push(styles[size]);
    if (className) classes.push(className);

    return (
      <button ref={ref} type={type} className={classes.join(' ')} {...rest} />
    );
  },
);
