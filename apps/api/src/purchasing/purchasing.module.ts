import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ControlsModule } from '../controls/controls.module';
import { CostingModule } from '../costing/costing.module';
import { EmailModule } from '../email/email.module';
import { OrdersModule } from '../orders/orders.module';
import { SpecialOrdersModule } from '../special-orders/special-orders.module';
import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { ReplenishController } from './replenish.controller';
import { ReplenishmentController, ReplenishmentRunService } from './replenishment.controller';
import { VendorInvoicesController } from './vendor-invoices.controller';
import { VendorsController } from './vendors.controller';

@Module({
  imports: [
    AuthModule,
    TenancyModule,
    AuditModule,
    OrdersModule,
    SpecialOrdersModule,
    EmailModule,
    ControlsModule,
    CostingModule,
  ],
  controllers: [
    VendorsController,
    PurchaseOrdersController,
    VendorInvoicesController,
    ReplenishmentController,
    ReplenishController,
  ],
  providers: [ReplenishmentRunService],
  exports: [ReplenishmentRunService],
})
export class PurchasingModule {}
