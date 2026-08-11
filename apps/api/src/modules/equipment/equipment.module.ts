import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EquipmentController } from "./equipment.controller";
import { EquipmentService } from "./equipment.service";

@Module({
  imports: [AuditModule],
  controllers: [EquipmentController],
  providers: [EquipmentService],
  exports: [EquipmentService]
})
export class EquipmentModule {}
