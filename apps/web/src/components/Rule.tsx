/**
 * Newspaper rule — the horizontal dividers that section a newsprint page.
 *
 * `heavy` is the masthead rule: a 3px double line capped by a hairline, used to
 * set the flag off from the lead. `section` is the 2px solid running-head rule
 * under an interior page's title. `thin` is a single hairline between lesser
 * sections. Lifted out of the landing masthead so every page rules its sections
 * the same way.
 *
 * Decorative by default — purely a visual ornament. Vertical spacing is layout,
 * so it stays with the caller via `className`.
 */
import styles from './Rule.module.css';

export interface RuleProps {
  weight?: 'heavy' | 'section' | 'thin';
  /** Extra classes — typically the caller's vertical margins. */
  className?: string;
}

export function Rule({ weight = 'thin', className }: RuleProps) {
  const classes = [styles.rule, styles[weight]];
  if (className) classes.push(className);
  return <div className={classes.join(' ')} aria-hidden="true" />;
}
