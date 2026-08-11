import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { GoalsService } from "./goals.service";

@Controller("goals")
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get()
  list(@Query() query: { weekId?: string; status?: string; metric?: string; seriesId?: string }) {
    return this.goals.list(query);
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR")
  @Get("references")
  references() {
    return this.goals.references();
  }

  @Roles("ADMIN", "MANAGER", "SUPERVISOR", "VIEWER")
  @Get("series/:seriesId")
  history(@Param("seriesId", ParseUUIDPipe) seriesId: string) {
    return this.goals.history(seriesId);
  }

  @Roles("ADMIN", "MANAGER")
  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.goals.create(body, user);
  }

  @Roles("ADMIN", "MANAGER")
  @Post(":id/versions")
  createVersion(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.goals.createVersion(id, body, user);
  }

  @Roles("ADMIN", "MANAGER")
  @Post(":id/approve")
  approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.goals.approve(id, body, user);
  }

  @Roles("ADMIN", "MANAGER")
  @Post(":id/retire")
  retire(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.goals.retire(id, body, user);
  }
}
