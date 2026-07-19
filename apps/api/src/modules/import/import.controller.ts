import { Body, Controller, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { importUploadLimitBytes } from "./import-security.config";
import { ImportStagingService, StagingReviewAction } from "./import-staging.service";
import { ImportService, UploadedWorkbookFile } from "./import.service";

@Roles("ADMIN", "MANAGER", "SUPERVISOR")
@Controller("import")
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly staging: ImportStagingService
  ) {}

  @Get("preview")
  preview(@Query("batchId") batchId?: string) {
    return this.imports.preview(batchId);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: importUploadLimitBytes } }))
  upload(@UploadedFile() file: UploadedWorkbookFile | undefined, @CurrentUserData() user?: CurrentUser) {
    return this.imports.uploadWorkbook(file, user);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("products")
  importProducts(@Body() body: { batchId?: string }, @CurrentUserData() user?: CurrentUser) {
    return this.imports.importProducts(body.batchId, user);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post("operational-data")
  @Roles("ADMIN", "MANAGER")
  importOperationalData(@Body() body: { batchId?: string }, @CurrentUserData() user?: CurrentUser) {
    return this.imports.importOperationalData(body.batchId, user);
  }

  @Get(":batchId/staging")
  listStaging(
    @Param("batchId") batchId: string,
    @Query() query: { domain?: string; classification?: string; decision?: string; take?: string; skip?: string }
  ) {
    return this.staging.list(batchId, query);
  }

  @Get(":batchId/staging/summary")
  stagingSummary(@Param("batchId") batchId: string) {
    return this.staging.summary(batchId);
  }

  @Patch(":batchId/staging/:recordId")
  correctStaging(
    @Param("batchId") batchId: string,
    @Param("recordId") recordId: string,
    @Body() body: { value?: unknown; reason?: string; version?: number },
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.staging.correct(batchId, recordId, body, user);
  }

  @Post(":batchId/staging/:recordId/review")
  reviewStaging(
    @Param("batchId") batchId: string,
    @Param("recordId") recordId: string,
    @Body() body: { action?: StagingReviewAction; reason?: string; version?: number },
    @CurrentUserData() user?: CurrentUser
  ) {
    return this.staging.review(batchId, recordId, body, user);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post(":batchId/promote")
  @Roles("ADMIN", "MANAGER")
  promote(@Param("batchId") batchId: string, @CurrentUserData() user?: CurrentUser) {
    return this.imports.promote(batchId, user);
  }
}
