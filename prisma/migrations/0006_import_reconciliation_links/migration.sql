ALTER TABLE "production_entries" ADD COLUMN "import_batch_id" UUID;
ALTER TABLE "loss_entries" ADD COLUMN "import_batch_id" UUID;
ALTER TABLE "downtime_entries" ADD COLUMN "import_batch_id" UUID;

CREATE INDEX "production_entries_import_batch_id_idx" ON "production_entries"("import_batch_id");
CREATE INDEX "loss_entries_import_batch_id_idx" ON "loss_entries"("import_batch_id");
CREATE INDEX "downtime_entries_import_batch_id_idx" ON "downtime_entries"("import_batch_id");

ALTER TABLE "production_entries"
  ADD CONSTRAINT "production_entries_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loss_entries"
  ADD CONSTRAINT "loss_entries_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "downtime_entries"
  ADD CONSTRAINT "downtime_entries_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
