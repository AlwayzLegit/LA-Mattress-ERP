'use client';

import { useSyncExternalStore } from 'react';

/**
 * Global API reachability (redesign Phase 3, canvas 3d/3e). `api()`
 * reports every network failure and 502/503/504 here; the shell turns
 * the sidebar sync dot red and shows the error component that names the
 * draft, retries on its own with a visible countdown, and lets the user
 * jump the queue. Any successful call clears the state.
 */

export interface ApiStatus {
  down: boolean;
  /** Retry attempts since the outage began (1-based once scheduled). */
  attempt: number;
  /** Epoch ms of the next automatic retry, while down. */
  nextRetryAt: number | null;
  /** Set by the register while a draft is open: "SO-10441 (2 lines, $2,598.00)". */
  draft: string | null;
  /** The user chose "Keep writing offline" — hide the banner until the next failure. */
  dismissed: boolean;
  lastError: string | null;
}

let state: ApiStatus = {
  down: false,
  attempt: 0,
  nextRetryAt: null,
  draft: null,
  dismissed: false,
  lastError: null,
};
const listeners = new Set<() => void>();
let timer: number | null = null;
let probing = false;

function emit(next: Partial<ApiStatus>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function delayFor(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}

function schedule() {
  if (typeof window === 'undefined') return;
  if (timer) window.clearTimeout(timer);
  const attempt = state.attempt + 1;
  const delay = delayFor(attempt);
  emit({ attempt, nextRetryAt: Date.now() + delay });
  timer = window.setTimeout(() => void probe(), delay);
}

async function probe(): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    const base = process.env.NEXT_PUBLIC_API_URL ?? '';
    const res = await fetch(`${base}/ready`, { credentials: 'include', cache: 'no-store' });
    if (res.ok) noteSuccess();
    else schedule();
  } catch {
    schedule();
  } finally {
    probing = false;
  }
}

/** Called by `api()` when the server could not be reached. */
export function noteFailure(reason: string): void {
  if (state.down) {
    emit({ lastError: reason });
    if (!timer) schedule();
    return;
  }
  emit({ down: true, dismissed: false, lastError: reason, attempt: 0 });
  schedule();
}

/** Called by `api()` on any successful response. */
export function noteSuccess(): void {
  if (!state.down) return;
  if (timer) window.clearTimeout(timer);
  timer = null;
  emit({ down: false, attempt: 0, nextRetryAt: null, dismissed: false, lastError: null });
}

/** "Retry now" — jump the queue. */
export function retryNow(): void {
  if (timer) window.clearTimeout(timer);
  timer = null;
  void probe();
}

/** "Keep writing offline" — hide the banner until the next failure. */
export function dismissOutage(): void {
  emit({ dismissed: true });
}

/** The register publishes its open draft so the error can name it. */
export function setDraftSummary(draft: string | null): void {
  if (state.draft !== draft) emit({ draft });
}

/** True for the failures that mean "the server is unreachable" rather than a bad request. */
export function isOutageStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
const SERVER: ApiStatus = { ...state };

export function useApiStatus(): ApiStatus {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER,
  );
}
