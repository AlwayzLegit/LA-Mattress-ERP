import { timer, exhaustMap, map, takeUntil, catchError, of } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import {
  Sse,
  ServiceUnavailableException,
  ForbiddenException,
  NotFoundException,
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
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}
  @Get('options')
  @Header('Cache-Control', 'no-store')
  options(@Headers() headers: Record<string, string | undefined>) {
    return this.chat.visitorOptions(credentials(headers));
  }
  @Post('conversations/:id/context')
  context(
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.visitorContext(credentials(headers), id, body);
  }
  @Post('conversations/:id/rating')
  rating(
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.rating(credentials(headers), id, body);
  }
  @Post('session')
  @Header('Cache-Control', 'no-store')
  session(@Headers() headers: Record<string, string | undefined>) {
    return this.chat.createSession(credentials(headers));
  }
  @Post('conversations/:id/followup')
  followup(
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.visitorFollowup(credentials(headers), id, body);
  }
  @Post('conversations/:id/end')
  end(@Headers() headers: Record<string, string | undefined>, @Param('id') id: string) {
    return this.chat.endVisitorChat(credentials(headers), id);
  }
  @Post('conversations/:id/activity')
  activity(
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.activity(null, credentials(headers), id, body);
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
  @Sse('conversations/:id/live')
  @Header('Cache-Control', 'no-store')
  @Header('X-Accel-Buffering', 'no')
  live(
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const auth = credentials(headers);
    let cursor = query;
    return timer(0, 1000).pipe(
      exhaustMap(async () => {
        if (this.config.get('CHAT_ENABLED') !== 'true')
          throw new ServiceUnavailableException('Chat unavailable');
        const page = await this.chat.visitorHistory(auth, id, cursor);
        cursor = { afterSequence: page.nextSequence, limit: 100 };
        return page;
      }),
      map((page) => ({ type: 'messages', data: page })),
      takeUntil(timer(25000)),
      catchError((error: unknown) =>
        of({
          type:
            error instanceof UnauthorizedException || error instanceof NotFoundException
              ? 'session-expired'
              : 'unavailable',
          data: {},
        }),
      ),
    );
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
  @Get('customer-candidates')
  @RequirePermission('chat.manage', 'customers.view')
  candidates(@CurrentTenant() tenant: RequestTenantContext, @Query() query: unknown) {
    return this.chat.customerCandidates(tenant, query);
  }
  @Get('settings')
  @RequirePermission('chat.manage')
  settings(@CurrentTenant() tenant: RequestTenantContext) {
    return this.chat.settings(tenant);
  }
  @Post('settings')
  @RequirePermission('chat.manage')
  saveSettings(@CurrentTenant() tenant: RequestTenantContext, @Body() body: unknown) {
    return this.chat.settings(tenant, body);
  }
  @Get('report')
  @RequirePermission('chat.manage')
  report(@CurrentTenant() tenant: RequestTenantContext) {
    return this.chat.report(tenant);
  }
  @Get('retention')
  @RequirePermission('chat.manage')
  retention(@CurrentTenant() tenant: RequestTenantContext) {
    return this.chat.retention(tenant);
  }
  @Post('retention')
  @RequirePermission('chat.manage')
  purge(@CurrentTenant() tenant: RequestTenantContext, @Body() body: unknown) {
    return this.chat.retention(tenant, body);
  }
  @Get(':id/context')
  @Header('Cache-Control', 'no-store')
  context(@CurrentTenant() tenant: RequestTenantContext, @Param('id') id: string) {
    return this.chat.context(tenant, id);
  }
  @Post(':id/transfer')
  @RequirePermission('chat.assign')
  transfer(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.transfer(tenant, id, body);
  }
  @Post(':id/accept')
  @RequirePermission('chat.reply')
  accept(@CurrentTenant() tenant: RequestTenantContext, @Param('id') id: string) {
    return this.chat.acceptAssignment(tenant, id);
  }
  @Post(':id/customer')
  @RequirePermission('chat.manage', 'customers.view')
  link(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.linkCustomer(tenant, id, body);
  }
  @Sse('live')
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
  @Header('Cache-Control', 'no-store')
  list(@CurrentTenant() tenant: RequestTenantContext, @Query() query: unknown) {
    return this.chat.staffConversations(tenant, query);
  }
  @Get(':id/followup')
  @Header('Cache-Control', 'no-store')
  followup(@CurrentTenant() tenant: RequestTenantContext, @Param('id') id: string) {
    return this.chat.followup(tenant, id);
  }
  @Post(':id/followup-complete')
  @RequirePermission('chat.reply')
  completeFollowup(@CurrentTenant() tenant: RequestTenantContext, @Param('id') id: string) {
    return this.chat.followup(tenant, id, true);
  }
  @Get(':id/history')
  @Header('Cache-Control', 'no-store')
  history(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    return this.chat.staffHistory(tenant, id, query);
  }
  @Get('availability')
  @RequirePermission('chat.reply')
  availability(@CurrentTenant() tenant: RequestTenantContext) {
    return this.chat.availability(tenant);
  }
  @Post('availability')
  @RequirePermission('chat.reply')
  setAvailability(@CurrentTenant() tenant: RequestTenantContext, @Body() body: unknown) {
    return this.chat.availability(tenant, body);
  }
  @Get('operations')
  @RequirePermission('chat.manage')
  operations(@CurrentTenant() tenant: RequestTenantContext) {
    return this.chat.operations(tenant);
  }
  @Post('retry-failed')
  @RequirePermission('chat.manage')
  retry(@CurrentTenant() tenant: RequestTenantContext) {
    return this.chat.retryFailed(tenant);
  }
  @Get('push-key')
  pushKey(@CurrentTenant() tenant: RequestTenantContext) {
    if (!tenant.permissions.has('chat.view_team') && !tenant.permissions.has('chat.view_assigned'))
      throw new ForbiddenException('Chat permission required');
    const publicKey = this.config.get<string>('CHAT_VAPID_PUBLIC_KEY');
    if (!publicKey || this.config.get('CHAT_PUSH_ENABLED') !== 'true')
      throw new ServiceUnavailableException('Background push is not configured');
    return { publicKey };
  }
  @Post('push-subscribe')
  subscribe(@CurrentTenant() tenant: RequestTenantContext, @Body() body: unknown) {
    this.pushKey(tenant);
    return this.chat.subscribePush(tenant, body);
  }
  @Post('push-unsubscribe')
  unsubscribe(@CurrentTenant() tenant: RequestTenantContext, @Body() body: unknown) {
    return this.chat.unsubscribePush(tenant, body);
  }
  @Post(':id/activity')
  @RequirePermission('chat.reply')
  activity(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.activity(tenant, null, id, body);
  }
  @Post(':id/workflow')
  @RequirePermission('chat.assign')
  workflow(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.workflow(tenant, id, body);
  }
  @Post(':id/export')
  @RequirePermission('chat.export')
  export(@CurrentTenant() tenant: RequestTenantContext, @Param('id') id: string) {
    return this.chat.exportTranscript(tenant, id);
  }
  @Post(':id/messages')
  @RequirePermission('chat.reply')
  @Header('Cache-Control', 'no-store')
  reply(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.sendStaffMessage(tenant, id, body);
  }
  @Post(':id/notes')
  @RequirePermission('chat.reply')
  @Header('Cache-Control', 'no-store')
  note(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.sendStaffMessage(tenant, id, body, 'note');
  }
}
