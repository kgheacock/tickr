/**
 * Standardised tab strip — a row of routed NavLinks with the newsprint
 * underline-on-active treatment. Extracted from the league layout header so any
 * routed section can share one tab look instead of re-implementing the markup.
 *
 * Each item maps to a route; `end` matches the path exactly (use it on index
 * tabs so a child route doesn't keep the parent tab highlighted).
 */
import { NavLink } from 'react-router-dom';
import styles from './Tabs.module.css';

export interface TabItem {
  to: string;
  label: string;
  end?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  className?: string;
}

export function Tabs({ items, className }: TabsProps) {
  return (
    <nav className={className ? `${styles.nav} ${className}` : styles.nav}>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
