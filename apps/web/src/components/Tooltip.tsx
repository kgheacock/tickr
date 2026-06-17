/**
 * Editorial annotation tooltip. The trigger is an inline anchor; the bubble is
 * a slip of newsprint floated above it — paper fill, a hairline black rule, and
 * the Modal's soft lift — tailed with a caret pointing back down at the trigger.
 *
 * The bubble is rendered through a portal positioned with `position: fixed` from
 * the trigger's measured rect, so it escapes any clipping ancestor (e.g. the
 * Modal sheet's `overflow-y: auto`). When the trigger sits inside a <dialog> the
 * portal targets that dialog rather than document.body, so the bubble joins the
 * dialog's top layer and paints above the modal instead of behind it.
 *
 * Accessibility: the trigger is focusable and points at the bubble via
 * aria-describedby; the bubble mounts on hover/focus (when the description is
 * needed) so the id resolves while focused. Escape dismisses it.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

/** Gap between the bubble's lower edge and the top of the trigger. */
const GAP_PX = 8;

export interface TooltipProps {
  /** The note shown above the trigger on hover / focus. */
  content: ReactNode;
  /** The element the note describes; wrapped in a focusable trigger. */
  children: ReactNode;
  /** Extra class for the inline trigger wrapper. */
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [container, setContainer] = useState<Element | null>(null);
  const id = useId();

  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.top - GAP_PX, left: r.left + r.width / 2 });
  };

  const show = () => {
    const el = triggerRef.current;
    if (el) setContainer(el.closest('dialog') ?? document.body);
    measure();
    setOpen(true);
  };
  const hide = () => setOpen(false);

  // Keep the fixed bubble pinned to the trigger if anything scrolls or resizes
  // while it's open (capture catches scrolls inside the Modal sheet too).
  useEffect(() => {
    if (!open) return;
    const onMove = () => measure();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const classes = [styles.trigger];
  if (className) classes.push(className);

  return (
    <span
      ref={triggerRef}
      className={classes.join(' ')}
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === 'Escape') hide();
      }}
    >
      {children}
      {open &&
        pos &&
        container &&
        createPortal(
          <span
            role="tooltip"
            id={id}
            className={styles.bubble}
            style={{ top: pos.top, left: pos.left }}
          >
            {content}
          </span>,
          container,
        )}
    </span>
  );
}
