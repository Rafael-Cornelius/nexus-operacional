import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ProductivityService } from "./productivity.service";

@Controller("productivity")
export class ProductivityController {
  constructor(private readonly productivity: ProductivityService) {}

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get()
  list(@Query("weekId") weekId?: string) {
    return this.productivity.list(weekId);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get("summary")
  summary(@Query("weekId") weekId?: string) {
    return this.productivity.summary(weekId);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get(":id")
  getById(@Param("id", ParseUUIDPipe) id: string) {
    return this.productivity.getById(id);
  }

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.productivity.create(body, user);
  }

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.productivity.update(id, body, user);
  }

  @Roles("ADMIN", "SUPERVISOR")
  @Delete(":id")
  softDelete(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.productivity.softDelete(id, body, user);
  }

  @Roles("ADMIN", "SUPERVISOR")
  @Post(":id/restore")
  restore(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.productivity.restore(id, body, user);
  }

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Post(":id/submit")
  submit(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.productivity.submit(id, body, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Post(":id/approve")
  approve(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.productivity.approve(id, body, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Post(":id/reject")
  reject(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.productivity.reject(id, body, user);
  }
}
