import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DashboardModule } from "../dashboard/dashboard.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [AuditModule, DashboardModule],
  controllers: [ReportsController],
  providers: [ReportsService]
})
export class ReportsModule {}
