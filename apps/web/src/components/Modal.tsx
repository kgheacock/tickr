/**
 * Reusable modal dialog — a sheet of newsprint floated over a dimmed page,
 * matching the landing/leagues Wall Street Journal treatment.
 *
 * Built on the native <dialog> via showModal(), so centering, the
 * semi-transparent backdrop, Escape-to-close and focus trapping all come for
 * free; we add backdrop-click-to-close and a corner close (×) on top.
 *
 * Content is supplied as `children`. An optional masthead-style header
 * (kicker + title with the double-rule treatment) renders when `title` is set —
 * everything else is up to the caller.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import styles from './Modal.module.css';

interface ModalProps {
  /** Called on Escape, backdrop click, or the corner close button. */
  onClose: () => void;
  /** Accessible name for the dialog. Falls back to `title` when omitted. */
  label?: string;
  /** Optional masthead headline; renders the double-rule header when set. */
  title?: string;
  /** Optional eyebrow above the title (e.g. a section name). */
  kicker?: string;
  /** Hide the corner close button (e.g. for a blocking confirmation). */
  hideClose?: boolean;
  children: ReactNode;
}

export function Modal({
  onClose,
  label,
  title,
  kicker,
  hideClose = false,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Open as a true modal once mounted. The `open` guard keeps StrictMode's
  // double-invoked effect from calling showModal() on an already-open dialog,
  // which throws.
  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-label={label ?? title}
      // Escape (the dialog's `cancel` event) and backdrop clicks both close.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // The dialog element fills the viewport behind its content padding, so a
      // click landing on the element itself (not its inner content) is a
      // backdrop click. This relies on the dialog having no padding of its own.
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className={styles.sheet}>
        {hideClose ? null : (
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        )}
        {title ? (
          <header className={styles.header}>
            {kicker ? <p className={styles.kicker}>{kicker}</p> : null}
            <h2 className={styles.title}>{title}</h2>
          </header>
        ) : null}
        {children}
      </div>
    </dialog>
  );
}
