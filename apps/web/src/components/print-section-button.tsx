'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui';
import { printSection } from '@/lib/print-section';

/**
 * A card's own Print: prints the card it sits in (the nearest `.card`)
 * and nothing else on the page.
 */
export function PrintSectionButton({ testid }: { testid?: string }) {
  return (
    <Button
      size="sm"
      variant="primary"
      className="no-print"
      data-testid={testid}
      onClick={(e) => {
        const card = e.currentTarget.closest<HTMLElement>('.card');
        if (card) printSection(card);
        else window.print();
      }}
    >
      <Printer size={14} aria-hidden /> Print
    </Button>
  );
}
