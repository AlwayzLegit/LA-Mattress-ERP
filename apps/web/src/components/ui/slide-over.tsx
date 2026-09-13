'use client';

import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { cx } from './cx';
import { useFocusTrap } from './focus-trap';

/**
 * Slide-over (canvas 2e): a 640px sheet from the right with the dialog
 * semantics (`role=dialog aria-modal aria-labelledby`, focus trap, Esc,
 * focus return). Header: title (mono for a document number) · meta ·
 * Close. 160ms slide; none under reduced motion.
 */
export function SlideOver({
  title,
  meta,
  onClose,
  children,
  foot,
  width = 640,
  initialFocus,
  mono = false,
  className,
  testId,
}: {
  title: ReactNode;
  /** Chips and the meta line beside the title (status, customer · store · written by). */
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  width?: number;
  initialFocus?: RefObject<HTMLElement | null>;
  /** Title is a document number: JetBrains Mono 17px. */
  mono?: boolean;
  className?: string;
  testId?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panel, { onClose, initialFocus });
  return (
    <div className="overlay" onMouseDown={onClose} data-testid={testId}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx('slide-over', className)}
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="slide-over-head">
          <h2 id={titleId} className={cx('slide-over-title', mono && 'slide-over-title-mono')}>
            {title}
          </h2>
          {meta && <div className="slide-over-meta">{meta}</div>}
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
            data-testid="slide-over-close"
            style={{ marginLeft: 'auto' }}
          >
            <X size={16} />
          </button>
        </div>
        <div className="slide-over-body">{children}</div>
        {foot && <div className="slide-over-foot">{foot}</div>}
      </div>
    </div>
  );
}
