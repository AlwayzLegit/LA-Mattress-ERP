import { and, eq, inArray } from 'drizzle-orm';
import { schema, type DrizzleTransaction } from '@jetnine/db';

type Target =
  | { kind: 'team_message'; teamRoomId: string; sequence: number }
  | { kind: 'help_request' | 'help_message'; helpRequestId: string; sequence: number };
export async function queueInternalPush(
  tx: DrizzleTransaction,
  businessId: string,
  environment: string,
  recipients: string[],
  target: Target,
) {
  if (!recipients.length) return;
  const subscriptions = await tx
    .select({ id: schema.chatPushSubscriptions.id })
    .from(schema.chatPushSubscriptions)
    .where(
      and(
        eq(schema.chatPushSubscriptions.businessId, businessId),
        eq(schema.chatPushSubscriptions.environment, environment),
        inArray(schema.chatPushSubscriptions.membershipId, recipients),
      ),
    );
  if (subscriptions.length)
    await tx
      .insert(schema.chatPushDeliveries)
      .values(
        subscriptions.map((s) => ({
          businessId,
          subscriptionId: s.id,
          ...target,
          availableAt: new Date(Date.now() + 5000),
        })),
      )
      .onConflictDoNothing();
}

/** Evaluate immediately before a push attempt, including retries. Payloads never include message text. */
export async function internalPushAllowed(
  tx: DrizzleTransaction,
  businessId: string,
  environment: string,
  job: typeof schema.chatPushDeliveries.$inferSelect,
  member: typeof schema.memberships.$inferSelect,
) {
  const [settings] = await tx
    .select()
    .from(schema.chatSettings)
    .where(eq(schema.chatSettings.businessId, businessId));
  if ((settings?.configJson as { enabled?: boolean } | undefined)?.enabled === false) return false;
  if (job.kind === 'team_message' && job.teamRoomId) {
    const [room] = await tx
      .select()
      .from(schema.chatTeamRooms)
      .where(
        and(
          eq(schema.chatTeamRooms.businessId, businessId),
          eq(schema.chatTeamRooms.id, job.teamRoomId),
        ),
      );
    if (!room) return false;
    if (room.kind === 'direct' && ![room.memberA, room.memberB].includes(member.id)) return false;
    if (room.kind === 'store') {
      const [location] = await tx
        .select()
        .from(schema.locations)
        .where(
          and(
            eq(schema.locations.businessId, businessId),
            eq(schema.locations.id, room.locationId!),
            eq(schema.locations.isActive, true),
          ),
        );
      if (!location) return false;
      if (member.dataScope !== 'all') {
        if (member.dataScope !== 'store') return false;
        const [scope] = await tx
          .select()
          .from(schema.membershipLocationScopes)
          .where(
            and(
              eq(schema.membershipLocationScopes.businessId, businessId),
              eq(schema.membershipLocationScopes.membershipId, member.id),
              eq(schema.membershipLocationScopes.locationId, room.locationId!),
            ),
          );
        if (!scope) return false;
      }
    }
    const [message] = await tx
      .select({ senderId: schema.chatTeamMessages.senderId })
      .from(schema.chatTeamMessages)
      .where(
        and(
          eq(schema.chatTeamMessages.businessId, businessId),
          eq(schema.chatTeamMessages.roomId, room.id),
          eq(schema.chatTeamMessages.sequence, job.sequence),
        ),
      );
    const [activity] = await tx
      .select()
      .from(schema.chatTeamActivity)
      .where(
        and(
          eq(schema.chatTeamActivity.businessId, businessId),
          eq(schema.chatTeamActivity.roomId, room.id),
          eq(schema.chatTeamActivity.membershipId, member.id),
        ),
      );
    return Boolean(
      message && message.senderId !== member.id && (activity?.readSequence ?? 0) < job.sequence,
    );
  }
  if (!job.helpRequestId || !['help_request', 'help_message'].includes(job.kind)) return false;
  const h = schema.chatHelpRequests;
  const [request] = await tx
    .select()
    .from(h)
    .where(and(eq(h.businessId, businessId), eq(h.id, job.helpRequestId)));
  if (!request || ![request.requesterId, request.helperId].includes(member.id)) return false;
  const [source] = await tx
    .select({
      conversation: schema.chatConversations,
      enabled: schema.chatIntegrations.enabled,
      environment: schema.chatIntegrations.environment,
      revokedAt: schema.chatSessions.revokedAt,
    })
    .from(schema.chatConversations)
    .innerJoin(
      schema.chatSessions,
      and(
        eq(schema.chatSessions.businessId, businessId),
        eq(schema.chatSessions.id, schema.chatConversations.sessionId),
      ),
    )
    .innerJoin(
      schema.chatIntegrations,
      and(
        eq(schema.chatIntegrations.businessId, businessId),
        eq(schema.chatIntegrations.id, schema.chatSessions.integrationId),
      ),
    )
    .where(
      and(
        eq(schema.chatConversations.businessId, businessId),
        eq(schema.chatConversations.id, request.conversationId),
      ),
    );
  if (
    !source?.enabled ||
    source.revokedAt ||
    source.environment !== environment ||
    source.conversation.assignedMembershipId !== request.requesterId ||
    ['resolved', 'spam'].includes(source.conversation.status)
  )
    return false;
  if (job.kind === 'help_request')
    return (
      request.status === 'requested' &&
      request.helperId === member.id &&
      request.version === job.sequence
    );
  if (request.status !== 'accepted') return false;
  const [message] = await tx
    .select({ senderId: schema.chatHelpMessages.senderId })
    .from(schema.chatHelpMessages)
    .where(
      and(
        eq(schema.chatHelpMessages.businessId, businessId),
        eq(schema.chatHelpMessages.requestId, request.id),
        eq(schema.chatHelpMessages.sequence, job.sequence),
      ),
    );
  const read =
    member.id === request.helperId ? request.helperReadSequence : request.requesterReadSequence;
  return Boolean(message && message.senderId !== member.id && read < job.sequence);
}
