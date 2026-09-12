'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Shared dialog / slide-over semantics: on open, remember the opener and
 * move focus inside (to `initialFocus`, else the first control, else the
 * panel); Tab and Shift+Tab cycle inside; Escape calls `onClose`; on close,
 * focus returns to the opener. Nothing outside the panel is reachable by
 * keyboard while it is open.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  {
    active = true,
    onClose,
    initialFocus,
  }: {
    active?: boolean;
    onClose?: () => void;
    /** Element to focus first (a safe default button, the search input). */
    initialFocus?: RefObject<HTMLElement | null>;
  },
) {
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    openerRef.current = document.activeElement as HTMLElement | null;

    const target = initialFocus?.current ?? focusables(root)[0] ?? root;
    if (target === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    // Let the panel mount (and any autoFocus) before we move focus.
    const raf = requestAnimationFrame(() => target.focus({ preventScroll: true }));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onCloseRef.current) {
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables(root);
      if (list.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (current === first || !root.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last || !root.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    };
    // If focus escapes (a click on the backdrop), pull it back.
    const onFocusIn = (e: FocusEvent) => {
      if (!root.contains(e.target as Node)) {
        (focusables(root)[0] ?? root).focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      const opener = openerRef.current;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
    // initialFocus is a ref; reading .current inside the effect is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}
