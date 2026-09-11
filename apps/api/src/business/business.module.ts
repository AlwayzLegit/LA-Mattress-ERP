import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { InvitationService } from './invitation.service';
import { LocationsController } from './locations.controller';
import { MembersController } from './members.controller';
import { PermissionsCatalogController, RolesController } from './roles.controller';
import { SessionsAdminController } from './sessions-admin.controller';
import { SettingsController } from './settings.controller';
import { TaxClassesController } from './tax-classes.controller';

// @Global so the AdminModule (and any other module that needs to issue
// invitations) can inject InvitationService without re-importing.
@Global()
@Module({
  imports: [AuthModule, TenancyModule, AuditModule, EmailModule],
  providers: [InvitationService],
  controllers: [
    SettingsController,
    LocationsController,
    MembersController,
    RolesController,
    PermissionsCatalogController,
    TaxClassesController,
    SessionsAdminController,
  ],
  exports: [InvitationService],
})
export class BusinessModule {}
