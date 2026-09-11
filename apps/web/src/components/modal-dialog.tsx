'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * The shared dialog chrome (overlay, panel, sticky head, body, optional
 * foot) on the `.overlay / .dialog` classes in globals.css — the same
 * shell the order-page actions, the product search and the shift editor
 * use. Escape and the backdrop close it.
 */
export function ModalDialog({
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay overlay-center" onMouseDown={onClose} data-testid={testId}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: wide ? 960 : 640 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h3 style={{ flex: 1 }}>{title}</h3>
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
