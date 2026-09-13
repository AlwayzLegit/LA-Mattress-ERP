import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { withinChatHours } from '../src/chat/chat-policy';
import { chatSettingsSchema } from '@jetnine/shared';
import { ChatPushWorker } from '../src/chat/chat-push-worker';
import { ChatWorker, AblyChatPublisher } from '../src/chat/chat-worker';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { hashPassword } from 'better-auth/crypto';
import { AppModule } from '../src/app.module';
import { REDIS } from '../src/redis/redis.module';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withDrizzleTenantContext } from '@jetnine/db';
import type { RequestTenantContext } from '../src/tenancy/request-context';
import { ChatService, hashChatCredential, type ChatVisitorAuth } from '../src/chat/chat.service';

const url =
  process.env.CHAT_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/jetnine_chat';
const parsedUrl = new URL(url);
if (
  !['localhost', '127.0.0.1'].includes(parsedUrl.hostname) ||
  parsedUrl.pathname !== '/jetnine_chat'
)
  throw new Error('Chat tests require a local disposable jetnine_chat database');
const connection = postgres(url, { max: 8, prepare: false });
const db = drizzle(connection);
const service = new ChatService(db, 'staging');
const dbRoot = join(__dirname, '../../../packages/db');
const secret = () => randomBytes(32).toString('base64url');
const input = (body = 'Which mattress would you suggest?') => ({
  clientMessageId: randomUUID(),
  body,
});
let businessId: string,
  otherBusinessId: string,
  auth: ChatVisitorAuth,
  otherVisitor: ChatVisitorAuth,
  staff: RequestTenantContext;

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [join(dbRoot, 'node_modules/tsx/dist/cli.mjs'), 'src/migrate.ts'],
    {
      cwd: dbRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    },
  );
  const [business] = await db
    .insert(schema.businesses)
    .values({ name: 'Chat tests', status: 'active', slug: `chat-${randomUUID()}` })
    .returning();
  const [other] = await db
    .insert(schema.businesses)
    .values({ name: 'Other chat tests', status: 'active', slug: `chat-${randomUUID()}` })
    .returning();
  businessId = business!.id;
  otherBusinessId = other!.id;
  const credential = secret();
  const [integration] = await db
    .insert(schema.chatIntegrations)
    .values({
      businessId,
      credentialHash: hashChatCredential(credential),
      allowedOrigin: 'https://chat.test',
      enabled: true,
    })
    .returning();
  const integrationAuth = { integrationId: integration!.id, credential };
  auth = {
    ...integrationAuth,
    sessionCredential: (await service.createSession(integrationAuth)).credential,
  };
  otherVisitor = {
    ...integrationAuth,
    sessionCredential: (await service.createSession(integrationAuth)).credential,
  };
  const [user] = await db
    .insert(schema.users)
    .values({ email: `chat-${randomUUID()}@example.test` })
    .returning();
  const [role] = await db
    .insert(schema.roles)
    .values({ businessId, name: 'Chat test agent' })
    .returning();
  await db
    .insert(schema.rolePermissions)
    .values(
      ['chat.view_team', 'chat.reply'].map((permission) => ({ roleId: role!.id, permission })),
    );
  const [member] = await db
    .insert(schema.memberships)
    .values({ businessId, userId: user!.id, roleId: role!.id, status: 'active' })
    .returning();
  staff = {
    businessId,
    userId: user!.id,
    membershipId: member!.id,
    roleId: role!.id,
    roleName: role!.name,
    permissions: new Set(['chat.view_team', 'chat.reply']),
    dataScope: 'all',
    sellingScope: 'all',
    scopeLocationIds: null,
    isSuperAdmin: false,
    ip: null,
    userAgent: null,
    impersonatorUserId: null,
    apiKeyId: null,
    auditLogged: false,
  };
});
afterAll(async () => {
  if (businessId) await db.delete(schema.businesses).where(eq(schema.businesses.id, businessId));
  if (otherBusinessId)
    await db.delete(schema.businesses).where(eq(schema.businesses.id, otherBusinessId));
  if (staff?.userId) await db.delete(schema.users).where(eq(schema.users.id, staff.userId));
  await connection.end({ timeout: 5 });
});

