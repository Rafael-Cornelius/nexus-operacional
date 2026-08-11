import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CalculationRulesController } from "./calculation-rules.controller";
import { CalculationRulesService } from "./calculation-rules.service";

@Module({
  imports: [AuditModule],
  controllers: [CalculationRulesController],
  providers: [CalculationRulesService],
  exports: [CalculationRulesService]
})
export class CalculationRulesModule {}
