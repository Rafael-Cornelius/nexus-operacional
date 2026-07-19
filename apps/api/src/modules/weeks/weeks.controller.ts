import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { WeeksService } from "./weeks.service";

@Controller("weeks")
export class WeeksController {
  constructor(private readonly weeks: WeeksService) {}

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER")
  @Get()
  list() {
    return this.weeks.list();
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.weeks.create(body, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Patch(":id/review")
  review(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.weeks.review(id, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Patch(":id/close")
  close(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.weeks.close(id, user);
  }

  @Roles("ADMIN", "MANAGER")
  @Patch(":id/reopen")
  reopen(@Param("id") id: string, @Body() body: { reason?: string }, @CurrentUserData() user?: CurrentUser) {
    return this.weeks.reopen(id, body?.reason, user);
  }

  @Roles("ADMIN", "MANAGER")
  @Patch(":id/archive")
  archive(@Param("id") id: string, @CurrentUserData() user?: CurrentUser) {
    return this.weeks.archive(id, user);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get(":id/snapshot")
  snapshot(@Param("id") id: string) {
    return this.weeks.snapshot(id);
  }
}
