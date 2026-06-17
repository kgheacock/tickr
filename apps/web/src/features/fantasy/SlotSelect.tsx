/**
 * SlotSelect — a custom listbox for picking which roster slot a stock fills.
 *
 * A native <select> can only hold plain text, so the lineup editor couldn't show
 * a slot's coloured CategoryChip in the closed control or its options. This is a
 * thin WAI-ARIA listbox (button trigger + popup) that renders each slot as its
 * spot-ink chip (Bench, which has no group colour, stays a plain muted label).
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
  /** Currently-selected slot key (e.g. 'anchor', 'defense', 'bench'). */
  value: string;
  /** Ordered slot keys to offer, including 'bench'. */
  options: string[];
  onChange: (slot: string) => void;
  className?: string;
  'aria-label'?: string;
}

/** A slot rendered as its coloured chip, or a plain label for the colourless
 *  Bench. Shared by the trigger (closed state) and every option. */
function SlotTag({ slot }: { slot: string }) {
  const label = SLOT_LABELS[slot] ?? slot;
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
  className,
  'aria-label': ariaLabel,
}: SlotSelectProps) {
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
            (SLOT_LABELS[o] ?? o).toLowerCase().startsWith(q),
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
        <SlotTag slot={value} />
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
              <SlotTag slot={slot} />
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
