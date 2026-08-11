import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DosageController } from "./dosage.controller";
import { DosageService } from "./dosage.service";

@Module({
  imports: [AuditModule],
  controllers: [DosageController],
  providers: [DosageService]
})
export class DosageModule {}
