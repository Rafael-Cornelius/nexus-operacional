import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { ReconciliationController } from "./reconciliation.controller";
import { ReconciliationService } from "./reconciliation.service";

@Module({
  imports: [AuditModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService]
})
export class ReconciliationModule {}
