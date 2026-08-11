BEGIN;

-- NOT VALID preserves upgrades that contain historical orphan actor UUIDs.
-- PostgreSQL still enforces every constraint for new INSERT/UPDATE/DELETE writes.
ALTER TABLE "production_entries"
  ADD CONSTRAINT "production_entries_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "production_entries_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "production_entries_rejected_by_fkey"
    FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "production_entries_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "production_entries_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "loss_entries"
  ADD CONSTRAINT "loss_entries_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "loss_entries_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "loss_entries_rejected_by_fkey"
    FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "loss_entries_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "loss_entries_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "downtime_entries"
  ADD CONSTRAINT "downtime_entries_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "downtime_entries_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "downtime_entries_rejected_by_fkey"
    FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "downtime_entries_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "downtime_entries_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "dosage_checks"
  ADD CONSTRAINT "dosage_checks_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "dosage_checks_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "dosage_checks_rejected_by_fkey"
    FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "dosage_checks_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "dosage_checks_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "productivity_entries"
  ADD CONSTRAINT "productivity_entries_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "productivity_entries_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "productivity_entries_rejected_by_fkey"
    FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "productivity_entries_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "productivity_entries_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- Validate all actor constraints for one table only when that table has no
-- historical orphan. Tables with legacy orphans keep NOT VALID constraints,
-- while all future writes remain protected.
DO $validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "production_entries" AS entry
    WHERE (entry."submitted_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."submitted_by"))
       OR (entry."approved_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."approved_by"))
       OR (entry."rejected_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."rejected_by"))
       OR (entry."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."created_by"))
       OR (entry."updated_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."updated_by"))
  ) THEN
    ALTER TABLE "production_entries" VALIDATE CONSTRAINT "production_entries_submitted_by_fkey";
    ALTER TABLE "production_entries" VALIDATE CONSTRAINT "production_entries_approved_by_fkey";
    ALTER TABLE "production_entries" VALIDATE CONSTRAINT "production_entries_rejected_by_fkey";
    ALTER TABLE "production_entries" VALIDATE CONSTRAINT "production_entries_created_by_fkey";
    ALTER TABLE "production_entries" VALIDATE CONSTRAINT "production_entries_updated_by_fkey";
  END IF;
END
$validation$;

DO $validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "loss_entries" AS entry
    WHERE (entry."submitted_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."submitted_by"))
       OR (entry."approved_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."approved_by"))
       OR (entry."rejected_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."rejected_by"))
       OR (entry."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."created_by"))
       OR (entry."updated_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."updated_by"))
  ) THEN
    ALTER TABLE "loss_entries" VALIDATE CONSTRAINT "loss_entries_submitted_by_fkey";
    ALTER TABLE "loss_entries" VALIDATE CONSTRAINT "loss_entries_approved_by_fkey";
    ALTER TABLE "loss_entries" VALIDATE CONSTRAINT "loss_entries_rejected_by_fkey";
    ALTER TABLE "loss_entries" VALIDATE CONSTRAINT "loss_entries_created_by_fkey";
    ALTER TABLE "loss_entries" VALIDATE CONSTRAINT "loss_entries_updated_by_fkey";
  END IF;
END
$validation$;

DO $validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "downtime_entries" AS entry
    WHERE (entry."submitted_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."submitted_by"))
       OR (entry."approved_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."approved_by"))
       OR (entry."rejected_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."rejected_by"))
       OR (entry."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."created_by"))
       OR (entry."updated_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."updated_by"))
  ) THEN
    ALTER TABLE "downtime_entries" VALIDATE CONSTRAINT "downtime_entries_submitted_by_fkey";
    ALTER TABLE "downtime_entries" VALIDATE CONSTRAINT "downtime_entries_approved_by_fkey";
    ALTER TABLE "downtime_entries" VALIDATE CONSTRAINT "downtime_entries_rejected_by_fkey";
    ALTER TABLE "downtime_entries" VALIDATE CONSTRAINT "downtime_entries_created_by_fkey";
    ALTER TABLE "downtime_entries" VALIDATE CONSTRAINT "downtime_entries_updated_by_fkey";
  END IF;
END
$validation$;

DO $validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "dosage_checks" AS entry
    WHERE (entry."submitted_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."submitted_by"))
       OR (entry."approved_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."approved_by"))
       OR (entry."rejected_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."rejected_by"))
       OR (entry."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."created_by"))
       OR (entry."updated_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."updated_by"))
  ) THEN
    ALTER TABLE "dosage_checks" VALIDATE CONSTRAINT "dosage_checks_submitted_by_fkey";
    ALTER TABLE "dosage_checks" VALIDATE CONSTRAINT "dosage_checks_approved_by_fkey";
    ALTER TABLE "dosage_checks" VALIDATE CONSTRAINT "dosage_checks_rejected_by_fkey";
    ALTER TABLE "dosage_checks" VALIDATE CONSTRAINT "dosage_checks_created_by_fkey";
    ALTER TABLE "dosage_checks" VALIDATE CONSTRAINT "dosage_checks_updated_by_fkey";
  END IF;
END
$validation$;

DO $validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "productivity_entries" AS entry
    WHERE (entry."submitted_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."submitted_by"))
       OR (entry."approved_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."approved_by"))
       OR (entry."rejected_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."rejected_by"))
       OR (entry."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."created_by"))
       OR (entry."updated_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" AS actor WHERE actor."id" = entry."updated_by"))
  ) THEN
    ALTER TABLE "productivity_entries" VALIDATE CONSTRAINT "productivity_entries_submitted_by_fkey";
    ALTER TABLE "productivity_entries" VALIDATE CONSTRAINT "productivity_entries_approved_by_fkey";
    ALTER TABLE "productivity_entries" VALIDATE CONSTRAINT "productivity_entries_rejected_by_fkey";
    ALTER TABLE "productivity_entries" VALIDATE CONSTRAINT "productivity_entries_created_by_fkey";
    ALTER TABLE "productivity_entries" VALIDATE CONSTRAINT "productivity_entries_updated_by_fkey";
  END IF;
END
$validation$;

COMMIT;
