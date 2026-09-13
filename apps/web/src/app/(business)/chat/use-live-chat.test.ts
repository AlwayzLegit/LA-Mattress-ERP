import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  states: [] as unknown[],
  connectionChanges: [] as unknown[],
}));
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void | (() => void)) => harness.effects.push(fn),
  useState: (initial: unknown) => {
    const index = harness.states.length;
    harness.states.push(initial);
    return [
      initial,
      (value: unknown) => {
        harness.states[index] = typeof value === 'function' ? value(harness.states[index]) : value;
        if (index === 1) harness.connectionChanges.push(value);
      },
    ];
  },
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/chat',
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({
  apiUrl: '',
  api: vi.fn(async () => []),
  ApiError: class extends Error {},
}));
import { useLiveChatEngine } from './use-live-chat';
class Stream {
  static CLOSED = 2;
  static instances: Stream[] = [];
  readyState = 1;
  onerror?: () => void;
  events = new Map<string, (event: unknown) => void>();
  constructor() {
    Stream.instances.push(this);
  }
  addEventListener(name: string, callback: (event: unknown) => void) {
    this.events.set(name, callback);
  }
  close() {
    this.readyState = Stream.CLOSED;
  }
  snapshot() {
    this.events.get('snapshot')?.({ data: JSON.stringify({ conversations: [] }) });
  }
}
let cleanups: (() => void)[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
  vi.stubEnv('NEXT_PUBLIC_LIVE_CHAT_ENABLED', 'true');
  vi.stubGlobal('EventSource', Stream);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', {
    title: 'ERP',
    hidden: false,
    hasFocus: () => true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  harness.effects = [];
  harness.states = [];
  harness.connectionChanges = [];
  Stream.instances = [];
  useLiveChatEngine(null);
  cleanups = harness.effects
    .map((fn) => fn())
    .filter((fn): fn is () => void => typeof fn === 'function');
});
afterEach(() => {
  cleanups.forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('ERP live connection lifecycle', () => {
  it('keeps Live across repeated normal 30-second connection renewals', () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const stream = Stream.instances.at(-1)!;
      for (let second = 0; second < 29; second++) {
        stream.snapshot();
        vi.advanceTimersByTime(1000);
      }
      stream.onerror?.();
      expect(harness.states[1]).toBe('live');
      vi.advanceTimersByTime(1000);
      Stream.instances.at(-1)!.snapshot();
    }
    expect(harness.connectionChanges).not.toContain('reconnecting');
    expect(Stream.instances).toHaveLength(4);
  });
  it('reports a real outage after the grace period even when the stream is closed', () => {
    Stream.instances[0]!.snapshot();
    Stream.instances[0]!.onerror?.();
    vi.advanceTimersByTime(12000);
    expect(harness.states[1]).toBe('reconnecting');
    Stream.instances.at(-1)!.snapshot();
    expect(harness.states[1]).toBe('live');
  });
  it('restarts a stalled open stream instead of leaving it stuck', () => {
    Stream.instances[0]!.snapshot();
    vi.advanceTimersByTime(12000);
    expect(Stream.instances[0]!.readyState).toBe(Stream.CLOSED);
    expect(Stream.instances).toHaveLength(2);
    Stream.instances[0]!.snapshot();
    expect(harness.states[1]).toBe('reconnecting');
    Stream.instances[1]!.snapshot();
    expect(harness.states[1]).toBe('live');
  });
  it('never reconnects after access is revoked', () => {
    Stream.instances[0]!.events.get('access-revoked')?.({});
    vi.advanceTimersByTime(60000);
    expect(harness.states[1]).toBe('denied');
    expect(Stream.instances).toHaveLength(1);
  });
});
