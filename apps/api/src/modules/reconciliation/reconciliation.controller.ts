import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ReconciliationService } from "./reconciliation.service";

@Roles("ADMIN", "MANAGER", "SUPERVISOR")
@Controller("import")
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get(":batchId/reconciliation")
  report(@Param("batchId") batchId: string, @CurrentUserData() user?: CurrentUser) {
    return this.reconciliation.report(batchId, user);
  }

  @Post(":batchId/reconciliation/certify")
  @Roles("ADMIN")
  certify(
    @Param("batchId") batchId: string,
    @Body() body: { reason?: string },
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.reconciliation.certify(batchId, body.reason, user);
  }
}
