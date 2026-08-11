import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { UsersService } from "./users.service";

@Roles("ADMIN")
@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post()
  create(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.users.create(body, user);
  }

  @Patch(":id")
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.users.update(id, body, user);
  }

  @Patch(":id/roles")
  updateRoles(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.users.updateRoles(id, body, user);
  }

  @Post(":id/activate")
  activate(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.users.activate(id, user);
  }

  @Post(":id/deactivate")
  deactivate(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.users.deactivate(id, user);
  }

  @Post(":id/reset-password")
  resetPassword(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.users.resetPassword(id, body, user);
  }

  @Post(":id/revoke-sessions")
  revokeSessions(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.users.revokeSessions(id, user);
  }

  @Delete(":id")
  remove(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.users.remove(id, user);
  }

  @Post(":id/restore")
  restore(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.users.restore(id, user);
  }
}
