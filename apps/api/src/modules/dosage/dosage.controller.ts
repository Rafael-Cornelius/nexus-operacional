import { Body, Controller, Get, Post, Query } from "@nestjs/common";
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

  @Roles("ADMIN", "SUPERVISOR", "OPERATOR")
  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.dosage.create(body, user);
  }
}
