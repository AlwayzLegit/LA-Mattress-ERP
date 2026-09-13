import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';

function worker(hostname = 'erp.test') {
  const handlers: Record<string, (event: any) => void> = {};
  const shown: unknown[] = [];
  const opened: string[] = [];
  let focused = false;
  runInNewContext(readFileSync(new URL('../../../../public/sw.js', import.meta.url), 'utf8'), {
    URL,
    self: {
      addEventListener: (name: string, fn: (event: any) => void) => {
        handlers[name] = fn;
      },
      location: { origin: 'https://erp.test', hostname },
      registration: {
        showNotification: async (...args: unknown[]) => {
          shown.push(args);
        },
      },
      clients: {
        matchAll: async () => [
          {
            url: 'https://erp.test/chat',
            focus: async () => {
              focused = true;
            },
          },
        ],
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
    },
  });
  return { handlers, shown, opened, focused: () => focused };
}
describe('chat service worker notifications', () => {
  it('uses generic content and a fixed inbox destination, ignoring hostile payload text and URLs', async () => {
    const w = worker();
    let promise: Promise<unknown> | undefined;
    w.handlers.push!({
      data: {
        json: () => ({ type: 'chat', title: 'PRIVATE', body: 'SECRET', url: 'https://bad.test' }),
      },
      waitUntil: (p: Promise<unknown>) => {
        promise = p;
      },
    });
    await promise;
    expect(JSON.stringify(w.shown)).not.toContain('PRIVATE');
    expect(JSON.stringify(w.shown)).not.toContain('SECRET');
    expect(JSON.stringify(w.shown)).not.toContain('bad.test');
    expect(JSON.stringify(w.shown)).toContain('/chat');
    w.handlers.notificationclick!({
      notification: { data: { url: '/chat' }, close() {} },
      waitUntil: (p: Promise<unknown>) => {
        promise = p;
      },
    });
    await promise;
    expect(w.focused()).toBe(true);
    expect(w.opened).toEqual([]);
  });
  it('ignores malformed push data and never caches chat API responses', () => {
    const w = worker();
    w.handlers.push!({
      data: {
        json: () => {
          throw Error('invalid');
        },
      },
    });
    w.handlers.fetch!({
      request: { method: 'GET', url: 'https://erp.test/v1/chat/conversations' },
      respondWith: () => {
        throw Error('Chat responses must not be cached');
      },
    });
    expect(w.shown).toEqual([]);
  });
});

it('does not cache development chunks with stable filenames on localhost', () => {
  const w = worker('localhost');
  w.handlers.fetch!({
    request: { method: 'GET', url: 'https://erp.test/_next/static/chunks/app/page.js' },
    respondWith: () => {
      throw Error('Development chunks must use the network');
    },
  });
});

it.each(['team-chat', 'chat-help'])('renders safe generic %s notifications', async (type) => {
  const w = worker();
  let promise: Promise<unknown> | undefined;
  w.handlers.push!({
    data: { json: () => ({ type, title: 'SECRET', body: 'PRIVATE', url: 'https://bad.test' }) },
    waitUntil: (p: Promise<unknown>) => {
      promise = p;
    },
  });
  await promise;
  expect(w.shown).toHaveLength(1);
  expect(JSON.stringify(w.shown)).not.toMatch(/SECRET|PRIVATE|bad.test/);
  expect(JSON.stringify(w.shown)).toContain('/chat');
});
it.each(['constructor', '__proto__', 'unknown'])('ignores unknown push type %s', (type) => {
  const w = worker();
  w.handlers.push!({ data: { json: () => ({ type }) } });
  expect(w.shown).toEqual([]);
});
