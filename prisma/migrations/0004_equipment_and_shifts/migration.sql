CREATE TABLE "equipment" (
  "id" UUID NOT NULL,
  "production_line_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "equipment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "equipment_production_line_id_fkey"
    FOREIGN KEY ("production_line_id") REFERENCES "production_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "equipment_production_line_id_code_key" ON "equipment"("production_line_id", "code");
CREATE INDEX "equipment_active_deleted_at_idx" ON "equipment"("active", "deleted_at");

CREATE TABLE "shifts" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "starts_at" TIME(0) NOT NULL,
  "ends_at" TIME(0) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shifts_code_key" ON "shifts"("code");
CREATE INDEX "shifts_active_deleted_at_idx" ON "shifts"("active", "deleted_at");

ALTER TABLE "production_entries"
  ADD COLUMN "equipment_id" UUID,
  ADD COLUMN "shift_id" UUID;
ALTER TABLE "loss_entries"
  ADD COLUMN "equipment_id" UUID,
  ADD COLUMN "shift_id" UUID;
ALTER TABLE "downtime_entries"
  ADD COLUMN "equipment_id" UUID,
  ADD COLUMN "shift_id" UUID;
ALTER TABLE "productivity_entries"
  ADD COLUMN "equipment_id" UUID,
  ADD COLUMN "shift_id" UUID;
ALTER TABLE "dosage_checks"
  ADD COLUMN "equipment_id" UUID,
  ADD COLUMN "shift_id" UUID,
  ADD COLUMN "operator_id" UUID;

CREATE INDEX "production_entries_equipment_id_shift_id_idx" ON "production_entries"("equipment_id", "shift_id");
CREATE INDEX "loss_entries_equipment_id_shift_id_idx" ON "loss_entries"("equipment_id", "shift_id");
CREATE INDEX "downtime_entries_equipment_id_shift_id_idx" ON "downtime_entries"("equipment_id", "shift_id");
CREATE INDEX "productivity_entries_equipment_id_shift_id_idx" ON "productivity_entries"("equipment_id", "shift_id");
CREATE INDEX "dosage_checks_equipment_id_shift_id_idx" ON "dosage_checks"("equipment_id", "shift_id");

ALTER TABLE "production_entries"
  ADD CONSTRAINT "production_entries_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "production_entries_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loss_entries"
  ADD CONSTRAINT "loss_entries_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "loss_entries_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "downtime_entries"
  ADD CONSTRAINT "downtime_entries_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "downtime_entries_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "productivity_entries"
  ADD CONSTRAINT "productivity_entries_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "productivity_entries_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "dosage_checks"
  ADD CONSTRAINT "dosage_checks_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "dosage_checks_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
