'use client';

import { Dialog, Kbd } from '@/components/ui';

const GROUPS: { label: string; items: { label: string; keys: string }[] }[] = [
  {
    label: 'Navigate',
    items: [
      { label: 'Search / go to', keys: 'mod+k' },
      { label: 'Orders', keys: 'g o' },
      { label: 'Deliveries', keys: 'g d' },
      { label: 'Products', keys: 'g p' },
      { label: 'Customers', keys: 'g c' },
      { label: 'Reports', keys: 'g r' },
      { label: 'Dashboard', keys: 'g h' },
    ],
  },
  {
    label: 'Act',
    items: [
      { label: 'New sale', keys: 'n' },
      { label: 'Add product (register)', keys: 'F2' },
      { label: 'Take payment (register)', keys: 'F8' },
      { label: 'Change period (dashboard)', keys: 'p' },
      { label: 'Table page prev / next', keys: '[ ]' },
      { label: 'This panel', keys: '?' },
      { label: 'Close anything', keys: 'esc' },
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} size="md" style={{ zIndex: 71 }}>
      <div className="shortcuts">
        {GROUPS.map((g) => (
          <div key={g.label}>
            <div className="t-label" style={{ margin: '4px 0 8px' }}>
              {g.label}
            </div>
            {g.items.map((s) => (
              <div key={s.label} className="shortcuts-row">
                <span>{s.label}</span>
                <Kbd keys={s.keys} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
