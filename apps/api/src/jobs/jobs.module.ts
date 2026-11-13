import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ControlsModule } from '../controls/controls.module';
import { GlModule } from '../gl/gl.module';
import { OrdersModule } from '../orders/orders.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [AuthModule, TenancyModule, AuditModule, ControlsModule, GlModule, OrdersModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
