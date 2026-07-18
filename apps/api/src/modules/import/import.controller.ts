import { Body, Controller, Get, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { CurrentUserData } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import { ImportService, UploadedWorkbookFile } from "./import.service";

const importUploadLimitBytes = Number(process.env.IMPORT_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);

@Roles("ADMIN", "SUPERVISOR")
@Controller("import")
export class ImportController {
  constructor(private readonly imports: ImportService) {}

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
  importOperationalData(@Body() body: { batchId?: string }, @CurrentUserData() user?: CurrentUser) {
    return this.imports.importOperationalData(body.batchId, user);
  }
}
