import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import { CHAT_CONTRACT_VERSION, chatMessageInputSchema } from '@jetnine/shared';
import { Public } from '../tenancy/decorators';

const json = (schema: unknown) => ({ 'application/json': { schema } });
const input = z.toJSONSchema(chatMessageInputSchema);
const createInput = z.toJSONSchema(
  chatMessageInputSchema.extend({ clientConversationId: z.string().uuid() }),
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
export const chatOpenApi = {
  openapi: '3.1.0',
  info: {
    title: 'LA Mattress human chat API',
    version: CHAT_CONTRACT_VERSION,
    description:
      'Visitor operations are server-to-server from the storefront adapter. Integration and guest credentials must never be exposed to browser JavaScript. Staff mutations require an allowed Origin and X-Chat-Request: 1.',
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