describe('chat persistence foundation on Postgres', () => {
  it('reclaims abandoned leases and rejects completion from stale workers', async () => {
    await db
      .update(schema.chatOutbox)
      .set({ completedAt: new Date() })
      .where(eq(schema.chatOutbox.businessId, businessId));
    await service.startConversation(auth, randomUUID(), input());
    let now = new Date(Date.now() + 1000);
    const worker = new ChatWorker(db, { publish: async () => {} }, 'staging', () => now);
    const a = await worker.claim(businessId);
    const b = await worker.claim(businessId);
    expect(a!.id).not.toBe(b!.id);
    expect(await worker.claim(businessId)).toBeNull();
    now = new Date(now.getTime() + 31000);
    const recovered = await worker.claim(businessId);
    expect([a!.id, b!.id]).toContain(recovered!.id);
    expect(recovered!.attempts).toBe(2);
    expect(await worker.settle(recovered!.id === a!.id ? a! : b!, true)).toBe(false);
    expect(await worker.settle(recovered!, true)).toBe(true);
  });

  it('retries provider failures with backoff and preserves failed work for inspection', async () => {
    await db
      .update(schema.chatOutbox)
      .set({ completedAt: new Date() })
      .where(eq(schema.chatOutbox.businessId, businessId));
    await service.startConversation(auth, randomUUID(), input());
    let now = new Date(Date.now() + 1000);
    const worker = new ChatWorker(
      db,
      {
        publish: async () => {
          throw new Error('Do not store provider credentials');
        },
      },
      'staging',
      () => now,
    );
    for (let attempt = 0; attempt < 8; attempt++) {
      await worker.runOnce(businessId);
      await worker.runOnce(businessId);
      expect(await worker.runOnce(businessId)).toBe(false);
      now = new Date(now.getTime() + 61000);
    }
    const rows = await db
      .select()
      .from(schema.chatOutbox)
      .where(eq(schema.chatOutbox.businessId, businessId));
    const failed = rows.filter((row) => row.failedAt);
    expect(failed).toHaveLength(2);
    expect(failed.every((row) => row.attempts === 8)).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('credentials');
  });

  it('publishes only change metadata to environment-specific private channels with stable IDs', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const publisher = new AblyChatPublisher(
      'test.key:test-secret',
      'staging',
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('', { status: 201 });
      },
    );
    const event = {
      id: randomUUID(),
      businessId,
      conversationId: randomUUID(),
      sequence: 3,
      audience: 'staff' as const,
    };
    await publisher.publish(event);
    await publisher.publish(event);
    expect(decodeURIComponent(calls[0]!.url)).toContain(
      `chat:staging:${businessId}:${event.conversationId}:staff`,
    );
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      id: event.id,
      name: 'conversation.changed',
      data: { conversationId: event.conversationId, sequence: 3 },
    });
    expect(calls[0]!.init!.body).toBe(calls[1]!.init!.body);
    const wrongEnvironment = new ChatWorker(db, publisher, 'production');
    expect(await wrongEnvironment.claim(businessId)).toBeNull();
  });

  it('serves authenticated visitor/staff HTTP flows and enforces origin, kill switch and limiter failures', async () => {
    const previousEnv = { ...process.env };
    Object.assign(process.env, {
      DATABASE_URL: url,
      BETTER_AUTH_URL: 'http://localhost',
      BETTER_AUTH_SECRET: 'chat-test-secret-only-2026-123456',
      AUTH_TRUSTED_ORIGINS: 'http://localhost',
      AUTH_RATE_LIMIT_DISABLED: '1',
      NODE_ENV: 'test',
      CHAT_ENABLED: 'true',
      CHAT_ENVIRONMENT: 'staging',
      CHAT_STAFF_ORIGINS: 'http://localhost',
    });
    const password = 'LocalChatTest!2026';
    await db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, staff.userId!));
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, staff.userId!));
    await db.insert(schema.accounts).values({
      accountId: staff.userId!,
      providerId: 'credential',
      userId: staff.userId!,
      password: await hashPassword(password),
    });
    let limitMode = 'ok';
    const redis = {
      eval: async () => {
        if (limitMode === 'down') throw new Error('Unavailable');
        return limitMode === 'limited' ? 1000 : 1;
      },
      get: async () => null,
      set: async () => 'OK',
      del: async () => 1,
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS)
      .useValue(redis)
      .compile();
    const app = module.createNestApplication({ bufferLogs: true });
    try {
      await app.init();
      const contract = await request(app.getHttpServer()).get('/v1/chat/openapi.json').expect(200);
      expect(contract.body.info.version).toBe('1.0.0');
      expect(contract.body.paths['/v1/chat/visitor/conversations']).toBeDefined();
      const login = await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .send({ email: user!.email, password })
        .expect(200);
      const cookie = (login.get('Set-Cookie') ?? [])
        .map((c: string) => c.split(';')[0]!)
        .find((c: string) => c.startsWith('jetnine.session_token='))!;
      const visitorHeaders = {
        authorization: `Bearer ${auth.credential}`,
        'x-chat-integration-id': auth.integrationId,
        'x-chat-session': auth.sessionCredential,
      };
      const staffHeaders = {
        Cookie: cookie,
        'x-business-id': businessId,
        Origin: 'http://localhost',
        'x-chat-request': '1',
      };
      await request(app.getHttpServer()).get('/v1/chat/conversations').expect(401);
      await request(app.getHttpServer()).post('/v1/chat/visitor/session').send({}).expect(401);
      const start = await request(app.getHttpServer())
        .post('/v1/chat/visitor/conversations')
        .set(visitorHeaders)
        .send({ clientConversationId: randomUUID(), ...input('HTTP question') })
        .expect(201);
      expect(start.get('Cache-Control')).toBe('no-store');
      const id = start.body.conversationId as string;
      await app.listen(0, '127.0.0.1');
      const streamAbort = new AbortController();
      const streamTimeout = setTimeout(() => streamAbort.abort(), 8000);
      try {
        const stream = await fetch(`${await app.getUrl()}/v1/chat/conversations/live`, {
          headers: staffHeaders,
          signal: streamAbort.signal,
        });
        expect(stream.status).toBe(200);
        expect(stream.headers.get('content-type')).toContain('text/event-stream');
        const reader = stream.body!.getReader();
        let received = '';
        while (!received.includes(id))
          received += new TextDecoder().decode((await reader.read()).value);
        expect(received).toContain('event: snapshot');
        expect(received).toContain('HTTP question');
        await service.sendVisitorMessage(auth, id, input('Streaming follow-up'));
        received = '';
        while (!received.includes('"visitorSequence":2'))
          received += new TextDecoder().decode((await reader.read()).value);
        expect(received).toContain(id);
        process.env.CHAT_ENABLED = 'false';
        received = '';
        while (!received.includes('event: unavailable')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += new TextDecoder().decode(chunk.value);
        }
        expect(received).toContain('event: unavailable');
        process.env.CHAT_ENABLED = 'true';
      } finally {
        clearTimeout(streamTimeout);
        streamAbort.abort();
      }

      await request(app.getHttpServer())
        .post(`/v1/chat/conversations/${id}/messages`)
        .set(staffHeaders)
        .send(input('HTTP reply'))
        .expect(201);
      await request(app.getHttpServer())
        .post(`/v1/chat/conversations/${id}/notes`)
        .set(staffHeaders)
        .send(input('Private HTTP note'))
        .expect(201);
      const history = await request(app.getHttpServer())
        .get(`/v1/chat/visitor/conversations/${id}/history`)
        .set(visitorHeaders)
        .expect(200);
      expect(history.body.data.map((row: { body: string }) => row.body)).toEqual([
        'HTTP question',
        'Streaming follow-up',
        'HTTP reply',
      ]);
      const staffHistory = await request(app.getHttpServer())
        .get(`/v1/chat/conversations/${id}/history`)
        .set(staffHeaders)
        .expect(200);
      expect(staffHistory.body.data).toHaveLength(4);
      const visitorAbort = new AbortController();
      const visitorTimeout = setTimeout(() => visitorAbort.abort(), 8000);
      try {
        const stream = await fetch(
          `${await app.getUrl()}/v1/chat/visitor/conversations/${id}/live?afterSequence=0&limit=100`,
          { headers: visitorHeaders, signal: visitorAbort.signal },
        );
        expect(stream.status).toBe(200);
        const reader = stream.body!.getReader();
        let received = '';
        while (!received.includes('HTTP reply'))
          received += new TextDecoder().decode((await reader.read()).value);
        expect(received).toContain('event: messages');
        expect(received).not.toContain('Private HTTP note');
        await service.sendStaffMessage(staff, id, input('Realtime staff answer'));
        received = '';
        while (!received.includes('Realtime staff answer'))
          received += new TextDecoder().decode((await reader.read()).value);
        expect(received).not.toContain('Private HTTP note');
        process.env.CHAT_ENABLED = 'false';
        received = '';
        while (!received.includes('event: unavailable')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += new TextDecoder().decode(chunk.value);
        }
        expect(received).toContain('event: unavailable');
        process.env.CHAT_ENABLED = 'true';
      } finally {
        visitorAbort.abort();
        clearTimeout(visitorTimeout);
      }

      await request(app.getHttpServer())
        .post(`/v1/chat/conversations/${id}/messages`)
        .set({ ...staffHeaders, Origin: 'https://untrusted.test' })
        .send(input())
        .expect(403);
      await request(app.getHttpServer())
        .get(`/v1/chat/visitor/conversations/${id}/history`)
        .set({ ...visitorHeaders, 'x-chat-session': otherVisitor.sessionCredential })
        .expect(404);
      limitMode = 'down';
      await request(app.getHttpServer())
        .get(`/v1/chat/visitor/conversations/${id}/history`)
        .set(visitorHeaders)
        .expect(503);
      limitMode = 'limited';
      await request(app.getHttpServer())
        .get(`/v1/chat/visitor/conversations/${id}/history`)
        .set(visitorHeaders)
        .expect(429);
      limitMode = 'ok';
      process.env.CHAT_ENABLED = 'false';
      await request(app.getHttpServer())
        .get(`/v1/chat/visitor/conversations/${id}/history`)
        .set(visitorHeaders)
        .expect(503);
    } finally {
      await app.close();
      for (const key of Object.keys(process.env))
        if (!(key in previousEnv)) delete process.env[key];
      Object.assign(process.env, previousEnv);
    }
  });
  it('stores only credential hashes and validates integration environment and credential', async () => {
    const [session] = await db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.credentialHash, hashChatCredential(auth.sessionCredential)));
    expect(session).toBeDefined();
    expect(JSON.stringify(session)).not.toContain(auth.sessionCredential);
    await expect(service.createSession({ ...auth, credential: secret() })).rejects.toThrow(
      'Invalid chat integration',
    );
    await expect(new ChatService(db, 'production').createSession(auth)).rejects.toThrow(
      'Invalid chat integration',
    );
  });

  it('persists a visitor question and staff reply with stable history; private notes never reach visitors', async () => {
    const start = await service.startConversation(auth, randomUUID(), input());
    await service.sendStaffMessage(
      staff,
      start.conversationId,
      input('Private stock discussion'),
      'note',
    );
    await service.sendStaffMessage(staff, start.conversationId, input('Happy to help!'));
    const history = await service.visitorHistory(auth, start.conversationId);
    expect(history.data.map((row) => row.sequence)).toEqual([1, 3]);
    expect(history.data.map((row) => row.sender)).toEqual(['visitor', 'staff']);
    expect(JSON.stringify(history)).not.toContain('Private stock discussion');
    expect(history.data.every((row) => row.persisted)).toBe(true);
    const events = await db
      .select()
      .from(schema.chatOutbox)
      .where(eq(schema.chatOutbox.conversationId, start.conversationId));
    expect(events.filter((row) => row.sequence === 2).map((row) => row.audience)).toEqual([
      'staff',
    ]);
    expect(events).toHaveLength(5);
    expect(JSON.stringify(events)).not.toContain('Happy to help');
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.targetId, start.conversationId));
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain('Private stock discussion');
    expect(history.data[0]).not.toHaveProperty('senderId');
  });

  it('deduplicates concurrent creation and rejects changed create payloads', async () => {
    const clientId = randomUUID(),
      message = input();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => service.startConversation(auth, clientId, message)),
    );
    expect(new Set(results.map((row) => row.conversationId)).size).toBe(1);
    expect(new Set(results.map((row) => row.message.id)).size).toBe(1);
    await expect(
      service.startConversation(auth, clientId, input('Changed question')),
    ).rejects.toThrow('Conversation creation key already used');
  });

  it('deduplicates lost acknowledgements and detects conflicting reuse', async () => {
    const start = await service.startConversation(auth, randomUUID(), input());
    const message = input('Retry this exact message');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.sendVisitorMessage(auth, start.conversationId, message),
      ),
    );
    expect(new Set(responses.map((row) => row.id)).size).toBe(1);
    await expect(
      service.sendVisitorMessage(auth, start.conversationId, {
        ...message,
        body: 'Different text',
      }),
    ).rejects.toThrow('Message ID already used');
    const rows = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.conversationId, start.conversationId));
    expect(rows).toHaveLength(2);
    const events = await db
      .select()
      .from(schema.chatOutbox)
      .where(eq(schema.chatOutbox.conversationId, start.conversationId));
    expect(events).toHaveLength(4);
  });

  it('allocates unique increasing sequences when staff and visitor send concurrently', async () => {
    const start = await service.startConversation(auth, randomUUID(), input());
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2
          ? service.sendVisitorMessage(auth, start.conversationId, input(`Visitor ${i}`))
          : service.sendStaffMessage(staff, start.conversationId, input(`Staff ${i}`)),
      ),
    );
    const history = await service.visitorHistory(auth, start.conversationId);
    expect(history.data.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const page = await service.visitorHistory(auth, start.conversationId, { limit: 2 });
    expect(page.hasMore).toBe(true);
    const next = await service.visitorHistory(auth, start.conversationId, {
      afterSequence: page.nextSequence,
      limit: 2,
    });
    expect(next.data.map((row) => row.sequence)).toEqual([3, 4]);
  });

  it('denies another visitor in the same business both reads and writes', async () => {
    const start = await service.startConversation(auth, randomUUID(), input());
    await expect(service.visitorHistory(otherVisitor, start.conversationId)).rejects.toThrow(
      'Conversation not found',
    );
    await expect(
      service.sendVisitorMessage(otherVisitor, start.conversationId, input()),
    ).rejects.toThrow('Conversation not found');
  });

  it('denies expired and revoked sessions and disabled integrations', async () => {
    const localAuth = {
      ...auth,
      sessionCredential: (await service.createSession(auth)).credential,
    };
    const start = await service.startConversation(localAuth, randomUUID(), input());
    await db
      .update(schema.chatSessions)
      .set({ expiresAt: new Date(0) })
      .where(
        eq(schema.chatSessions.credentialHash, hashChatCredential(localAuth.sessionCredential)),
      );
    await expect(service.visitorHistory(localAuth, start.conversationId)).rejects.toThrow(
      'Chat session expired',
    );
    await db
      .update(schema.chatSessions)
      .set({ expiresAt: new Date(Date.now() + 100000), revokedAt: new Date() })
      .where(
        eq(schema.chatSessions.credentialHash, hashChatCredential(localAuth.sessionCredential)),
      );
    await expect(
      service.sendVisitorMessage(localAuth, start.conversationId, input()),
    ).rejects.toThrow('Chat session expired');
    await db
      .update(schema.chatIntegrations)
      .set({ enabled: false })
      .where(eq(schema.chatIntegrations.id, auth.integrationId));
    try {
      await expect(service.visitorHistory(auth, start.conversationId)).rejects.toThrow(
        'Invalid chat integration',
      );
    } finally {
      await db
        .update(schema.chatIntegrations)
        .set({ enabled: true })
        .where(eq(schema.chatIntegrations.id, auth.integrationId));
    }
  });

  it('fails closed for missing staff permissions, store scope, revoked rights and inactive memberships', async () => {
    const start = await service.startConversation(auth, randomUUID(), input());
    await expect(
      service.sendStaffMessage({ ...staff, permissions: new Set() }, start.conversationId, input()),
    ).rejects.toThrow('permission required');
    await expect(
      service.sendStaffMessage({ ...staff, dataScope: 'store' }, start.conversationId, input()),
    ).rejects.toThrow('permission required');
    await db.insert(schema.membershipPermissionOverrides).values({
      businessId,
      membershipId: staff.membershipId!,
      permission: 'chat.reply',
      allowed: false,
    });
    try {
      await expect(service.sendStaffMessage(staff, start.conversationId, input())).rejects.toThrow(
        'permission required',
      );
    } finally {
      await db
        .delete(schema.membershipPermissionOverrides)
        .where(eq(schema.membershipPermissionOverrides.membershipId, staff.membershipId!));
    }
    await db
      .update(schema.memberships)
      .set({ status: 'disabled' })
      .where(eq(schema.memberships.id, staff.membershipId!));
    try {
      await expect(service.sendStaffMessage(staff, start.conversationId, input())).rejects.toThrow(
        'Active chat membership required',
      );
    } finally {
      await db
        .update(schema.memberships)
        .set({ status: 'active' })
        .where(eq(schema.memberships.id, staff.membershipId!));
    }
  });

  it('enforces tenant RLS and tenant-consistent foreign keys', async () => {
    const start = await service.startConversation(auth, randomUUID(), input());
    const rows = await withDrizzleTenantContext(db, { businessId: otherBusinessId }, (tx) =>
      tx.select().from(schema.chatMessages),
    );
    expect(rows).toEqual([]);
    await expect(
      withDrizzleTenantContext(db, { businessId: otherBusinessId }, (tx) =>
        tx.insert(schema.chatMessages).values({
          businessId: otherBusinessId,
          conversationId: start.conversationId,
          sequence: 100,
          senderType: 'visitor',
          senderId: randomUUID(),
          audience: 'public',
          body: 'Cross tenant',
          fingerprint: 'test',
          clientMessageId: randomUUID(),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withDrizzleTenantContext(db, { businessId: otherBusinessId }, (tx) =>
        tx.insert(schema.chatIntegrations).values({
          businessId,
          credentialHash: 'test',
          allowedOrigin: 'https://chat.test',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rolls message and sequence back when outbox persistence fails', async () => {
    const start = await service.startConversation(auth, randomUUID(), input());
    await connection.unsafe('REVOKE INSERT ON chat_outbox FROM app_user');
    try {
      await expect(
        service.sendVisitorMessage(auth, start.conversationId, input('Must roll back')),
      ).rejects.toThrow();
    } finally {
      await connection.unsafe('GRANT INSERT ON chat_outbox TO app_user');
    }
    const history = await service.visitorHistory(auth, start.conversationId);
    expect(history.data).toHaveLength(1);
    const reply = await service.sendVisitorMessage(
      auth,
      start.conversationId,
      input('Now succeeds'),
    );
    expect(reply.sequence).toBe(2);
  });

  it('rejects visitor-supplied roles and private-note visibility', async () => {
    await expect(
      service.startConversation(auth, randomUUID(), {
        ...input(),
        audience: 'internal',
        senderType: 'staff',
        businessId,
      }),
    ).rejects.toThrow('Write a message');
  });
});

describe('live inbox snapshots', () => {
  it('only advances visitor watermark for public visitor messages and includes only a public visitor preview', async () => {
    const start = await service.startConversation(auth, randomUUID(), input('Live visitor'));
    const before = (await service.staffLiveSnapshot(staff)).find(
      (row) => row.id === start.conversationId,
    )!;
    await service.sendStaffMessage(staff, start.conversationId, input('Staff reply'));
    await service.sendStaffMessage(staff, start.conversationId, input('Private note'), 'note');
    const staffOnly = (await service.staffLiveSnapshot(staff)).find(
      (row) => row.id === start.conversationId,
    )!;
    expect(staffOnly.visitorSequence).toBe(before.visitorSequence);
    expect(staffOnly.lastSequence).toBeGreaterThan(before.lastSequence);
    await service.sendVisitorMessage(auth, start.conversationId, input('Another visitor message'));
    const updated = (await service.staffLiveSnapshot(staff)).find(
      (row) => row.id === start.conversationId,
    )!;
    expect(updated.visitorSequence).toBeGreaterThan(staffOnly.visitorSequence);
    expect(updated).not.toHaveProperty('body');
    expect(updated.preview).toBe('Another visitor message');
    expect(JSON.stringify(updated)).not.toContain('Private note');
    expect(JSON.stringify(updated)).not.toContain('Staff reply');
    expect(updated).toHaveProperty('version');
    await expect(
      service.staffLiveSnapshot({ ...staff, businessId: otherBusinessId }),
    ).rejects.toThrow();
    await expect(service.staffLiveSnapshot({ ...staff, permissions: new Set() })).rejects.toThrow();
  });
});

describe('chat workflow, activity and push', () => {
  it('serializes competing claims, requires permissions and rejects stale versions', async () => {
    await db.insert(schema.rolePermissions).values(
      ['chat.assign', 'chat.manage', 'chat.export'].map((permission) => ({
        roleId: staff.roleId!,
        permission,
      })),
    );
    const start = await service.startConversation(auth, randomUUID(), input());
    const row = (await service.staffLiveSnapshot(staff)).find(
      (r) => r.id === start.conversationId,
    )!;
    const results = await Promise.allSettled([
      service.workflow(staff, row.id, { action: 'claim', version: row.version }),
      service.workflow(staff, row.id, { action: 'claim', version: row.version }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const updated = (await service.staffLiveSnapshot(staff)).find((r) => r.id === row.id)!;
    expect(updated.assignedToMe).toBe(true);
    await service.workflow(staff, row.id, { action: 'resolve', version: updated.version });
    expect((await service.staffLiveSnapshot(staff)).find((r) => r.id === row.id)?.status).toBe(
      'resolved',
    );
    await expect(
      service.workflow({ ...staff, businessId: otherBusinessId }, row.id, {
        action: 'claim',
        version: 1,
      }),
    ).rejects.toThrow();
  });
  it('read cursors are monotonic and private notes do not enter visitor activity or export', async () => {
    const start = await service.startConversation(auth, randomUUID(), input());
    await service.sendStaffMessage(staff, start.conversationId, input('Public answer'));
    await service.sendStaffMessage(staff, start.conversationId, input('Secret note'), 'note');
    await service.activity(null, auth, start.conversationId, { typing: true, readSequence: 3 });
    await service.activity(null, auth, start.conversationId, { readSequence: 0 });
    const row = (await service.staffLiveSnapshot(staff)).find(
      (r) => r.id === start.conversationId,
    )!;
    expect(row.visitorReadSequence).toBe(2);
    expect(row.visitorTyping).toBe(true);
    await service.activity(staff, null, start.conversationId, { typing: true, readSequence: 3 });
    const history = await service.visitorHistory(auth, start.conversationId);
    expect(history.activity).toMatchObject({ typing: true, staffReadSequence: 2 });
    expect(
      JSON.stringify(await service.exportTranscript(staff, start.conversationId)),
    ).not.toContain('Secret note');
    await expect(
      service.activity(null, otherVisitor, start.conversationId, { typing: true }),
    ).rejects.toThrow();
  });
  it('durably queues visitor-only push, retries outages, and removes expired subscriptions', async () => {
    await expect(
      service.subscribePush(staff, {
        endpoint: 'https://127.0.0.1/internal',
        keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
      }),
    ).rejects.toThrow();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/' + randomUUID();
    await service.subscribePush(staff, {
      endpoint,
      keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
    });
    const start = await service.startConversation(auth, randomUUID(), input());
    await service.sendStaffMessage(staff, start.conversationId, input('Private push note'), 'note');
    const queued = await db
      .select()
      .from(schema.chatPushDeliveries)
      .where(eq(schema.chatPushDeliveries.conversationId, start.conversationId));
    expect(queued).toHaveLength(1);
    let now = new Date();
    let fail = true;
    const payloads: string[] = [];
    const worker = new ChatPushWorker(
      db,
      async (_subscription, payload) => {
        payloads.push(payload);
        if (fail) throw Error('offline');
      },
      'staging',
      () => now,
    );
    await worker.runOnce(businessId);
    expect(payloads[0]).not.toContain('Private push note');
    now = new Date(Date.now() + 60000);
    fail = false;
    await worker.runOnce(businessId);
    expect(
      (
        await db
          .select()
          .from(schema.chatPushDeliveries)
          .where(eq(schema.chatPushDeliveries.id, queued[0]!.id))
      )[0]?.completedAt,
    ).toBeTruthy();
    await service.sendVisitorMessage(auth, start.conversationId, input('Another visitor message'));
    const gone = new ChatPushWorker(
      db,
      async () => {
        throw { statusCode: 410 };
      },
      'staging',
      () => now,
    );
    await gone.runOnce(businessId);
    expect(
      await db
        .select()
        .from(schema.chatPushSubscriptions)
        .where(eq(schema.chatPushSubscriptions.endpoint, endpoint)),
    ).toHaveLength(0);
  });
});

describe('chat capacity and operations', () => {
  it('enforces a staff capacity limit and expires availability', async () => {
    await service.availability(staff, { available: true, capacity: 1 });
    const first = await service.startConversation(auth, randomUUID(), input());
    const second = await service.startConversation(auth, randomUUID(), input());
    const rows = await service.staffLiveSnapshot(staff);
    await service.workflow(staff, first.conversationId, {
      action: 'claim',
      version: rows.find((r) => r.id === first.conversationId)!.version,
    });
    await expect(
      service.workflow(staff, second.conversationId, {
        action: 'claim',
        version: rows.find((r) => r.id === second.conversationId)!.version,
      }),
    ).rejects.toThrow('capacity');
    expect((await service.visitorHistory(auth, first.conversationId)).activity?.teamAvailable).toBe(
      true,
    );
    await db
      .update(schema.chatAgents)
      .set({ heartbeatUntil: new Date(0) })
      .where(eq(schema.chatAgents.businessId, businessId));
    expect((await service.visitorHistory(auth, first.conversationId)).activity?.teamAvailable).toBe(
      false,
    );
    const row = (await service.staffLiveSnapshot(staff)).find(
      (r) => r.id === first.conversationId,
    )!;
    await service.workflow(staff, first.conversationId, {
      action: 'release',
      version: row.version,
    });
    await service.workflow(staff, second.conversationId, {
      action: 'claim',
      version: rows.find((r) => r.id === second.conversationId)!.version,
    });
  });
  it('shows delivery backlog and only retries failed jobs', async () => {
    const before = await service.operations(staff);
    expect(before.transport!.pending).toBeGreaterThan(0);
    const result = await service.retryFailed(staff);
    expect(result.retried).toBeGreaterThanOrEqual(0);
    await expect(service.operations({ ...staff, businessId: otherBusinessId })).rejects.toThrow();
  });
});

describe('push authorization at delivery', () => {
  it('drops queued notifications after the integration is disabled', async () => {
    await service.subscribePush(staff, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/' + randomUUID(),
      keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
    });
    const started = await service.startConversation(
      auth,
      randomUUID(),
      input('Must not notify after disable'),
    );
    await db
      .update(schema.chatIntegrations)
      .set({ enabled: false })
      .where(eq(schema.chatIntegrations.id, auth.integrationId));
    let sent = 0;
    const worker = new ChatPushWorker(
      db,
      async () => {
        sent++;
      },
      'staging',
    );
    try {
      await worker.runOnce(businessId);
      expect(sent).toBe(0);
      const [job] = await db
        .select()
        .from(schema.chatPushDeliveries)
        .where(eq(schema.chatPushDeliveries.conversationId, started.conversationId));
      expect(job?.completedAt).toBeTruthy();
    } finally {
      await db
        .update(schema.chatIntegrations)
        .set({ enabled: true })
        .where(eq(schema.chatIntegrations.id, auth.integrationId));
    }
  });
});

describe('visitor follow-up and ending a chat', () => {
  it('saves consented contact claims privately, tracks completion and ends only the visitor own chat', async () => {
    const start = await service.startConversation(auth, randomUUID(), input('Please help later'));
    const contact = {
      name: 'Synthetic Visitor',
      method: 'email',
      contact: 'visitor@example.test',
      consent: true,
    };
    await expect(
      service.visitorFollowup(auth, start.conversationId, { ...contact, consent: false }),
    ).rejects.toThrow();
    await expect(
      service.visitorFollowup(otherVisitor, start.conversationId, contact),
    ).rejects.toThrow();
    await service.visitorFollowup(auth, start.conversationId, contact);
    const rows = await service.staffLiveSnapshot(staff);
    expect(rows.find((r) => r.id === start.conversationId)?.followupPending).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('visitor@example.test');
    expect(await service.followup(staff, start.conversationId)).toMatchObject({
      contact: 'visitor@example.test',
      verified: false,
    });
    expect(JSON.stringify(await service.visitorHistory(auth, start.conversationId))).not.toContain(
      'visitor@example.test',
    );
    await service.followup(staff, start.conversationId, true);
    expect(
      (await service.staffLiveSnapshot(staff)).find((r) => r.id === start.conversationId)
        ?.followupPending,
    ).toBe(false);
    await expect(service.endVisitorChat(otherVisitor, start.conversationId)).rejects.toThrow();
    await service.endVisitorChat(auth, start.conversationId);
    expect((await service.visitorHistory(auth, start.conversationId)).activity?.status).toBe(
      'resolved',
    );
  });
});

it('enforces tenant RLS on presence, subscriptions and queued push jobs', async () => {
  const own = await withDrizzleTenantContext(db, { businessId }, async (tx) => ({
    subscriptions: await tx.select().from(schema.chatPushSubscriptions),
    agents: await tx.select().from(schema.chatAgents),
    deliveries: await tx.select().from(schema.chatPushDeliveries),
  }));
  expect(own.subscriptions.length).toBeGreaterThan(0);
  expect(own.agents.length).toBeGreaterThan(0);
  expect(own.deliveries.length).toBeGreaterThan(0);
  const other = await withDrizzleTenantContext(db, { businessId: otherBusinessId }, async (tx) => ({
    subscriptions: await tx.select().from(schema.chatPushSubscriptions),
    agents: await tx.select().from(schema.chatAgents),
    deliveries: await tx.select().from(schema.chatPushDeliveries),
  }));
  expect(other).toEqual({ subscriptions: [], agents: [], deliveries: [] });
});

describe('scoped staff access', () => {
  it('restricts assigned-only staff and store scopes on reads, writes, exports and live snapshots', async () => {
    const mine = await service.startConversation(auth, randomUUID(), input('Scoped visitor'));
    const other = await service.startConversation(auth, randomUUID(), input('Not assigned'));
    await db
      .update(schema.chatConversations)
      .set({ assignedMembershipId: staff.membershipId })
      .where(eq(schema.chatConversations.id, mine.conversationId));
    await db.insert(schema.membershipPermissionOverrides).values([
      {
        businessId,
        membershipId: staff.membershipId!,
        permission: 'chat.view_team',
        allowed: false,
      },
      {
        businessId,
        membershipId: staff.membershipId!,
        permission: 'chat.view_assigned',
        allowed: true,
      },
    ]);
    const assigned = { ...staff, permissions: new Set(['chat.view_assigned', 'chat.reply']) };
    try {
      expect(
        (await service.staffLiveSnapshot(assigned)).some((row) => row.id === other.conversationId),
      ).toBe(false);
      expect((await service.staffHistory(assigned, mine.conversationId)).data).toHaveLength(1);
      await expect(service.staffHistory(assigned, other.conversationId)).rejects.toThrow(
        'not found',
      );
      await expect(
        service.sendStaffMessage(assigned, other.conversationId, input()),
      ).rejects.toThrow('not found');
      await expect(service.exportTranscript(assigned, other.conversationId)).rejects.toThrow(
        'not found',
      );
      const [location] = await db
        .insert(schema.locations)
        .values({ businessId, name: 'Scoped showroom', timezone: 'America/Los_Angeles' })
        .returning();
      await db
        .update(schema.memberships)
        .set({ dataScope: 'store' })
        .where(eq(schema.memberships.id, staff.membershipId!));
      const scoped = { ...assigned, dataScope: 'store' as const };
      expect(await service.staffLiveSnapshot(scoped)).toEqual([]);
      await db
        .insert(schema.membershipLocationScopes)
        .values({ businessId, membershipId: staff.membershipId!, locationId: location!.id });
      await db
        .update(schema.chatConversations)
        .set({ locationId: location!.id })
        .where(eq(schema.chatConversations.id, mine.conversationId));
      expect((await service.staffLiveSnapshot(scoped)).map((row) => row.id)).toEqual([
        mine.conversationId,
      ]);
      await service.sendStaffMessage(scoped, mine.conversationId, input('Scoped reply'));
      await db
        .delete(schema.membershipLocationScopes)
        .where(eq(schema.membershipLocationScopes.membershipId, staff.membershipId!));
      await expect(service.staffHistory(scoped, mine.conversationId)).rejects.toThrow('not found');
    } finally {
      await db
        .delete(schema.membershipPermissionOverrides)
        .where(eq(schema.membershipPermissionOverrides.membershipId, staff.membershipId!));
      await db
        .update(schema.memberships)
        .set({ dataScope: 'all' })
        .where(eq(schema.memberships.id, staff.membershipId!));
    }
  });
});
describe('chat administration and routing', () => {
  it('uses Los Angeles opening times, holidays and versioned manager settings', async () => {
    const config = chatSettingsSchema.parse({
      hoursEnabled: true,
      hours: [{ day: 1, open: '10:00', close: '18:00' }],
    });
    expect(withinChatHours(config, new Date('2026-09-14T16:59:00Z'))).toBe(false);
    expect(withinChatHours(config, new Date('2026-09-14T17:00:00Z'))).toBe(true);
    expect(withinChatHours(config, new Date('2026-09-15T01:00:00Z'))).toBe(false);
    expect(
      withinChatHours({ ...config, holidays: ['2026-09-14'] }, new Date('2026-09-14T17:00:00Z')),
    ).toBe(false);
    // PST in winter: the same 10:00 opening corresponds to 18:00 UTC.
    expect(withinChatHours(config, new Date('2026-12-14T17:30:00Z'))).toBe(false);
    expect(withinChatHours(config, new Date('2026-12-14T18:00:00Z'))).toBe(true);
    const current = await service.settings(staff);
    const saved = await service.settings(staff, { version: current.version, config });
    await expect(service.settings(staff, { version: current.version, config })).rejects.toThrow(
      'changed',
    );
    await expect(service.settings({ ...staff, businessId: otherBusinessId })).rejects.toThrow();
    await service.settings(staff, {
      version: saved.version,
      config: { ...config, hoursEnabled: false },
    });
  });
  it('serializes automatic assignment against capacity and accepts or expires ownership', async () => {
    await db
      .update(schema.chatConversations)
      .set({ status: 'resolved' })
      .where(eq(schema.chatConversations.businessId, businessId));
    await service.availability(staff, { available: true, capacity: 1 });
    const settings = await service.settings(staff);
    await service.settings(staff, {
      version: settings.version,
      config: { ...settings.config, autoAssign: true, hoursEnabled: false, acceptanceMinutes: 1 },
    });
    const first = await service.startConversation(auth, randomUUID(), input('First queued'));
    const second = await service.startConversation(auth, randomUUID(), input('Second queued'));
    await Promise.all([service.maintenance(businessId), service.maintenance(businessId)]);
    let rows = await service.staffLiveSnapshot(staff);
    expect(
      rows.filter(
        (row) =>
          [first.conversationId, second.conversationId].includes(row.id) &&
          row.assignedMembershipId,
      ),
    ).toHaveLength(1);
    const owned = rows.find((row) => row.id === first.conversationId)!;
    await service.acceptAssignment(staff, owned.id);
    await db
      .update(schema.chatConversations)
      .set({ assignedAt: new Date(Date.now() - 120000) })
      .where(eq(schema.chatConversations.id, owned.id));
    await service.maintenance(businessId);
    expect(
      (await service.staffLiveSnapshot(staff)).find((row) => row.id === owned.id)?.assignedToMe,
    ).toBe(true);
    await db
      .update(schema.chatConversations)
      .set({ acceptedAt: null })
      .where(eq(schema.chatConversations.id, owned.id));
    const result = await service.maintenance(businessId);
    expect(result.expired).toBe(1);
    rows = await service.staffLiveSnapshot(staff);
    expect(
      rows.filter(
        (row) =>
          ['open', 'queued', 'waiting_customer'].includes(row.status) && row.assignedMembershipId,
      ),
    ).toHaveLength(1);
    const current = await service.settings(staff);
    await service.settings(staff, {
      version: current.version,
      config: { ...current.config, autoAssign: false },
    });
  });
  it('guards context, customer linking and settings kill switch without exposing private data', async () => {
    const start = await service.startConversation(auth, randomUUID(), input('Product question'), {
      topic: 'mattress',
      locationId: null,
      pagePath: '/products/test-mattress',
    });
    expect((await service.context(staff, start.conversationId)).context).toMatchObject({
      topic: 'mattress',
      pagePath: '/products/test-mattress',
    });
    await expect(
      service.visitorContext(auth, start.conversationId, {
        topic: 'order',
        locationId: randomUUID(),
        pagePath: '/',
      }),
    ).rejects.toThrow('showroom');
    await db
      .insert(schema.rolePermissions)
      .values({ roleId: staff.roleId!, permission: 'customers.view' });
    const customerStaff = {
      ...staff,
      permissions: new Set([...staff.permissions, 'customers.view']),
    };
    const [customer] = await db
      .insert(schema.customers)
      .values({ businessId, firstName: 'Synthetic', lastName: 'Chat' })
      .returning();
    const context = await service.context(staff, start.conversationId);
    await expect(
      service.linkCustomer(customerStaff, start.conversationId, {
        customerId: customer!.id,
        version: context.version,
        verificationConfirmed: false,
      }),
    ).rejects.toThrow();
    await service.linkCustomer(customerStaff, start.conversationId, {
      customerId: customer!.id,
      version: context.version,
      verificationConfirmed: true,
    });
    expect((await service.context(staff, start.conversationId)).customerId).toBe(customer!.id);
    expect(JSON.stringify(await service.visitorHistory(auth, start.conversationId))).not.toContain(
      customer!.id,
    );
    await service.sendStaffMessage(staff, start.conversationId, input('First human answer'));
    await service.endVisitorChat(auth, start.conversationId);
    await service.rating(auth, start.conversationId, { rating: 5 });
    expect(Number((await service.report(staff)).satisfaction)).toBe(5);
    const current = await service.settings(staff);
    const disabled = await service.settings(staff, {
      version: current.version,
      config: { ...current.config, enabled: false },
    });
    await expect(service.sendVisitorMessage(auth, start.conversationId, input())).rejects.toThrow(
      'disabled',
    );
    await service.settings(staff, {
      version: disabled.version,
      config: { ...disabled.config, enabled: true },
    });
  });
  it('previews and deletes only eligible archived chats within the current business', async () => {
    const archived = await service.startConversation(auth, randomUUID(), input('Old archived'));
    const active = await service.startConversation(auth, randomUUID(), input('Keep active'));
    const old = new Date(Date.now() - 90 * 86400000);
    await db
      .update(schema.chatConversations)
      .set({ status: 'resolved', updatedAt: old })
      .where(eq(schema.chatConversations.id, archived.conversationId));
    await db
      .update(schema.chatConversations)
      .set({ updatedAt: old })
      .where(eq(schema.chatConversations.id, active.conversationId));
    const current = await service.settings(staff);
    await service.settings(staff, {
      version: current.version,
      config: { ...current.config, retentionDays: 30 },
    });
    const preview = await service.retention(staff);
    expect(preview.eligible).toBe(1);
    await expect(
      service.retention(staff, { confirmation: 'wrong', version: preview.version }),
    ).rejects.toThrow();
    expect(
      (
        await service.retention(staff, {
          confirmation: 'DELETE ELIGIBLE CHATS',
          version: preview.version,
        })
      ).deleted,
    ).toBe(1);
    expect(
      await db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.conversationId, archived.conversationId)),
    ).toEqual([]);
    expect((await service.staffHistory(staff, active.conversationId)).data).toHaveLength(1);
    expect(
      await withDrizzleTenantContext(db, { businessId: otherBusinessId }, (tx) =>
        tx.select().from(schema.chatSettings),
      ),
    ).toEqual([]);
  });
});

describe('transfer and response targets', () => {
  it('transfers only to eligible staff within capacity and requires the actual owner to accept', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        name: 'Transfer Test',
        email: `transfer-${randomUUID()}@example.test`,
        emailVerified: true,
      })
      .returning();
    const [membership] = await db
      .insert(schema.memberships)
      .values({ businessId, userId: user!.id, roleId: staff.roleId!, status: 'active' })
      .returning();
    const target = { ...staff, userId: user!.id, membershipId: membership!.id };
    try {
      await service.availability(target, { available: true, capacity: 1 });
      const first = await service.startConversation(auth, randomUUID(), input('Transfer one'));
      const second = await service.startConversation(auth, randomUUID(), input('Transfer two'));
      const context = await service.context(staff, first.conversationId);
      await service.transfer(staff, first.conversationId, {
        membershipId: membership!.id,
        version: context.version,
      });
      await expect(service.acceptAssignment(staff, first.conversationId)).rejects.toThrow(
        'assigned teammate',
      );
      await service.acceptAssignment(target, first.conversationId);
      const other = await service.context(staff, second.conversationId);
      await expect(
        service.transfer(staff, second.conversationId, {
          membershipId: membership!.id,
          version: other.version,
        }),
      ).rejects.toThrow('capacity');
      await expect(
        service.transfer(staff, first.conversationId, {
          membershipId: membership!.id,
          version: context.version,
        }),
      ).rejects.toThrow('changed');
      await db.insert(schema.membershipPermissionOverrides).values({
        businessId,
        membershipId: membership!.id,
        permission: 'chat.reply',
        allowed: false,
      });
      expect(
        (await service.context(staff, second.conversationId)).agents.some(
          (agent) => agent.id === membership!.id,
        ),
      ).toBe(false);
    } finally {
      await db.delete(schema.chatAgents).where(eq(schema.chatAgents.membershipId, membership!.id));
      await db.delete(schema.users).where(eq(schema.users.id, user!.id));
    }
  });
  it('marks unanswered chats overdue, clears the target after a human reply, and bounds customer search', async () => {
    const first = await service.startConversation(auth, randomUUID(), input('Waiting too long'));
    await db
      .update(schema.chatConversations)
      .set({ awaitingSince: new Date(Date.now() - 25 * 60 * 1000) })
      .where(eq(schema.chatConversations.id, first.conversationId));
    expect(
      (await service.staffLiveSnapshot(staff)).find((row) => row.id === first.conversationId)
        ?.overdue,
    ).toBe(true);
    await service.sendStaffMessage(staff, first.conversationId, input('Human response'));
    expect(
      (await service.staffLiveSnapshot(staff)).find((row) => row.id === first.conversationId)
        ?.overdue,
    ).toBe(false);
    const results = await service.customerCandidates(staff, { q: 'Synthetic' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);
    expect(await service.customerCandidates(staff, { q: '%%%' })).toEqual([]);
    await expect(
      service.customerCandidates({ ...staff, businessId: otherBusinessId }, { q: 'Synthetic' }),
    ).rejects.toThrow();
  });
});

describe('first person to accept', () => {
  it('assigns exactly one winner when two different staff accept together', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        name: 'Competing agent',
        email: `claim-${randomUUID()}@example.test`,
        emailVerified: true,
      })
      .returning();
    const [membership] = await db
      .insert(schema.memberships)
      .values({ businessId, userId: user!.id, roleId: staff.roleId!, status: 'active' })
      .returning();
    const teammate = { ...staff, userId: user!.id, membershipId: membership!.id };
    try {
      await service.availability(staff, { available: true, capacity: 20 });
      await service.availability(teammate, { available: true, capacity: 20 });
      const start = await service.startConversation(auth, randomUUID(), input('First accept race'));
      const [row] = await db
        .select()
        .from(schema.chatConversations)
        .where(eq(schema.chatConversations.id, start.conversationId));
      const result = await Promise.allSettled(
        [staff, teammate].map((person) =>
          service.workflow(person, row!.id, { action: 'claim', version: row!.version }),
        ),
      );
      expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      const winner = result.findIndex((item) => item.status === 'fulfilled');
      const [saved] = await db
        .select()
        .from(schema.chatConversations)
        .where(eq(schema.chatConversations.id, row!.id));
      expect(saved!.assignedMembershipId).toBe([staff, teammate][winner]!.membershipId);
      expect(saved!.acceptedAt).not.toBeNull();
      await expect(
        service.workflow([staff, teammate][1 - winner]!, row!.id, {
          action: 'claim',
          version: saved!.version,
        }),
      ).rejects.toThrow('already accepted');
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, user!.id));
    }
  });
});

