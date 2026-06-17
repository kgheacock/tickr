/**
 * Page sheet — the newsprint "paper on a desk" surface: a centred white sheet
 * with a hairline border and a long soft drop shadow, floated on the warm-grey
 * desk (the app background showing through). Lifted out of the landing page so
 * every top-level page sits on the same sheet instead of bare desk.
 *
 * `width` caps the sheet (a CSS length); the desk gutter and inner padding are
 * the component's. Pass page content as `children`; render overlays such as a
 * <Modal> as a sibling of <Paper>, not inside it.
 */
import type { CSSProperties, ReactNode } from 'react';
import styles from './Paper.module.css';

export interface PaperProps {
  /** Max width of the sheet (a CSS length). Defaults to 1000px (the landing). */
  width?: string;
  className?: string;
  children: ReactNode;
}

export function Paper({ width, className, children }: PaperProps) {
  const classes = [styles.paper];
  if (className) classes.push(className);
  return (
    <div className={styles.desk}>
      <div
        className={classes.join(' ')}
        style={
          width ? ({ '--paper-width': width } as CSSProperties) : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
