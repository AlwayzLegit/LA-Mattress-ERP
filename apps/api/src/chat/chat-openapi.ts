import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import {
  CHAT_CONTRACT_VERSION,
  chatMessageInputSchema,
  chatActivitySchema,
  chatFollowupSchema,
  chatWorkflowSchema,
  chatAvailabilitySchema,
  chatPushSubscriptionSchema,
  chatSettingsSchema,
  chatContextSchema,
  chatTransferSchema,
  chatLinkSchema,
} from '@jetnine/shared';
import { Public } from '../tenancy/decorators';

const json = (schema: unknown) => ({ 'application/json': { schema } });
const input = z.toJSONSchema(chatMessageInputSchema);
const createInput = z.toJSONSchema(
  chatMessageInputSchema.extend({
    clientConversationId: z.string().uuid(),
    context: chatContextSchema.optional(),
  }),
);
const historyParameters = [
  { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
  { name: 'afterSequence', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
];
const visitorSecurity = [{ IntegrationBearer: [], IntegrationId: [], GuestSession: [] }];
const staffSecurity = [{ StaffSession: [] }];
const errorResponses = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 429, 503].map((status) => [
    status,
    { description: 'Request rejected; no message acknowledgement is implied.' },
  ]),
);
const send = (security: unknown, schema: unknown) => ({
  security,
  requestBody: { required: true, content: json(schema) },
  responses: {
    '201': {
      description: 'Committed message with stable id, sequence, createdAt and persisted:true.',
    },
    ...errorResponses,
  },
});
const mutation = (security: unknown, description: string, schema?: unknown) => ({
  security,
  description,
  ...(schema ? { requestBody: { required: true, content: json(schema) } } : {}),
  responses: { '201': { description }, ...errorResponses },
});
const read = (description: string) => ({
  security: staffSecurity,
  responses: { '200': { description }, ...errorResponses },
});
export const chatOpenApi = {
  openapi: '3.1.0',
  info: {
    title: 'LA Mattress human chat API',
    version: CHAT_CONTRACT_VERSION,
    description:
      'Visitor operations are server-to-server from the storefront adapter. Integration and guest credentials must never be exposed to browser JavaScript. Staff access requires fresh chat.view_team or chat.view_assigned plus location scope. Staff mutations require an allowed Origin and X-Chat-Request: 1.',
  },
  components: {
    securitySchemes: {
      IntegrationBearer: { type: 'http', scheme: 'bearer' },
      IntegrationId: { type: 'apiKey', in: 'header', name: 'X-Chat-Integration-Id' },
      GuestSession: { type: 'apiKey', in: 'header', name: 'X-Chat-Session' },
      StaffSession: { type: 'apiKey', in: 'cookie', name: 'jetnine.session_token' },
    },
  },
  paths: {
    '/v1/chat/visitor/options': {
      get: {
        ...read('Public availability and showroom choices; no guest session required.'),
        security: [{ IntegrationBearer: [], IntegrationId: [] }],
      },
    },
    '/v1/chat/visitor/conversations/{id}/context': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        visitorSecurity,
        'Sets validated context before assignment.',
        z.toJSONSchema(chatContextSchema),
      ),
    },
    '/v1/chat/visitor/conversations/{id}/rating': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        visitorSecurity,
        'Rates the visitor own resolved conversation.',
        z.toJSONSchema(z.object({ rating: z.number().int().min(1).max(5) }).strict()),
      ),
    },
    '/v1/chat/conversations/settings': {
      get: read('Business-wide chat manager settings and optimistic version.'),
      post: mutation(
        staffSecurity,
        'Requires business-wide chat.manage. Audited versioned settings.',
        z.toJSONSchema(
          z.object({ config: chatSettingsSchema, version: z.number().int().min(0) }).strict(),
        ),
      ),
    },
    '/v1/chat/conversations/report': {
      get: read(
        'Scoped totals, response and resolution durations, overdue counts and satisfaction. Requires chat.manage.',
      ),
    },
    '/v1/chat/conversations/retention': {
      get: read(
        'Business-wide manager preview of eligible closed conversations; pending callbacks are excluded.',
      ),
      post: mutation(
        staffSecurity,
        'Audited deletion under the saved retention policy.',
        z.toJSONSchema(
          z
            .object({
              confirmation: z.literal('DELETE ELIGIBLE CHATS'),
              version: z.number().int().positive(),
            })
            .strict(),
        ),
      ),
    },
    '/v1/chat/conversations/customer-candidates': {
      get: {
        ...read(
          'Requires business-wide chat.manage and customers.view. At most ten matching customer identities.',
        ),
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 3, maxLength: 100 },
          },
        ],
      },
    },
    '/v1/chat/conversations/{id}/context': {
      parameters: historyParameters.slice(0, 1),
      get: read('Scoped visitor context, eligible agents, templates and assignment audit history.'),
    },
    '/v1/chat/conversations/{id}/transfer': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        staffSecurity,
        'Requires chat.assign and current version; validates target scope, presence and capacity.',
        z.toJSONSchema(chatTransferSchema),
      ),
    },
    '/v1/chat/conversations/{id}/accept': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(staffSecurity, 'Only the assigned owner with chat.reply may accept.'),
    },
    '/v1/chat/conversations/{id}/customer': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        staffSecurity,
        'Requires business-wide chat.manage and customers.view, explicit verification and current version. Never unlocks visitor history.',
        z.toJSONSchema(chatLinkSchema),
      ),
    },
    '/v1/chat/visitor/conversations/{id}/followup': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        visitorSecurity,
        'Stores a consented unverified contact claim for staff follow-up. Never links customer records or unlocks prior history.',
        z.toJSONSchema(chatFollowupSchema),
      ),
    },
    '/v1/chat/visitor/conversations/{id}/end': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        visitorSecurity,
        'Resolves the visitor own conversation; transcript is retained in the ERP.',
      ),
    },
    '/v1/chat/conversations/{id}/followup': {
      parameters: historyParameters.slice(0, 1),
      get: read('Visitor-provided unverified contact details and follow-up completion state.'),
    },
    '/v1/chat/conversations/{id}/followup-complete': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        staffSecurity,
        'Requires chat.reply. Audits follow-up completion without logging contact details.',
      ),
    },
    '/v1/chat/visitor/conversations/{id}/live': {
      parameters: historyParameters.slice(0, 1),
      get: {
        security: visitorSecurity,
        description:
          'Public message SSE with typing, staff read cursor, availability and lifecycle status. No private notes. Reconnect after the bounded connection expires.',
        responses: {
          '200': {
            description: 'Public messages and activity',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          ...errorResponses,
        },
      },
    },
    '/v1/chat/visitor/conversations/{id}/activity': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        visitorSecurity,
        'Monotonic public read cursor and six-second typing presence.',
        z.toJSONSchema(chatActivitySchema),
      ),
    },
    '/v1/chat/conversations/{id}/activity': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        staffSecurity,
        'Requires chat.reply. Read acknowledgement must come from a visible, focused transcript.',
        z.toJSONSchema(chatActivitySchema),
      ),
    },
    '/v1/chat/conversations/{id}/workflow': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        staffSecurity,
        'Requires chat.assign; changing another owner requires chat.manage. Version conflicts return 409. Claims enforce configured capacity. Snoozes must be within seven days.',
        z.toJSONSchema(chatWorkflowSchema),
      ),
    },
    '/v1/chat/conversations/{id}/export': {
      parameters: historyParameters.slice(0, 1),
      post: mutation(
        staffSecurity,
        'Requires chat.export. Audited public transcript; private notes excluded.',
      ),
    },
    '/v1/chat/conversations/availability': {
      get: read('Current staff availability and capacity.'),
      post: mutation(
        staffSecurity,
        'Requires chat.reply. Availability expires 45 seconds after last heartbeat.',
        z.toJSONSchema(chatAvailabilitySchema),
      ),
    },
    '/v1/chat/conversations/operations': {
      get: read('Requires chat.manage. Pending and failed delivery counts for this tenant.'),
    },
    '/v1/chat/conversations/retry-failed': {
      post: mutation(
        staffSecurity,
        'Requires chat.manage. Audited retry of failed transport and browser push deliveries.',
      ),
    },
    '/v1/chat/conversations/push-key': {
      get: read('Public VAPID key. Returns 503 unless background push is configured.'),
    },
    '/v1/chat/conversations/push-subscribe': {
      post: mutation(
        staffSecurity,
        'Registers this browser subscription for the authenticated staff member. Only supported HTTPS browser push services are allowed.',
        z.toJSONSchema(chatPushSubscriptionSchema),
      ),
    },
    '/v1/chat/conversations/push-unsubscribe': {
      post: mutation(staffSecurity, 'Removes only the current staff user subscription.', {
        type: 'object',
        properties: { endpoint: { type: 'string' } },
        required: ['endpoint'],
        additionalProperties: false,
      }),
    },
    '/v1/chat/conversations/live': {
      get: {
        security: staffSecurity,
        description:
          'Pilot SSE stream. snapshot events contain conversations with id, status, updatedAt, lastSequence and visitorSequence. No message content. Connections renew every 30 seconds; rebaseline only on first load and fetch history after changed sequences. access-revoked ends access; unavailable requests reconnect.',
        responses: {
          '200': {
            description: 'Tenant-scoped metadata snapshots, checked once per second.',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          ...errorResponses,
        },
      },
    },
    '/v1/chat/visitor/session': {
      post: {
        security: [{ IntegrationBearer: [], IntegrationId: [] }],
        responses: {
          '201': {
            description:
              'Opaque credential and expiresAt; adapter stores credential in HttpOnly cookie.',
          },
          ...errorResponses,
        },
      },
    },
    '/v1/chat/visitor/conversations': { post: send(visitorSecurity, createInput) },
    '/v1/chat/visitor/conversations/{id}/messages': {
      parameters: historyParameters.slice(0, 1),
      post: send(visitorSecurity, input),
    },
    '/v1/chat/visitor/conversations/{id}/history': {
      get: {
        security: visitorSecurity,
        parameters: historyParameters,
        responses: {
          '200': { description: 'Public messages only: data, nextSequence, hasMore.' },
          ...errorResponses,
        },
      },
    },
    '/v1/chat/conversations': {
      get: {
        security: staffSecurity,
        parameters: [
          { name: 'afterId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: {
          '200': { description: 'Authorized team conversations: data, nextCursor, hasMore.' },
          ...errorResponses,
        },
      },
    },
    '/v1/chat/conversations/{id}/history': {
      get: {
        security: staffSecurity,
        parameters: historyParameters,
        responses: {
          '200': {
            description:
              'Authorized public messages and private notes: data, nextSequence, hasMore.',
          },
          ...errorResponses,
        },
      },
    },
    '/v1/chat/conversations/{id}/messages': {
      parameters: historyParameters.slice(0, 1),
      post: send(staffSecurity, input),
    },
    '/v1/chat/conversations/{id}/notes': {
      parameters: historyParameters.slice(0, 1),
      post: send(staffSecurity, input),
    },
  },
};
@Public()
@Controller('v1/chat/openapi.json')
export class ChatOpenApiController {
  @Get() get() {
    return chatOpenApi;
  }
}
