import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { ChatHttpGuard } from './chat-http.guard';

const origin = 'https://erp.test';
function fixture() {
  const counts = new Map<string, number>();
  const evalRedis = vi.fn(async (_script: string, _numKeys: number, key: string) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count;
  });
  const guard = new ChatHttpGuard(
    new ConfigService({
      CHAT_ENABLED: 'true',
      CHAT_ENVIRONMENT: 'production',
      CHAT_STAFF_ORIGINS: origin,
    }),
    { eval: evalRedis } as unknown as Redis,
  );
  const call = (
    path: string,
    method = 'GET',
    options: {
      user?: string;
      peer?: string;
      headers?: Record<string, string>;
      authenticated?: boolean;
    } = {},
  ) =>
    guard.canActivate({
      switchToHttp: () => ({
        getRequest: () => ({
          path,
          method,
          body: {},
          is: () => true,
          socket: { remoteAddress: options.peer ?? 'render-proxy' },
          headers: { origin, 'x-chat-request': '1', cookie: 'session=same', ...options.headers },
          tenant:
            options.authenticated === false
              ? undefined
              : {
                  businessId: 'business-1',
                  userId: options.user ?? 'staff-1',
                  apiKeyId: null,
                },
        }),
      }),
    } as unknown as ExecutionContext);
  return { call, evalRedis };
}
const staff = '/v1/chat/conversations';
const visitor = '/v1/chat/visitor';

describe('chat HTTP traffic budgets', () => {
  it('keeps acceptance, transfer and replies working after multi-tab polling hits its cap', async () => {
    const { call } = fixture();
    for (let n = 0; n < 600; n++) await call(`${staff}/help-inbox`);
    await expect(call(`${staff}/live`)).rejects.toMatchObject({ status: 429 });
    for (const endpoint of ['accept', 'transfer', 'messages'])
      await expect(call(`${staff}/chat-1/${endpoint}`, 'POST')).resolves.toBe(true);
  });

  it('isolates heartbeat and typing traffic from staff actions and reads', async () => {
    const { call } = fixture();
    for (let n = 0; n < 240; n++)
      await call(n % 2 ? `${staff}/availability` : `${staff}/chat-1/activity`, 'POST');
    await expect(call(`${staff}/team/rooms/room-1/activity/`, 'POST')).rejects.toMatchObject({
      status: 429,
    });
    await expect(call(`${staff}/chat-1/accept`, 'POST')).resolves.toBe(true);
    await expect(call(`${staff}/chat-1/history`)).resolves.toBe(true);
  });

  it('keeps the shared peer read cap separate from actions too', async () => {
    const { call } = fixture();
    for (let n = 0; n < 6000; n++)
      await call(`${staff}/help-inbox`, 'GET', { user: `staff-${n % 10}` });
    await expect(call(`${staff}/live`, 'GET', { user: 'staff-new' })).rejects.toMatchObject({
      status: 429,
    });
    await expect(call(`${staff}/chat-1/accept`, 'POST', { user: 'staff-new' })).resolves.toBe(true);
  });

  it('still limits staff writes and cannot be bypassed by changing cookies or visitor headers', async () => {
    const { call } = fixture();
    for (let n = 0; n < 120; n++) await call(`${staff}/chat-1/messages`, 'POST');
    await expect(
      call(`${staff}/chat-1/accept`, 'POST', {
        headers: {
          cookie: 'session=changed',
          'x-chat-session': 'spoofed',
          'x-chat-integration-id': 'spoofed',
        },
      }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(call(`${staff}/chat-1/accept`, 'POST', { user: 'staff-2' })).resolves.toBe(true);
  });

  it('isolates visitor activity, messages, and session creation without removing their caps', async () => {
    const { call } = fixture();
    for (let n = 0; n < 120; n++) await call(`${visitor}/conversations/chat-1/activity`, 'POST');
    await expect(call(`${visitor}/conversations/chat-1/activity`, 'POST')).rejects.toMatchObject({
      status: 429,
    });
    await expect(call(`${visitor}/conversations/chat-1/messages`, 'POST')).resolves.toBe(true);
    for (let n = 0; n < 20; n++) await call(`${visitor}/session`, 'POST');
    await expect(call(`${visitor}/session/`, 'POST')).rejects.toMatchObject({ status: 429 });
    await expect(call(`${visitor}/conversations/chat-1/messages`, 'POST')).resolves.toBe(true);
  });

  it('keeps visitor traffic from consuming the staff peer allowance', async () => {
    const { call } = fixture();
    for (let n = 0; n < 600; n++)
      await call(`${visitor}/conversations/chat-1/messages`, 'POST', {
        headers: { 'x-chat-session': `visitor-${n}` },
      });
    await expect(
      call(`${visitor}/conversations/chat-1/messages`, 'POST', {
        headers: { 'x-chat-session': 'another', 'x-forwarded-for': 'new-address' },
      }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(call(`${staff}/chat-1/accept`, 'POST')).resolves.toBe(true);
  });

  it('rejects missing verified staff identity and invalid origins', async () => {
    const { call } = fixture();
    await expect(call(`${staff}/live`, 'GET', { authenticated: false })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      call(`${staff}/chat-1/accept`, 'POST', { headers: { origin: 'https://foreign.test' } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed when Redis is unavailable or returns an invalid counter', async () => {
    const { call, evalRedis } = fixture();
    evalRedis.mockRejectedValueOnce(new Error('offline'));
    await expect(call(`${staff}/live`)).rejects.toMatchObject({ status: 503 });
    evalRedis.mockResolvedValueOnce(NaN);
    await expect(call(`${staff}/live`)).rejects.toMatchObject({ status: 503 });
  });
});
