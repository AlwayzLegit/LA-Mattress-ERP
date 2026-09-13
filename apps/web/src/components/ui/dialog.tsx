'use client';

import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { cx } from './cx';
import { useFocusTrap } from './focus-trap';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';
const WIDTHS: Record<DialogSize, number> = { sm: 420, md: 560, lg: 880, xl: 1080 };

/**
 * Dialog (canvas 2e): `role=dialog aria-modal aria-labelledby`, focus
 * trapped, Esc closes, focus returns to the opener. The title is the
 * question. `alert` switches to `role=alertdialog` for confirmations —
 * pass `initialFocus` pointing at the safe button so the destructive
 * action is never the default.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  foot,
  size = 'md',
  alert = false,
  initialFocus,
  closeOnBackdrop = true,
  hideClose = false,
  className,
  testId,
  style,
}: {
  title: ReactNode;
  /** One sentence under the title; wired to aria-describedby. */
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  /** Button row; right-aligned. */
  foot?: ReactNode;
  size?: DialogSize;
  alert?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  hideClose?: boolean;
  className?: string;
  testId?: string;
  style?: React.CSSProperties;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(panel, { onClose, initialFocus });
  return (
    <div
      className="overlay overlay-center"
      onMouseDown={closeOnBackdrop ? onClose : undefined}
      data-testid={testId}
    >
      <div
        ref={panel}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cx('dialog', className)}
        style={{ maxWidth: WIDTHS[size], ...style }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <div className="dialog-head-main">
            <h2 id={titleId} className="dialog-title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="dialog-desc">
                {description}
              </p>
            )}
          </div>
          {!hideClose && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Close"
              onClick={onClose}
              data-testid="dialog-close"
            >
              <X size={16} />
            </button>
          )}
        </div>
        {children != null && <div className="dialog-body">{children}</div>}
        {foot && <div className="dialog-foot">{foot}</div>}
      </div>
    </div>
  );
}
