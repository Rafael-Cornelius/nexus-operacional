import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { MasterDataController } from "./master-data.controller";
import { MasterDataService } from "./master-data.service";

@Module({
  imports: [AuditModule],
  controllers: [MasterDataController],
  providers: [MasterDataService],
  exports: [MasterDataService]
})
export class MasterDataModule {}
