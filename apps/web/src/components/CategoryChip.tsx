/**
 * Category chip — the uppercase pill that labels a stock's classification group
 * (Anchor / Growth / Momentum / Value / Defense / Wildcard).
 *
 * Each group carries its own muted "spot-ink" colour (see CategoryChip.module.css
 * + the --group-* tokens), so a roster's mix reads at a glance the way a printed
 * section key would. The chip is wrapped in a Tooltip that explains the category
 * on hover/focus, so the colour key is self-documenting everywhere it appears.
 * The label text is supplied by the caller (`children`) to keep this primitive
 * independent of the feature-side SLOT_LABELS map.
 */
import type { ReactNode } from 'react';
import type { PlayerGroup } from '@tickr/shared-types';
import { Tooltip } from './Tooltip';
import styles from './CategoryChip.module.css';

/** Plain-language note per category, shown on chip hover/focus (see classify.ts). */
const GROUP_BLURBS: Record<PlayerGroup, string> = {
  anchor: 'Lowest-volatility 25% of stocks — among the most heavily traded.',
  growth: 'Top 25% by 12-month return — the strongest year-long performers.',
  momentum: 'Top 25% by 3-month return — the hottest recent movers.',
  value: 'Bottom 25% by 12-month return — beaten-down names.',
  defense: 'Universal slot — score points if the stock drops.',
  wildcard: 'Universal slot.',
};

export interface CategoryChipProps {
  /** Classification group — selects the spot-ink colour and the tooltip copy. */
  group: PlayerGroup;
  /** Display label (e.g. "Anchor"); usually SLOT_LABELS[group]. */
  children: ReactNode;
  className?: string;
  /** Render the bare pill without the explanatory Tooltip. The Tooltip wraps the
   *  chip in a focusable trigger, which is wrong in dense contexts that own their
   *  own focus model (e.g. the SlotSelect listbox, where each option must not be a
   *  separate tab stop and a tooltip-per-row would be noise). */
  noTooltip?: boolean;
}

export function CategoryChip({
  group,
  children,
  className,
  noTooltip,
}: CategoryChipProps) {
  const classes = [styles.chip, styles[group]];
  if (className) classes.push(className);
  const chip = <span className={classes.join(' ')}>{children}</span>;
  if (noTooltip) return chip;
  // Lead the caption with the category's name in bold. The group key is the
  // lowercase display name, so capitalising it matches SLOT_LABELS without
  // coupling this primitive to that feature-side map.
  const label = group.charAt(0).toUpperCase() + group.slice(1);
  return (
    <Tooltip
      content={
        <>
          <strong>{label}:</strong> {GROUP_BLURBS[group]}
        </>
      }
    >
      {chip}
    </Tooltip>
  );
}
