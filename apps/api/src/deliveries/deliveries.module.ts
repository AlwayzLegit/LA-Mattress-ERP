import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ControlsModule } from '../controls/controls.module';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { DeliveriesController } from './deliveries.controller';
import { SchedulingController } from './scheduling.controller';
import { TicketFlagsService } from './ticket-flags.service';

@Module({
  imports: [AuthModule, TenancyModule, AuditModule, OrdersModule, ControlsModule],
  controllers: [DeliveriesController, SchedulingController],
  providers: [TicketFlagsService],
  exports: [TicketFlagsService],
})
export class DeliveriesModule {}
