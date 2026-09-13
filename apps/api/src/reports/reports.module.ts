import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ControlsModule } from '../controls/controls.module';
import { CostingModule } from '../costing/costing.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CashDrawerBalancingController } from './cash-drawer-balancing.controller';
import { CashPickupsController } from './cash-pickups.controller';
import { MorningDashboardController } from './morning-dashboard.controller';
import { OrderChangesController } from './order-changes.controller';
import { OwnerDashboardController } from './owner-dashboard.controller';
import { ReportsController } from './reports.controller';
import { StoreDashboardController } from './store-dashboard.controller';
import { TransfersByLocationController } from './transfers-by-location.controller';
import { WrittenSalesController } from './written-sales.controller';

@Module({
  imports: [AuthModule, TenancyModule, CostingModule, ControlsModule],
  controllers: [
    ReportsController,
    MorningDashboardController,
    OwnerDashboardController,
    CashDrawerBalancingController,
    WrittenSalesController,
    StoreDashboardController,
    CashPickupsController,
    OrderChangesController,
    TransfersByLocationController,
  ],
})
export class ReportsModule {}
