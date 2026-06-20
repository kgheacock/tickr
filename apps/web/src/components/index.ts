/**
 * Fantasy Street component library — the standardised, newsprint-themed UI
 * primitives. Import from here (`../../components`) rather than reaching for a
 * raw <button>/<input>/<select> so every control shares one treatment.
 */
export { Modal } from './Modal';
export {
  Table,
  TableRow,
  SortHeader,
  nextSort,
  type TableProps,
  type TableRowProps,
  type SortHeaderProps,
  type SortState,
  type SortDir,
} from './Table';
export { Tabs, type TabItem, type TabsProps } from './Tabs';
export { Button, type ButtonProps } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export { Input, type InputProps } from './Input';
export { Select, type SelectProps } from './Select';
export { Checkbox, type CheckboxProps } from './Checkbox';
export { Field, type FieldProps } from './Field';
export { Tooltip, type TooltipProps } from './Tooltip';
export { CategoryChip, type CategoryChipProps } from './CategoryChip';
export { Badge, type BadgeProps } from './Badge';

// Display primitives — the newsprint "mechanisms" the pages are built from.
export { Paper, type PaperProps } from './Paper';
export { Masthead, type MastheadProps } from './Masthead';
export { Rule, type RuleProps } from './Rule';
export { Kicker, type KickerProps } from './Kicker';
export { Subhead, type SubheadProps } from './Subhead';
export { Header } from './Header';
export { TickerTape } from './TickerTape';
export { LineChart, type ChartSeries, type ChartMarker } from './LineChart';
