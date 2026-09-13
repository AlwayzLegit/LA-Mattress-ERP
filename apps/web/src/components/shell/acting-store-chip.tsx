'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '@/components/ui';
import { useActingStore } from '@/lib/acting-store';

/**
 * "Acting for {Store}" — the first control in the topbar (canvas 3a):
 * accent-soft fill so it cannot be missed. Click opens the store list
 * (keyboard: arrows, Enter, Esc). A selling-restricted member on their
 * first login must pick before anything else.
 */
export function ActingStoreChip() {
  const acting = useActingStore();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelector<HTMLElement>('[role=menuitemradio]');
    first?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const items = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role=menuitemradio]') ?? [],
    );
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const label = acting.store?.name ?? (acting.meReady ? 'this store' : '…');

  return (
    <div className="acting" data-testid="selling-store-chip">
      <button
        ref={btn}
        type="button"
        className="acting-chip"
        title="Every sale, drawer and report on this screen is for this store"
        aria-haspopup={acting.canSwitch ? 'menu' : undefined}
        aria-expanded={acting.canSwitch ? open : undefined}
        onClick={() => acting.canSwitch && setOpen((v) => !v)}
        disabled={!acting.canSwitch && !acting.store}
      >
        <span className="acting-glyph" aria-hidden>
          ⌂
        </span>
        <span className="acting-text">
          Acting for <strong>{label}</strong>
        </span>
        {acting.canSwitch && (
          <span className="acting-caret" aria-hidden>
            ▾
          </span>
        )}
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label="Act for a store"
          className="menu menu-left acting-menu"
          onKeyDown={onListKey}
        >
          <div className="acting-menu-head">Every sale, drawer and report follows this.</div>
          {acting.choices.map((loc) => {
            const current = acting.store?.id === loc.id;
            return (
              <button
                key={loc.id}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                className={`menu-item${current ? ' is-current' : ''}`}
                data-testid={`pick-store-${loc.id}`}
                onClick={() => {
                  acting.setStore(loc);
                  close();
                }}
              >
                <span className="acting-glyph" aria-hidden>
                  ⌂
                </span>
                <span style={{ flex: 1 }}>{loc.name}</span>
                {loc.locationType === 'warehouse' && (
                  <span className="t-mono-sm" style={{ color: 'var(--muted)' }}>
                    warehouse
                  </span>
                )}
                {current && (
                  <span className="t-mono-sm" style={{ color: 'var(--muted)' }}>
                    current
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {acting.mustPick && acting.choices.length > 0 && <FirstPick />}
    </div>
  );
}

/** First-login picker for selling-restricted members with several approved stores. */
function FirstPick() {
  const acting = useActingStore();
  const first = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      size="sm"
      title="Which store are you selling at today?"
      description="Everything you ring this session, including money tendered, counts toward the store you pick."
      onClose={acting.dismissPick}
      initialFocus={first}
      closeOnBackdrop={false}
      hideClose={!acting.store}
      testId="store-picker"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {acting.choices.map((loc, i) => {
          const current = acting.store?.id === loc.id;
          return (
            <Button
              key={loc.id}
              ref={i === 0 ? first : undefined}
              variant={current ? 'primary' : 'secondary'}
              data-testid={`pick-store-${loc.id}`}
              onClick={() => acting.setStore(loc, { silent: true })}
              style={{ justifyContent: 'flex-start', height: 38 }}
            >
              <span aria-hidden>⌂</span> {loc.name}
              {current && (
                <span className="t-mono-sm" style={{ marginLeft: 'auto' }}>
                  current
                </span>
              )}
            </Button>
          );
        })}
      </div>
    </Dialog>
  );
}
