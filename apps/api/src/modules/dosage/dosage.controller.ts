import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { DosageService } from "./dosage.service";

@Controller("dosage")
export class DosageController {
  constructor(private readonly dosage: DosageService) {}

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get()
  list(@Query("weekId") weekId?: string, @Query("productId") productId?: string) {
    return this.dosage.list(weekId, productId);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get(":id")
  getById(@Param("id", ParseUUIDPipe) id: string) {
    return this.dosage.getById(id);
  }

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.dosage.create(body, user);
  }

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.dosage.update(id, body, user);
  }

  @Roles("ADMIN", "SUPERVISOR")
  @Delete(":id")
  softDelete(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.dosage.softDelete(id, body, user);
  }

  @Roles("ADMIN", "SUPERVISOR")
  @Post(":id/restore")
  restore(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.dosage.restore(id, body, user);
  }

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Post(":id/submit")
  submit(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.dosage.submit(id, body, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Post(":id/approve")
  approve(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.dosage.approve(id, body, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Post(":id/reject")
  reject(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.dosage.reject(id, body, user);
  }
}
