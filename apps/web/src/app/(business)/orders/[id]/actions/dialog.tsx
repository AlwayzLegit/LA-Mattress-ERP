'use client';

import { useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '@/components/ui';

/**
 * The one dialog chrome every A20 action shares: overlay, panel, sticky
 * head, body, optional foot. Escape and the backdrop close it. Built on
 * the `.overlay / .dialog` classes in globals.css so it matches the
 * product-search and shift-editor dialogs.
 */
export function ActionDialog({
  title,
  onClose,
  children,
  foot,
  wide,
  testId,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  // Escape, the focus trap and the return of focus to the opener come
  // from the shared hook (Phase 12), the same as the kit's Dialog.
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panel, { onClose });
  return (
    <div className="overlay overlay-center" onMouseDown={onClose} data-testid={testId}>
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ maxWidth: wide ? 960 : 640 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h3 id={titleId} style={{ flex: 1 }}>
            {title}
          </h3>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
            data-testid="dialog-close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {foot && <div className="dialog-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
