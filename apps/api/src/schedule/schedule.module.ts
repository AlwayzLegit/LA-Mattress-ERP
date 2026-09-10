import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ScheduleController } from './schedule.controller';
import { TimeClockController } from './timeclock.controller';

@Module({
  imports: [AuthModule, TenancyModule, AuditModule],
  controllers: [ScheduleController, TimeClockController],
})
export class ScheduleModule {}
