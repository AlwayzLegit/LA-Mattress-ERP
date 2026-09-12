'use client';

import { useSyncExternalStore } from 'react';
import { cx } from './cx';

/**
 * Platform-aware shortcut chip (canvas 2e): `mod` renders as ⌘ on a Mac
 * and `Ctrl` on the Windows registers. The server renders the Windows
 * form; the client corrects after hydration, so nothing mismatches.
 */

export type Platform = 'mac' | 'other';

function detect(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(p) ? 'mac' : 'other';
}

const noop = () => () => {};

export function usePlatform(): Platform {
  return useSyncExternalStore(noop, detect, () => 'other');
}

const NAMES: Record<string, { mac: string; other: string }> = {
  mod: { mac: '⌘', other: 'Ctrl' },
  cmd: { mac: '⌘', other: 'Ctrl' },
  ctrl: { mac: '⌃', other: 'Ctrl' },
  alt: { mac: '⌥', other: 'Alt' },
  shift: { mac: '⇧', other: 'Shift' },
  enter: { mac: '↵', other: '↵' },
  return: { mac: '↵', other: '↵' },
  esc: { mac: 'esc', other: 'Esc' },
  escape: { mac: 'esc', other: 'Esc' },
  up: { mac: '↑', other: '↑' },
  down: { mac: '↓', other: '↓' },
  left: { mac: '←', other: '←' },
  right: { mac: '→', other: '→' },
  tab: { mac: '⇥', other: 'Tab' },
  space: { mac: 'Space', other: 'Space' },
  backspace: { mac: '⌫', other: 'Backspace' },
};

/**
 * "mod+k" → "⌘K" (Mac) / "Ctrl K" (Windows). Tokens are joined by `+`;
 * a bare key ("F8", "N", "?") passes through. Mac joins symbols with no
 * space (⌘K); everything else joins with a thin space (Ctrl K).
 */
export function formatKeys(keys: string, platform: Platform): string {
  const parts = keys
    .split(/\+|\s+/)
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const named = NAMES[k.toLowerCase()];
      if (named) return named[platform];
      return k.length === 1 ? k.toUpperCase() : k;
    });
  // ⌘K on a Mac (modifier glyph + key, no space); everything else — Ctrl K,
  // Shift ↵, the g o chords — reads with a space between the keys.
  const glyphChord =
    platform === 'mac' && parts.length > 1 && parts.slice(0, -1).every((p) => /^[⌘⌃⌥⇧]$/.test(p));
  return parts.join(glyphChord ? '' : ' ');
}

export function Kbd({
  keys,
  className,
  children,
  ...rest
}: {
  /** Shortcut spec, e.g. "mod+k", "F8", "esc", "g o". Falls back to children. */
  keys?: string;
  className?: string;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const platform = usePlatform();
  const label = keys ? formatKeys(keys, platform) : children;
  return (
    <kbd {...rest} className={cx('kbd', className)} aria-label={rest['aria-label']}>
      {label}
    </kbd>
  );
}
