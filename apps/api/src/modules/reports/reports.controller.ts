import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ReportsService } from "./reports.service";

@Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("weekly-production")
  weeklyProduction(@Query("weekId") weekId: string | undefined, @CurrentUserData() user?: CurrentUser) {
    return this.reports.weeklyProduction(weekId, user);
  }

  @Get("weekly-summary")
  weeklySummary(@Query("weekId") weekId: string | undefined, @CurrentUserData() user?: CurrentUser) {
    return this.reports.weeklySummary(weekId, user);
  }
}
