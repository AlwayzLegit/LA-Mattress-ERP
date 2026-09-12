'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { signOut } from '@/lib/auth-client';
import { ConfirmDialog } from './confirm-dialog';

export interface MenuUser {
  name: string | null;
  email: string;
  roleName: string | null;
}

function initialsOf(name: string | null, email: string): string {
  const src = (name?.trim() || email.split('@')[0] || '?').replace(/[._-]+/g, ' ');
  const parts = src.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : (parts[0]?.[1] ?? '');
  return (a + b).toUpperCase();
}

/**
 * Avatar button + the account menu from the design: selling store,
 * shortcuts, help, sign out (with the option to revoke
 * every other device's session).
 */
export function UserMenu({
  user,
  sellingStore,
  canChangeStore,
  onChangeStore,
  onShortcuts,
}: {
  user: MenuUser;
  sellingStore: string | null;
  canChangeStore: boolean;
  onChangeStore: () => void;
  onShortcuts: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [others, setOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const initials = initialsOf(user.name, user.email);
  const first = (user.name?.trim().split(/\s+/)[0] ?? user.email.split('@')[0]) || 'You';

  async function doSignOut() {
    setBusy(true);
    try {
      if (others) {
        try {
          const sessions = await api<{ id: string; current: boolean }[]>('/v1/auth/sessions');
          await Promise.all(
            sessions
              .filter((s) => !s.current)
              .map((s) => api(`/v1/auth/sessions/${s.id}`, { method: 'DELETE' })),
          );
        } catch {
          // Best effort — the local sign-out still proceeds.
        }
      }
      await signOut();
      window.location.href = '/login';
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'relative', marginLeft: 4 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="user-menu"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '3px 8px 3px 3px',
          border: '1px solid var(--border)',
          borderRadius: 20,
          background: 'var(--surface)',
          cursor: 'pointer',
          color: 'inherit',
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            background: 'var(--accent-soft)',
            color: 'var(--accent-ink)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {initials}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 500 }} className="hidden sm:inline">
          {first}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu" style={{ width: 300, top: 38 }} role="menu">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: 14,
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent-ink)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 13,
                  fontWeight: 600,
                  flex: 'none',
                }}
              >
                {initials}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{user.name ?? user.email}</div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {user.email}
                </div>
              </div>
              {user.roleName && (
                <span
                  style={{
                    padding: '2px 7px',
                    borderRadius: 4,
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    fontSize: 11,
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user.roleName}
                </span>
              )}
            </div>
            <div style={{ padding: 6 }}>
              {sellingStore && (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setOpen(false);
                    if (canChangeStore) onChangeStore();
                  }}
                >
                  <span style={{ color: 'var(--muted)' }}>⌂</span>
                  <span style={{ flex: 1 }}>
                    Selling at <strong style={{ fontWeight: 600 }}>{sellingStore}</strong>
                  </span>
                  {canChangeStore && (
                    <span style={{ fontSize: 11.5, color: 'var(--accent-ink)' }}>Change</span>
                  )}
                </button>
              )}
              <a className="menu-item" href="/settings" onClick={() => setOpen(false)}>
                <span style={{ color: 'var(--muted)' }}>◉</span>
                <span style={{ flex: 1 }}>Settings</span>
              </a>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  onShortcuts();
                }}
              >
                <span style={{ color: 'var(--muted)' }}>⌨</span>
                <span style={{ flex: 1 }}>Keyboard shortcuts</span>
                <kbd className="key">?</kbd>
              </button>
              <a className="menu-item" href="/reports" onClick={() => setOpen(false)}>
                <span style={{ color: 'var(--muted)' }}>?</span>
                <span style={{ flex: 1 }}>Reports &amp; help</span>
              </a>
            </div>
            <div
              style={{
                padding: 6,
                borderTop: '1px solid var(--border)',
                background: 'var(--surface2)',
              }}
            >
              <button
                type="button"
                className="menu-item"
                style={{ color: 'var(--danger)', fontWeight: 500 }}
                data-testid="sign-out"
                onClick={() => {
                  setOpen(false);
                  setConfirm(true);
                }}
              >
                <span>⎋</span>
                <span style={{ flex: 1 }}>Sign out</span>
              </button>
            </div>
          </div>
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title="Sign out of LA Mattress ERP?"
          confirmLabel="Sign out"
          cancelLabel="Stay signed in"
          tone="danger"
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void doSignOut()}
          testid="sign-out-confirm"
        >
          <p style={{ margin: '0 0 14px' }}>
            {sellingStore ? (
              <>
                Your drawer at <strong style={{ fontWeight: 600 }}>{sellingStore}</strong> stays
                open.{' '}
              </>
            ) : null}
            Unsaved drafts are kept on this device.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={others}
              onChange={(e) => setOthers(e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            Also sign out my other devices
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}
