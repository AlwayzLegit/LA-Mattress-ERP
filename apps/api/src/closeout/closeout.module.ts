import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ControlsModule } from '../controls/controls.module';
import { OrdersModule } from '../orders/orders.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CloseOutReportController } from './close-out-report.controller';
import { CloseoutController } from './closeout.controller';
import { CloseoutService } from './closeout.service';

@Module({
  imports: [AuthModule, TenancyModule, AuditModule, ControlsModule, OrdersModule],
  controllers: [CloseoutController, CloseOutReportController],
  providers: [CloseoutService],
  exports: [CloseoutService],
})
export class CloseoutModule {}
