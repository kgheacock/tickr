/**
 * SlotSelect — a custom listbox for picking a coloured category: a roster slot in
 * the lineup editor, or a specialization in the waiver-wire filter.
 *
 * A native <select> can only hold plain text, so neither could show a category's
 * coloured CategoryChip in the closed control or its options. This is a thin
 * WAI-ARIA listbox (button trigger + popup) that renders each option as its
 * spot-ink chip; a value with no group colour (Bench, or the filter's "All")
 * stays a plain muted label.
 *
 * Focus model: the trigger opens the popup and focus moves into the list, which
 * owns arrow / Home / End / Enter / Space / Escape and printable type-ahead via
 * aria-activedescendant. Closing (pick, Escape, or click-outside) returns focus
 * to the trigger so the control behaves like the native element it replaces.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { SLOT_LABELS, isPlayerGroup } from './api';
import { CategoryChip } from '../../components';
import styles from './SlotSelect.module.css';

interface SlotSelectProps {
  /** Currently-selected option key (e.g. 'anchor', 'bench', or '' for "All"). */
  value: string;
  /** Ordered option keys to offer. */
  options: string[];
  onChange: (slot: string) => void;
  /** Label overrides keyed by option value, taking precedence over SLOT_LABELS.
   *  Lets non-slot callers name a neutral option — e.g. the waiver-wire filter's
   *  '' → "All specializations". */
  labels?: Record<string, string>;
  className?: string;
  'aria-label'?: string;
}

/** An option rendered as its coloured chip, or a plain label for a colourless
 *  value (Bench, or the filter's "All"). Shared by the trigger (closed state)
 *  and every option. */
function SlotTag({ slot, label }: { slot: string; label: string }) {
  return isPlayerGroup(slot) ? (
    <CategoryChip group={slot} noTooltip>
      {label}
    </CategoryChip>
  ) : (
    <span className={styles.benchTag}>{label}</span>
  );
}

export function SlotSelect({
  value,
  options,
  onChange,
  labels,
  className,
  'aria-label': ariaLabel,
}: SlotSelectProps) {
  // Resolve an option's display text: caller override, then the slot map, then
  // the raw key. Shared by the chips and the type-ahead so both stay in step.
  const labelOf = (slot: string) => labels?.[slot] ?? SLOT_LABELS[slot] ?? slot;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ buf: '', at: 0 });
  const baseId = useId();

  // Bench is the safe fallback when the saved value isn't in the offered set.
  const selectedIndex = Math.max(0, options.indexOf(value));

  const openList = () => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  const pick = (slot: string) => {
    onChange(slot);
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
        const slot = options[active];
        if (slot) pick(slot);
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
        // to the first slot whose label starts with what's been typed.
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          const t = typeahead.current;
          t.buf = now - t.at > 600 ? e.key : t.buf + e.key;
          t.at = now;
          const q = t.buf.toLowerCase();
          const idx = options.findIndex((o) =>
            labelOf(o).toLowerCase().startsWith(q),
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
        <SlotTag slot={value} label={labelOf(value)} />
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
          {options.map((slot, i) => (
            <li
              key={slot}
              id={`${baseId}-${i}`}
              role="option"
              aria-selected={slot === value}
              className={`${styles.option} ${i === active ? styles.active : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(slot)}
            >
              <SlotTag slot={slot} label={labelOf(slot)} />
              {slot === value && (
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
