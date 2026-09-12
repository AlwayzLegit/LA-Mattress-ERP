'use client';

const GROUPS: { label: string; items: { label: string; keys: string[] }[] }[] = [
  {
    label: 'Navigate',
    items: [
      { label: 'Search / jump to', keys: ['⌘', 'K'] },
      { label: 'Go to orders', keys: ['G', 'O'] },
      { label: 'Go to deliveries', keys: ['G', 'D'] },
      { label: 'Go to inventory', keys: ['G', 'I'] },
      { label: 'Go to customers', keys: ['G', 'C'] },
      { label: 'Home', keys: ['G', 'H'] },
    ],
  },
  {
    label: 'Act',
    items: [
      { label: 'New sale', keys: ['N'] },
      { label: 'Change period (dashboard)', keys: ['P'] },
      { label: 'Table page prev / next', keys: ['[', ']'] },
      { label: 'This panel', keys: ['?'] },
      { label: 'Close anything', keys: ['Esc'] },
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay overlay-center" style={{ zIndex: 70 }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal
        aria-label="Keyboard shortcuts"
        className="dialog"
        style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h3>Keyboard shortcuts</h3>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0 24px',
            padding: '14px 18px 18px',
          }}
        >
          {GROUPS.map((g) => (
            <div key={g.label}>
              <div className="eyebrow" style={{ fontSize: 10.5, margin: '6px 0 8px' }}>
                {g.label}
              </div>
              {g.items.map((s) => (
                <div
                  key={s.label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 12.5,
                  }}
                >
                  <span>{s.label}</span>
                  <span style={{ display: 'flex', gap: 4 }}>
                    {s.keys.map((k) => (
                      <kbd
                        key={k}
                        className="key"
                        style={{
                          fontSize: 11,
                          padding: '1px 6px',
                          borderBottomWidth: 2,
                          background: 'var(--surface2)',
                          color: 'var(--text)',
                        }}
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
