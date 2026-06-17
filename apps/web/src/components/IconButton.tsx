/**
 * Square, icon-only button — the corner close (×), a row's remove (×), and
 * similar glyph affordances. The glyph is passed as `children`.
 *
 * `aria-label` is required by the type: an icon-only control has no text for a
 * screen reader, so omitting it would ship an inaccessible button. `type`
 * defaults to "button" for the same reason as <Button>.
 *
 * `tone="danger"` recolours destructive actions (e.g. remove); `default`
 * fills on hover for neutral actions (e.g. close).
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import styles from './IconButton.module.css';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — icon-only buttons have no accessible name otherwise. */
  'aria-label': string;
  tone?: 'default' | 'danger';
  size?: 'sm' | 'md';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { tone = 'default', size = 'md', type = 'button', className, ...rest },
    ref,
  ) {
    const classes = [styles.button, styles[tone], styles[size]];
    if (className) classes.push(className);

    return (
      <button ref={ref} type={type} className={classes.join(' ')} {...rest} />
    );
  },
);
