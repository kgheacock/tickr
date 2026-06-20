/**
 * Standardised data table — the newsprint table chrome shared by every list
 * (the waiver wire, the My Team roster, …). It styles `<th>`/`<td>` via
 * descendant selectors, so callers write plain `<thead>/<tbody>/<th>/<td>` and
 * inherit one treatment. Column- and view-specific bits (numeric alignment, a
 * short-row tint) stay as the caller's own classes layered on top.
 *
 * Use <TableRow clickable> for interactive rows (it carries the hover/focus
 * affordance + keyboard semantics belong to the caller).
 */
import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import styles from './Table.module.css';

export type TableProps = TableHTMLAttributes<HTMLTableElement>;

export function Table({ className, children, ...rest }: TableProps) {
  return (
    <table
      className={className ? `${styles.table} ${className}` : styles.table}
      {...rest}
    >
      {children}
    </table>
  );
}

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Opt into the interactive row affordance (cursor + hover/focus tint). */
  clickable?: boolean;
}

export function TableRow({
  clickable,
  className,
  children,
  ...rest
}: TableRowProps) {
  const cls = [clickable ? styles.clickable : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <tr className={cls || undefined} {...rest}>
      {children}
    </tr>
  );
}

export type SortDir = 'asc' | 'desc';

/** The table-wide sort: which column key is active and its direction. */
export interface SortState {
  key: string;
  dir: SortDir;
}

/**
 * The sort a header click should produce: a newly chosen column opens
 * ascending; clicking the already-active column flips its direction. Callers
 * pass this through to their own sort state so the cycle stays consistent.
 */
export function nextSort(current: SortState | null, key: string): SortState {
  if (current && current.key === key) {
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { key, dir: 'asc' };
}

export interface SortHeaderProps extends Omit<
  ThHTMLAttributes<HTMLTableCellElement>,
  'onClick'
> {
  /** This column's sort key, matched against the active `sort`. */
  sortKey: string;
  /** The table's current sort, or null when unsorted. */
  sort: SortState | null;
  /** Activated (click/Enter/Space) with this column's key. */
  onSort: (key: string) => void;
  children: ReactNode;
}

/**
 * A sortable `<th>`: the column label as a button, with a direction arrow that
 * shows on the active column (and a faint ⇅ hint on hover for the rest, so the
 * resting header stays clean). Sets `aria-sort` for assistive tech. Pair with
 * `nextSort` to drive the asc/desc cycle.
 */
export function SortHeader({
  sortKey,
  sort,
  onSort,
  className,
  children,
  ...rest
}: SortHeaderProps) {
  const active = sort?.key === sortKey ? sort.dir : null;
  const ariaSort =
    active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none';
  return (
    <th
      aria-sort={ariaSort}
      className={
        className ? `${styles.sortHead} ${className}` : styles.sortHead
      }
      {...rest}
    >
      <button
        type="button"
        className={styles.sortButton}
        onClick={() => onSort(sortKey)}
      >
        <span>{children}</span>
        <span className={styles.sortArrow} aria-hidden="true">
          {active === 'asc' ? '↑' : active === 'desc' ? '↓' : '↕'}
        </span>
      </button>
    </th>
  );
}
