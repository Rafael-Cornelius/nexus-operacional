import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { ProductivityController } from "./productivity.controller";
import { ProductivityService } from "./productivity.service";

@Module({
  imports: [AuditModule],
  controllers: [ProductivityController],
  providers: [ProductivityService]
})
export class ProductivityModule {}
