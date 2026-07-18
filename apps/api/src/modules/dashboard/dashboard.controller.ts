import { Controller, Get, Query } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { Roles } from "../auth/roles.decorator";
import { DashboardService } from "./dashboard.service";

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Public()
  @Get("health")
  health() {
    return this.dashboard.health();
  }

  @Roles("ADMIN")
  @Get("health/db")
  dbHealth() {
    return this.dashboard.dbHealth();
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get("dashboard/kpis")
  kpis(@Query("weekId") weekId?: string) {
    return this.dashboard.kpis(weekId);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get("dashboard/charts")
  charts(@Query("weekId") weekId?: string) {
    return this.dashboard.charts(weekId);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get("dashboard/comparison")
  comparison(@Query("weekId") weekId?: string) {
    return this.dashboard.comparison(weekId);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get("dashboard/alerts")
  alerts(@Query("weekId") weekId?: string) {
    return this.dashboard.alerts(weekId);
  }
}
