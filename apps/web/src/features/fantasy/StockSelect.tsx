/**
 * StockSelect — a custom listbox for picking which roster stock to drop.
 *
 * The BuyModal's drop-picker needs to show each candidate's symbol, company, and
 * its coloured specialization chips so a full-roster buy reads as an informed
 * swap. A native <select> holds only plain text (see SlotSelect's note), so this
 * is the same thin WAI-ARIA listbox pattern — trigger + popup that own
 * arrow / Home / End / Enter / Space / Escape, type-ahead on the symbol, and
 * focus-return on close — rendering a stock identity row instead of a lone chip.
 *
 * Chips are drawn inline with CategoryChip's `noTooltip` (not the SpecChips
 * wrapper): the listbox owns its own focus model, and a tooltip per chip would
 * add stray tab stops, exactly the trap SlotSelect calls out.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { PlayerInventoryItem } from '@tickr/shared-types';
import { SLOT_LABELS, specializationsOf } from './api';
import { CategoryChip } from '../../components';
import styles from './StockSelect.module.css';

interface StockSelectProps {
  /** Currently-selected stock symbol. */
  value: string;
  /** Droppable roster stocks to offer. */
  options: PlayerInventoryItem[];
  onChange: (symbol: string) => void;
  className?: string;
  'aria-label'?: string;
}

/** A stock's identity row: symbol, company, then its earned specialization chips
 *  as single initials (universal slots stripped, matching SpecChips). Shared by
 *  the trigger (closed state) and every option. */
function StockTag({ item }: { item: PlayerInventoryItem }) {
  const specs = specializationsOf(item.groups);
  return (
    <span className={styles.tag}>
      <span className={styles.symbol}>{item.symbol}</span>
      {item.name && <span className={styles.name}>{item.name}</span>}
      {specs.length > 0 && (
        <span className={styles.chips}>
          {specs.map((g) => (
            <CategoryChip key={g} group={g} noTooltip>
              {(SLOT_LABELS[g] ?? g).charAt(0)}
            </CategoryChip>
          ))}
        </span>
      )}
    </span>
  );
}

export function StockSelect({
  value,
  options,
  onChange,
  className,
  'aria-label': ariaLabel,
}: StockSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ buf: '', at: 0 });
  const baseId = useId();

  // Fall back to the first stock when the saved value isn't in the offered set.
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.symbol === value),
  );
  const selected = options[selectedIndex];

  const openList = () => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  const pick = (symbol: string) => {
    onChange(symbol);
    close();
  };

  // Click-outside closes without stealing focus (it's already leaving).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Move focus into the list once it mounts so the arrow keys land there.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const move = (delta: number) =>
    setActive((i) => (i + delta + options.length) % options.length);

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const opt = options[active];
        if (opt) pick(opt.symbol);
        break;
      }
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close(false);
        break;
      default:
        // Type-ahead: buffer printable keys (reset after a short pause) and jump
        // to the first stock whose symbol starts with what's been typed.
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          const t = typeahead.current;
          t.buf = now - t.at > 600 ? e.key : t.buf + e.key;
          t.at = now;
          const q = t.buf.toLowerCase();
          const idx = options.findIndex((o) =>
            o.symbol.toLowerCase().startsWith(q),
          );
          if (idx >= 0) setActive(idx);
        }
    }
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openList();
    }
  };

  return (
    <div ref={rootRef} className={`${styles.root} ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onTriggerKey}
      >
        {selected && <StockTag item={selected} />}
      </button>
      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className={styles.list}
          aria-activedescendant={`${baseId}-${active}`}
          onKeyDown={onListKey}
        >
          {options.map((item, i) => (
            <li
              key={item.symbol}
              id={`${baseId}-${i}`}
              role="option"
              aria-selected={item.symbol === value}
              className={`${styles.option} ${i === active ? styles.active : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(item.symbol)}
            >
              <StockTag item={item} />
              {item.symbol === value && (
                <span className={styles.check} aria-hidden>
                  ✓
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
