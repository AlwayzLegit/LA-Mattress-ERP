import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ROOT_DRIZZLE } from '../database/database.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ChatService } from './chat.service';
import { ChatHttpGuard } from './chat-http.guard';
import { ChatStaffController, ChatVisitorController } from './chat.controller';
import { ChatOpenApiController } from './chat-openapi';
import { ChatBackground, createChatBackground } from './chat-background';
@Module({
  imports: [TenancyModule],
  controllers: [ChatStaffController, ChatVisitorController, ChatOpenApiController],
  providers: [
    ChatHttpGuard,
    {
      provide: ChatBackground,
      inject: [ROOT_DRIZZLE, ChatService],
      useFactory: (db: PostgresJsDatabase, chat: ChatService) =>
        createChatBackground(db, chat, process.env),
    },
    {
      provide: ChatService,
      inject: [ROOT_DRIZZLE, ConfigService, REDIS],
      useFactory: (db: PostgresJsDatabase, config: ConfigService, redis: Redis | null) =>
        new ChatService(
          db,
          config.get('CHAT_ENVIRONMENT') === 'production' ? 'production' : 'staging',
          redis,
        ),
    },
  ],
})
export class ChatModule {}
