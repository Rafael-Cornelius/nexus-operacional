import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { DowntimeService } from "./downtime.service";

@Controller("downtime")
export class DowntimeController {
  constructor(private readonly downtime: DowntimeService) {}

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get()
  list(@Query() query: { weekId?: string; reasonId?: string }) {
    return this.downtime.list(query);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get("reasons")
  reasons() {
    return this.downtime.reasons();
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get("summary")
  summary(@Query("weekId") weekId?: string) {
    return this.downtime.summary(weekId);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get(":id")
  getById(@Param("id", ParseUUIDPipe) id: string) {
    return this.downtime.getById(id);
  }

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.downtime.create(body, user);
  }

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.downtime.update(id, body, user);
  }

  @Roles("ADMIN", "SUPERVISOR")
  @Delete(":id")
  softDelete(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.downtime.softDelete(id, body, user);
  }

  @Roles("ADMIN", "SUPERVISOR")
  @Post(":id/restore")
  restore(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.downtime.restore(id, body, user);
  }

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Post(":id/submit")
  submit(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.downtime.submit(id, body, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Post(":id/approve")
  approve(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.downtime.approve(id, body, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Post(":id/reject")
  reject(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.downtime.reject(id, body, user);
  }
}
