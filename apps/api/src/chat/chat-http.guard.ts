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
    const req = context.switchToHttp().getRequest<Request>();
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
    // Forwarded IP headers are untrusted. The directly connected peer and
    // credential/session get separate shared budgets.
    const keys = [
      hashChatCredential(req.socket.remoteAddress ?? 'unknown'),
      hashChatCredential(
        `${req.headers['x-chat-integration-id'] ?? 'staff'}:${req.headers['x-chat-session'] ?? req.headers.cookie ?? 'new'}`,
      ),
    ];
    const limits = [600, req.path.endsWith('/session') ? 20 : 120];
    for (let i = 0; i < keys.length; i++) {
      let count: unknown;
      try {
        count = await this.redis.eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
          1,
          `chat:limit:${i}:${keys[i]}`,
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
