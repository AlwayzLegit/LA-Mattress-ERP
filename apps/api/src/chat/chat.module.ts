import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ROOT_DRIZZLE } from '../database/database.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ChatService } from './chat.service';
import { ChatHttpGuard } from './chat-http.guard';
import { ChatStaffController, ChatVisitorController } from './chat.controller';
import { ChatOpenApiController } from './chat-openapi';
@Module({
  imports: [TenancyModule],
  controllers: [ChatStaffController, ChatVisitorController, ChatOpenApiController],
  providers: [
    ChatHttpGuard,
    {
      provide: ChatService,
      inject: [ROOT_DRIZZLE, ConfigService],
      useFactory: (db: PostgresJsDatabase, config: ConfigService) =>
        new ChatService(
          db,
          config.get('CHAT_ENVIRONMENT') === 'production' ? 'production' : 'staging',
        ),
    },
  ],
})
export class ChatModule {}
