import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { ImportStagingService } from "./import-staging.service";
import { ImportPromotionService } from "./import-promotion.service";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";

@Module({
  imports: [AuditModule],
  controllers: [ImportController],
  providers: [ImportService, ImportStagingService, ImportPromotionService]
})
export class ImportModule {}
