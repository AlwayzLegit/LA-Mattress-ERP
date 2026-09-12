'use client';

import type { ReactNode } from 'react';
import { Dialog } from '@/components/ui';

/**
 * Pre-redesign name for the shared dialog chrome; every caller keeps its
 * props. Built on `Dialog`, so it traps focus, closes on Esc and the
 * backdrop, returns focus to the opener, and is labelled by its title.
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
  return (
    <Dialog title={title} onClose={onClose} foot={foot} size={wide ? 'lg' : 'md'} testId={testId}>
      {children}
    </Dialog>
  );
}