describe('shared inbox across stores', () => {
  it('shows unassigned shared chats to store staff and preserves access after they accept', async () => {
    const settings = await service.settings(staff);
    await service.settings(staff, {
      version: settings.version,
      config: { ...settings.config, sharedInbox: true, autoAssign: false },
    });
    const [user] = await db
      .insert(schema.users)
      .values({
        name: 'Store agent',
        email: `shared-${randomUUID()}@example.test`,
        emailVerified: true,
      })
      .returning();
    const [member] = await db
      .insert(schema.memberships)
      .values({
        businessId,
        userId: user!.id,
        roleId: staff.roleId!,
        status: 'active',
        dataScope: 'store',
      })
      .returning();
    const agent = {
      ...staff,
      userId: user!.id,
      membershipId: member!.id,
      dataScope: 'store' as const,
    };
    try {
      const start = await service.startConversation(
        auth,
        randomUUID(),
        input('Shared store queue'),
      );
      const row = (await service.staffLiveSnapshot(agent)).find(
        (row) => row.id === start.conversationId,
      )!;
      expect(row).toBeDefined();
      await expect(service.sendStaffMessage(agent, row.id, input('Too early'))).rejects.toThrow(
        'Accept this chat',
      );
      await service.workflow(agent, row.id, { action: 'claim', version: row.version });
      expect((await service.staffHistory(agent, row.id)).data).toHaveLength(1);
      await service.sendStaffMessage(agent, row.id, input('Accepted from store'));
      const [location] = await db
        .insert(schema.locations)
        .values({
          businessId,
          name: 'Restricted historical showroom',
          timezone: 'America/Los_Angeles',
        })
        .returning();
      const restricted = await service.startConversation(
        auth,
        randomUUID(),
        input('Store restricted'),
        { topic: 'showroom', locationId: location!.id, pagePath: '/' },
      );
      await expect(service.staffHistory(agent, restricted.conversationId)).rejects.toThrow(
        'not found',
      );
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, user!.id));
      const current = await service.settings(staff);
      await service.settings(staff, { version: current.version, config: settings.config });
    }
  });
});
