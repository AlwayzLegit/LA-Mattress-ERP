import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorePeriod, StoresResponse } from './types';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effect: null as null | (() => void | (() => void)),
}));
vi.mock('react', () => ({
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => (hooks.slots[index] = value)];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void | (() => void)) => (hooks.effect = effect),
}));
vi.mock('@/lib/api', () => ({ api: vi.fn() }));
import { api } from '@/lib/api';
import { useStores } from './use-stores';

type Pending = {
  signal: AbortSignal;
  resolve: (data: StoresResponse) => void;
  reject: (error: Error) => void;
};
let pending: Pending[];
let cleanup: void | (() => void);

function RenderStores(period: StorePeriod, scope = '') {
  hooks.cursor = 0;
  return useStores(period, scope);
}
function runEffect() {
  cleanup?.();
  cleanup = hooks.effect!();
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function response(period: StorePeriod, cents: number): StoresResponse {
  return {
    period,
    date: '2026-09-14',
    range: { start: period === 'today' ? '2026-09-14' : '2026-09-01', end: '2026-09-14' },
    viewer: { membershipId: null, canConfirmCashPickup: false },
    stores: [],
    totals: {
      storeCount: 1,
      writtenCents: cents,
      writtenCount: 1,
      deliveredCents: 0,
      deliveredCount: 0,
      receivedCents: 0,
      receivedCount: 0,
      cashPendingCents: 0,
    },
  };
}

beforeEach(() => {
  cleanup?.();
  cleanup = undefined;
  hooks.slots = [];
  pending = [];
  vi.mocked(api).mockReset();
  // Deliberately allow an aborted request to settle: the response guard must
  // still protect against already-queued resolutions and transport adapters.
  vi.mocked(api).mockImplementation(
    (_path, init) =>
      new Promise((resolve, reject) => {
        pending.push({ signal: init!.signal as AbortSignal, resolve, reject });
      }),
  );
});

describe('store period and scope requests', () => {
  it('keeps saved Today figures when the initial MTD request finishes last', async () => {
    RenderStores('mtd');
    runEffect();
    RenderStores('today');
    runEffect();
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[1]!.resolve(response('today', 142588));
    await settle();
    pending[0]!.resolve(response('mtd', 1174100));
    await settle();
    const current = RenderStores('today');
    expect(current.data?.range.start).toBe('2026-09-14');
    expect(current.data?.totals.writtenCents).toBe(142588);
    expect(current.loading).toBe(false);
    expect(current.error).toBe(false);
  });

  it('hides old rows immediately when period or store scope changes', async () => {
    RenderStores('mtd', 'store-a');
    runEffect();
    pending[0]!.resolve(response('mtd', 1174100));
    await settle();
    expect(RenderStores('mtd', 'store-a').data).not.toBeNull();
    expect(RenderStores('today', 'store-a').data).toBeNull();
    expect(RenderStores('mtd', 'store-b').data).toBeNull();
    runEffect();
    expect(vi.mocked(api).mock.calls[1]![0]).toContain('locationIds=store-b');
    pending[1]!.resolve(response('mtd', 20000));
    await settle();
    expect(RenderStores('mtd', 'store-b').data?.totals.writtenCents).toBe(20000);
  });

  it('ignores a superseded error and ignores responses after unmount', async () => {
    RenderStores('mtd');
    runEffect();
    RenderStores('today');
    runEffect();
    pending[0]!.reject(new Error('late network failure'));
    await settle();
    expect(RenderStores('today').error).toBe(false);
    expect(RenderStores('today').loading).toBe(true);
    cleanup?.();
    expect(pending[1]!.signal.aborted).toBe(true);
    pending[1]!.resolve(response('today', 10000));
    await settle();
    expect(RenderStores('today').data).toBeNull();
  });
});
