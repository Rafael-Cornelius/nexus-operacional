import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { EquipmentService } from "./equipment.service";

@Controller("equipment")
export class EquipmentController {
  constructor(private readonly equipment: EquipmentService) {}

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get()
  list(@Query() query: { active?: string; productionLineId?: string; search?: string }) {
    return this.equipment.list(query);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.equipment.create(body, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.equipment.update(id, body, user);
  }

  @Roles("ADMIN")
  @Delete(":id")
  deactivate(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.equipment.deactivate(id, user);
  }
}
