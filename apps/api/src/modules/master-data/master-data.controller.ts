import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { MasterDataService } from "./master-data.service";

const readRoles = ["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER"] as const;

@Controller("reference-data")
export class MasterDataController {
  constructor(private readonly masterData: MasterDataService) {}

  @Roles(...readRoles)
  @Get()
  overview() {
    return this.masterData.overview();
  }

  @Roles(...readRoles)
  @Get("sectors")
  sectors() {
    return this.masterData.sectors();
  }

  @Roles("ADMIN")
  @Post("sectors")
  createSector(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.createSector(body, user);
  }

  @Roles("ADMIN")
  @Patch("sectors/:id")
  updateSector(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.updateSector(id, body, user);
  }

  @Roles("ADMIN")
  @Delete("sectors/:id")
  deleteSector(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.deleteSector(id, user);
  }

  @Roles(...readRoles)
  @Get("lines")
  lines(@Query() query: { sectorId?: string; active?: string; deleted?: string }) {
    return this.masterData.lines(query);
  }

  @Roles("ADMIN")
  @Post("lines")
  createLine(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.createLine(body, user);
  }

  @Roles("ADMIN")
  @Patch("lines/:id")
  updateLine(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.updateLine(id, body, user);
  }

  @Roles("ADMIN")
  @Delete("lines/:id")
  deactivateLine(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.deactivateLine(id, user);
  }

  @Roles("ADMIN")
  @Post("lines/:id/restore")
  restoreLine(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.restoreLine(id, user);
  }

  @Roles(...readRoles)
  @Get("loss-types")
  lossTypes(@Query("active") active?: string) {
    return this.masterData.lossTypes(active);
  }

  @Roles("ADMIN")
  @Post("loss-types")
  createLossType(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.createLossType(body, user);
  }

  @Roles("ADMIN")
  @Patch("loss-types/:id")
  updateLossType(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.updateLossType(id, body, user);
  }

  @Roles("ADMIN")
  @Delete("loss-types/:id")
  deactivateLossType(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.deactivateLossType(id, user);
  }

  @Roles("ADMIN")
  @Post("loss-types/:id/restore")
  restoreLossType(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.restoreLossType(id, user);
  }

  @Roles(...readRoles)
  @Get("downtime-reasons")
  downtimeReasons(@Query("active") active?: string) {
    return this.masterData.downtimeReasons(active);
  }

  @Roles("ADMIN")
  @Post("downtime-reasons")
  createDowntimeReason(@Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.createDowntimeReason(body, user);
  }

  @Roles("ADMIN")
  @Patch("downtime-reasons/:id")
  updateDowntimeReason(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.updateDowntimeReason(id, body, user);
  }

  @Roles("ADMIN")
  @Delete("downtime-reasons/:id")
  deactivateDowntimeReason(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.deactivateDowntimeReason(id, user);
  }

  @Roles("ADMIN")
  @Post("downtime-reasons/:id/restore")
  restoreDowntimeReason(@Param("id", ParseUUIDPipe) id: string, @CurrentUserData() user?: CurrentUser) {
    return this.masterData.restoreDowntimeReason(id, user);
  }
}
