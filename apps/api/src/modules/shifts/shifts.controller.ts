import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ShiftsService } from "./shifts.service";

@Controller("shifts")
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get()
  list(@Query("active") active?: string) {
    return this.shifts.list(active);
  }

  @Roles("ADMIN", "MANAGER")
  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.shifts.create(body, user);
  }

  @Roles("ADMIN", "MANAGER")
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.shifts.update(id, body, user);
  }

  @Roles("ADMIN")
  @Delete(":id")
  deactivate(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.shifts.deactivate(id, user);
  }
}
