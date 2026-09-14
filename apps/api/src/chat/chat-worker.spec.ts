import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { AblyChatPublisher, ChatDeliveryError, ChatWorker } from './chat-worker';

const event = {
  id: 'delivery-1',
  businessId: 'business-1',
  conversationId: 'conversation-1',
  sequence: 3,
  audience: 'staff' as const,
};
afterEach(() => vi.restoreAllMocks());

describe('Ably delivery diagnostics', () => {
  it('keeps the idempotency ID across retries and sends only change metadata', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const publisher = new AblyChatPublisher('key:secret', 'production', request);
    await publisher.publish(event);
    await publisher.publish(event);
    const bodies = request.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies).toEqual(
      [0, 1].map(() => ({
        id: event.id,
        name: 'conversation.changed',
        data: { conversationId: event.conversationId, sequence: event.sequence },
      })),
    );
  });

  it('retains authorization status and code without exposing the response body', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 40160, message: 'PRIVATE key:secret Unauthorized to publish' },
        }),
        { status: 401 },
      ),
    );
    const publisher = new AblyChatPublisher('key:secret', 'production', request);
    const error = await publisher.publish(event).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 401, code: 40160 });
    expect(String(error)).not.toMatch(/PRIVATE|secret/);
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|secret/);
  });

  it('handles non-JSON upstream failures without losing the status', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response('upstream unavailable', { status: 502 }));
    await expect(
      new AblyChatPublisher('key:secret', 'production', request).publish(event),
    ).rejects.toMatchObject({ status: 502, code: undefined });
  });

  it.each([1, 8])(
    'records attempt %i and preserves failed-delivery settlement',
    async (attempts) => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const worker = new ChatWorker(
        {} as PostgresJsDatabase,
        {
          publish: vi.fn().mockRejectedValue(new ChatDeliveryError(401, 40160)),
        },
        'production',
      );
      const claimed = { ...event, attempts } as Awaited<ReturnType<ChatWorker['claim']>>;
      vi.spyOn(worker, 'claim').mockResolvedValue(claimed);
      const settle = vi.spyOn(worker, 'settle').mockResolvedValue(true);
      expect(await worker.runOnce(event.businessId)).toBe(true);
      expect(settle).toHaveBeenCalledWith(claimed, false);
      expect(attempts === 8 ? error : warn).toHaveBeenCalledWith({
        event: 'chat_delivery_failed',
        eventId: event.id,
        attempts,
        exhausted: attempts === 8,
        providerStatus: 401,
        providerCode: 40160,
      });
    },
  );

  it('never logs raw network errors', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const worker = new ChatWorker(
      {} as PostgresJsDatabase,
      {
        publish: vi.fn().mockRejectedValue(new Error('PRIVATE key:secret')),
      },
      'production',
    );
    vi.spyOn(worker, 'claim').mockResolvedValue({ ...event, attempts: 1 } as Awaited<
      ReturnType<ChatWorker['claim']>
    >);
    vi.spyOn(worker, 'settle').mockResolvedValue(true);
    await worker.runOnce(event.businessId);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE|secret/);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'network_or_provider_failure' }),
    );
  });
});
