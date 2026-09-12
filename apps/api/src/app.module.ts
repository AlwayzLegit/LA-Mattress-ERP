import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { TerminusModule } from '@nestjs/terminus';
import { AdminModule } from './admin/admin.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AppController } from './app.controller';
import { AuditModule } from './audit/audit.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BusinessModule } from './business/business.module';
import { CashModule } from './cash/cash.module';
import { CatalogModule } from './catalog/catalog.module';
import { CustomersModule } from './customers/customers.module';
import { DatabaseModule } from './database/database.module';
import { DiscountsModule } from './discounts/discounts.module';
import { EmailModule } from './email/email.module';
import { GiftCardsModule } from './gift-cards/gift-cards.module';
import { HealthController } from './health/health.controller';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { InventoryModule } from './inventory/inventory.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OpenApiModule } from './openapi/openapi.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { OrdersModule } from './orders/orders.module';
import { CrmModule } from './crm/crm.module';
import { ImportModule } from './import/import.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { MarketingModule } from './marketing/marketing.module';
import { MoneyModule } from './money/money.module';
import { ServiceOrdersModule } from './service-orders/service-orders.module';
import { SpecialOrdersModule } from './special-orders/special-orders.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { RedisModule } from './redis/redis.module';
import { ReportsModule } from './reports/reports.module';
import { ScheduleModule } from './schedule/schedule.module';
import { ReportBuilderModule } from './report-builder/report-builder.module';
import { SalesModule } from './sales/sales.module';
import { StripeModule } from './stripe/stripe.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { ExchangesModule } from './exchanges/exchanges.module';
import { ReturnsModule } from './returns/returns.module';
import { ControlsModule } from './controls/controls.module';
import { OpsModule } from './ops/ops.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { GeoModule } from './geo/geo.module';
import { CashierModule } from './cashier/cashier.module';
import { CloseoutModule } from './closeout/closeout.module';
import { CompetitionsModule } from './competitions/competitions.module';
import { JobsModule } from './jobs/jobs.module';
import { GlModule } from './gl/gl.module';
import { TransfersModule } from './transfers/transfers.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        genReqId: (req, res) => {
          const incoming = req.headers['x-request-id'];
          const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        customProps: (req) => ({ requestId: req.id }),
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'req.body.password',
            'req.body.token',
          ],
          censor: '[redacted]',
        },
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
              },
      },
    }),
    TerminusModule,
    DatabaseModule,
    RedisModule,
    EmailModule,
    AuditModule,
    AuthModule,
    TenancyModule,
    IdempotencyModule,
    BusinessModule,
    CatalogModule,
    CustomersModule,
    DiscountsModule,
    GiftCardsModule,
    InventoryModule,
    PurchasingModule,
    TransfersModule,
    GlModule,
    ReturnsModule,
    ExchangesModule,
    ControlsModule,
    OpsModule,
    WarehouseModule,
    GeoModule,
    CashierModule,
    CloseoutModule,
    CompetitionsModule,
    JobsModule,
    SalesModule,
    OrdersModule,
    DeliveriesModule,
    SpecialOrdersModule,
    MoneyModule,
    ServiceOrdersModule,
    CrmModule,
    ImportModule,
    IntegrationsModule,
    MarketingModule,
    CashModule,
    ReportsModule,
    ScheduleModule,
    ReportBuilderModule,
    BillingModule,
    StripeModule,
    WebhooksModule,
    ApiKeysModule,
    OpenApiModule,
    OnboardingModule,
    AdminModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    // AuthGuard is global so every endpoint is authenticated by default;
    // anonymous routes opt out via @Public(). TenancyGuard, PermissionGuard,
    // and RlsContextInterceptor are NOT global — they're applied per-route
    // via @TenantScoped() so user-scoped routes (sessions list, active-
    // business picker) don't 412 when the user hasn't selected a business
    // yet.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
