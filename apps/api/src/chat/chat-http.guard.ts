import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Request } from 'express';
import { REDIS } from '../redis/redis.module';
import { hashChatCredential } from './chat.service';
import type { RequestTenantContext } from '../tenancy/request-context';

function trafficBudget(path: string, method: string, visitor: boolean) {
  const normalized = path.replace(/\/+$/, '');
  if (method === 'POST' && normalized === '/v1/chat/visitor/session')
    return { name: 'session', peer: 600, identity: 20 };
  if (method === 'GET' || method === 'HEAD')
    // Several ERP tabs poll the queue, team help, directory and activity.
    return { name: 'read', peer: visitor ? 600 : 6000, identity: visitor ? 120 : 600 };
  if (
    method === 'POST' &&
    (normalized === '/v1/chat/conversations/availability' ||
      /^\/v1\/chat\/(?:visitor\/)?conversations\/(?:team\/rooms\/|help\/)?[^/]+\/(?:activity|context)$/.test(
        normalized,
      ))
  )
    return { name: 'activity', peer: visitor ? 600 : 2400, identity: visitor ? 120 : 240 };
  return { name: 'action', peer: 600, identity: 120 };
}
@Injectable()
export class ChatHttpGuard implements CanActivate {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.config.get('CHAT_ENABLED') !== 'true' ||
      !['staging', 'production'].includes(this.config.get('CHAT_ENVIRONMENT') ?? '')
    )
      throw new ServiceUnavailableException('Live chat is unavailable');
    const req = context.switchToHttp().getRequest<Request & { tenant?: RequestTenantContext }>();
    const visitor = req.path.startsWith('/v1/chat/visitor/');
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!req.is('application/json')) throw new HttpException('JSON required', 415);
      if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 16384)
        throw new HttpException('Chat request too large', 413);
      if (!visitor) {
        const origins = (this.config.get<string>('CHAT_STAFF_ORIGINS') ?? '')
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean);
        if (
          !req.headers.origin ||
          !origins.includes(req.headers.origin) ||
          req.headers['x-chat-request'] !== '1'
        )
          throw new ForbiddenException('Invalid chat request origin');
      }
    }
    if (!this.redis) throw new ServiceUnavailableException('Live chat is temporarily unavailable');
    const tenant = req.tenant;
    // Staff routes run after the tenancy/permission guards. Use the verified
    // identity, not cookies or caller-controlled visitor headers, for their limit.
    if (!visitor && (!tenant?.businessId || !(tenant.userId || tenant.apiKeyId)))
      throw new ForbiddenException('Chat staff authentication required');
    const identity = visitor
      ? `${req.headers['x-chat-integration-id'] ?? 'unknown'}:${req.headers['x-chat-session'] ?? 'new'}`
      : `${tenant!.businessId}:${tenant!.userId ?? tenant!.apiKeyId}`;
    const budget = trafficBudget(req.path, req.method, visitor);
    // Both budgets are separated by traffic class: exhausting background reads
    // or heartbeats must not block accepting, transferring or replying to chats.
    // Forwarded IP headers remain untrusted; retain a directly connected peer cap.
    const keys = [
      hashChatCredential(req.socket.remoteAddress ?? 'unknown'),
      hashChatCredential(identity),
    ];
    const limits = [budget.peer, budget.identity];
    for (let i = 0; i < keys.length; i++) {
      let count: unknown;
      try {
        count = await this.redis.eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
          1,
          `chat:limit:v2:${this.config.get('CHAT_ENVIRONMENT')}:${visitor ? 'visitor' : 'staff'}:${budget.name}:${i}:${keys[i]}`,
        );
      } catch {
        throw new ServiceUnavailableException('Live chat is temporarily unavailable');
      }
      if (!Number.isSafeInteger(Number(count)) || Number(count) < 1)
        throw new ServiceUnavailableException('Live chat is temporarily unavailable');
      if (Number(count) > limits[i]!)
        throw new HttpException('Please wait before trying again', 429);
    }
    return true;
  }
}
