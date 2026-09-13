import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatBackground, createChatBackground } from './chat-background';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ChatService } from './chat.service';

afterEach(() => vi.useRealTimers());

describe('embedded chat lifecycle', () => {
  it('recovers after failure without stopping other jobs and stops timers on shutdown', async () => {
    vi.useFakeTimers();
    const delivery = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(true);
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const runner = new ChatBackground([
      { name: 'delivery', interval: 100, run: delivery },
      { name: 'maintenance', interval: 1000, run: maintenance },
    ]);
    runner.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5000);
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(maintenance.mock.calls.length).toBeGreaterThan(1);
    await runner.onModuleDestroy();
    const count = delivery.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(delivery).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an active job and never overlaps it', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const runner = new ChatBackground([{ name: 'delivery', interval: 100, run }]);
    runner.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    let closed = false;
    const stopping = runner.onModuleDestroy().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await stopping;
    expect(closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is disabled by default and fails startup for incomplete enabled configuration', async () => {
    const db = {} as PostgresJsDatabase;
    const chat = {} as ChatService;
    const runner = createChatBackground(db, chat, {});
    runner.onApplicationBootstrap();
    await runner.onModuleDestroy();
    expect(() => createChatBackground(db, chat, { CHAT_EMBEDDED_WORKERS: 'true' })).toThrow();
  });
});
