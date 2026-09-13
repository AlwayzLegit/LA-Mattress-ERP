import { Module } from '@nestjs/common';
import { CompetitionsModule } from '../competitions/competitions.module';
import { TicketFlagsService } from '../deliveries/ticket-flags.service';
import { AuditModule } from '../audit/audit.module';
import { MoneyModule } from '../money/money.module';
import { ReturnsModule } from '../returns/returns.module';
import { ControlsModule } from '../controls/controls.module';
import { CostingModule } from '../costing/costing.module';
import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TransfersModule } from '../transfers/transfers.module';
import { OrdersController } from './orders.controller';
import { PublicOrderController } from './public-order.controller';
import { OrderNotesController } from './order-notes.controller';
import { OrderActionsController } from './order-actions.controller';
import { ReservationsController } from './reservations.controller';
import { TasksController } from './tasks.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [
    AuthModule,
    TenancyModule,
    AuditModule,
    MoneyModule,
    ReturnsModule,
    ControlsModule,
    TransfersModule,
    CostingModule,
    CompetitionsModule,
  ],
  controllers: [
    OrdersController,
    PublicOrderController,
    OrderNotesController,
    OrderActionsController,
    ReservationsController,
    TasksController,
  ],
  providers: [OrdersService, TicketFlagsService],
  // Deliveries (Day 3) reserve, release, and reprice through the same
  // service rather than reimplementing the stock math.
  exports: [OrdersService],
})
export class OrdersModule {}
