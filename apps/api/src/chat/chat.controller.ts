import { timer, exhaustMap, map, takeUntil, catchError, of } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import {
  Sse,
  ServiceUnavailableException,
  ForbiddenException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
  UseFilters,
  Header,
  UnauthorizedException,
} from '@nestjs/common';
import { ChatExceptionFilter } from './chat-exception.filter';
import { Public, RequirePermission } from '../tenancy/decorators';
import { TenancyGuard } from '../tenancy/tenancy.guard';
import { PermissionGuard } from '../tenancy/permission.guard';
import { SubscriptionGuard } from '../billing/subscription.guard';
import { CurrentTenant } from '../auth/current-user.decorator';
import type { RequestTenantContext } from '../tenancy/request-context';
import { ChatService, type ChatVisitorAuth } from './chat.service';
import { ChatHttpGuard } from './chat-http.guard';
function credentials(headers: Record<string, string | string[] | undefined>): ChatVisitorAuth {
  const authorization = headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
    throw new UnauthorizedException('Chat integration required');
  return {
    integrationId: String(headers['x-chat-integration-id'] ?? ''),
    credential: authorization.slice(7),
    sessionCredential: String(headers['x-chat-session'] ?? ''),
  };
}
@Public()
@UseFilters(ChatExceptionFilter)
@UseGuards(ChatHttpGuard)
@Controller('v1/chat/visitor')
export class ChatVisitorController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}
  @Post('session')
  @Header('Cache-Control', 'no-store')
  session(@Headers() headers: Record<string, string | undefined>) {
    return this.chat.createSession(credentials(headers));
  }
  @Post('conversations')
  @Header('Cache-Control', 'no-store')
  start(@Headers() headers: Record<string, string | undefined>, @Body() body: unknown) {
    return this.chat.startFromHttp(credentials(headers), body);
  }
  @Post('conversations/:id/messages')
  @Header('Cache-Control', 'no-store')
  send(
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.sendVisitorMessage(credentials(headers), id, body);
  }
  @Get('conversations/:id/history')
  @Header('Cache-Control', 'no-store')
  history(
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    return this.chat.visitorHistory(credentials(headers), id, query);
  }
}
// Service owns RLS transactions and metadata-only audits. No generic body audit.
@UseGuards(TenancyGuard, SubscriptionGuard, PermissionGuard, ChatHttpGuard)
@UseFilters(ChatExceptionFilter)
@Controller('v1/chat/conversations')
export class ChatStaffController {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}
  @Sse('live')
  @RequirePermission('chat.view_team')
  @Header('Cache-Control', 'no-store')
  @Header('X-Accel-Buffering', 'no')
  live(@CurrentTenant() tenant: RequestTenantContext) {
    // Bound connections so cookie/session/subscription guards are rerun on reconnect.
    return timer(0, 1000).pipe(
      exhaustMap(async () => {
        if (this.config.get('CHAT_ENABLED') !== 'true')
          throw new ServiceUnavailableException('Chat unavailable');
        return this.chat.staffLiveSnapshot(tenant);
      }),
      map((conversations) => ({ type: 'snapshot', data: { conversations } })),
      takeUntil(timer(30000)),
      catchError((error: unknown) =>
        of({
          type:
            error instanceof ForbiddenException || error instanceof UnauthorizedException
              ? 'access-revoked'
              : 'unavailable',
          data: {},
        }),
      ),
    );
  }
  @Get()
  @RequirePermission('chat.view_team')
  @Header('Cache-Control', 'no-store')
  list(@CurrentTenant() tenant: RequestTenantContext, @Query() query: unknown) {
    return this.chat.staffConversations(tenant, query);
  }
  @Get(':id/history')
  @RequirePermission('chat.view_team')
  @Header('Cache-Control', 'no-store')
  history(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    return this.chat.staffHistory(tenant, id, query);
  }
  @Post(':id/messages')
  @RequirePermission('chat.view_team', 'chat.reply')
  @Header('Cache-Control', 'no-store')
  reply(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.sendStaffMessage(tenant, id, body);
  }
  @Post(':id/notes')
  @RequirePermission('chat.view_team', 'chat.reply')
  @Header('Cache-Control', 'no-store')
  note(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.sendStaffMessage(tenant, id, body, 'note');
  }
}
