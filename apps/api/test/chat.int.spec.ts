import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
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
