import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { BackupsController } from "./backups.controller";
import { BackupScheduler } from "./backups.scheduler";
import { BackupsService } from "./backups.service";

@Module({
  imports: [AuditModule],
  controllers: [BackupsController],
  providers: [BackupsService, BackupScheduler]
})
export class BackupsModule {}
