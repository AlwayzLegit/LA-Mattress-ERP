'use client';

import { useRef, type ReactNode } from 'react';
import { Button, Dialog } from '@/components/ui';

/**
 * Confirmation (canvas 2e): `role=alertdialog`, the title is the
 * question, one paragraph says what happens, the safe button is the
 * default focus, and a destructive action is outlined — never filled.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
  testid,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testid?: string;
}) {
  const safe = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      alert
      size="sm"
      title={title}
      onClose={onCancel}
      initialFocus={safe}
      hideClose
      testId={testid}
      style={{ zIndex: 71 }}
      foot={
        <>
          <Button ref={safe} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
