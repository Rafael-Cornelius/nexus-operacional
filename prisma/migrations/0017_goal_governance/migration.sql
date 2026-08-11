BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "GoalStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

DROP INDEX IF EXISTS "goals_metric_active_idx";
ALTER TABLE "goals" RENAME COLUMN "active" TO "legacy_active";
ALTER TABLE "goals" RENAME COLUMN "due_date" TO "legacy_due_date";

ALTER TABLE "goals"
  ADD COLUMN "series_id" UUID,
  ADD COLUMN "previous_version_id" UUID,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "line_id" UUID,
  ADD COLUMN "equipment_id" UUID,
  ADD COLUMN "shift_id" UUID,
  ADD COLUMN "product_id" UUID,
  ADD COLUMN "scope_key" TEXT,
  ADD COLUMN "measurement_unit" TEXT,
  ADD COLUMN "starts_on" DATE,
  ADD COLUMN "ends_on" DATE,
  ADD COLUMN "responsible_id" UUID,
  ADD COLUMN "approved_by" UUID,
  ADD COLUMN "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approval_reason" TEXT,
  ADD COLUMN "retired_at" TIMESTAMP(3),
  ADD COLUMN "retired_by" UUID,
  ADD COLUMN "retirement_reason" TEXT,
  ADD COLUMN "version_reason" TEXT,
  ADD COLUMN "created_by" UUID;

-- Cada registro legado vira primeira versão de sua própria série. Nenhum recebe
-- vigência, unidade, responsável ou aprovação inventados.
UPDATE "goals"
SET
  "series_id" = "id",
  "scope_key" = "metric"
    || '|sector=' || COALESCE("sector_code"::TEXT, '*')
    || '|line=*|equipment=*|shift=*|product=*',
  "status" = 'DRAFT',
  "version_reason" = 'Registro legado migrado; exige definição e aprovação humana.';

ALTER TABLE "goals"
  ALTER COLUMN "series_id" SET NOT NULL,
  ALTER COLUMN "series_id" SET DEFAULT gen_random_uuid();

ALTER TABLE "goals"
  ADD CONSTRAINT "goals_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "goals_supported_metric" CHECK ("metric" IN ('yield', 'overweight', 'losses_kg', 'downtime_minutes', 'produced_kg')),
  ADD CONSTRAINT "goals_supported_comparator" CHECK ("comparator" IN ('<=', '>=', '<', '>', '=')),
  ADD CONSTRAINT "goals_valid_period" CHECK ("ends_on" IS NULL OR ("starts_on" IS NOT NULL AND "ends_on" >= "starts_on")),
  ADD CONSTRAINT "goals_approved_metadata_required" CHECK (
    "status" <> 'APPROVED'
    OR (
      "scope_key" IS NOT NULL
      AND "measurement_unit" IS NOT NULL
      AND LENGTH(BTRIM("measurement_unit")) > 0
      AND "starts_on" IS NOT NULL
      AND "responsible_id" IS NOT NULL
      AND "approved_by" IS NOT NULL
      AND "approved_at" IS NOT NULL
      AND "approval_reason" IS NOT NULL
      AND LENGTH(BTRIM("approval_reason")) >= 10
    )
  ),
  ADD CONSTRAINT "goals_retirement_metadata_required" CHECK (
    "status" <> 'RETIRED'
    OR (
      "retired_at" IS NOT NULL
      AND "retired_by" IS NOT NULL
      AND "retirement_reason" IS NOT NULL
      AND LENGTH(BTRIM("retirement_reason")) >= 10
    )
  ),
  ADD CONSTRAINT "goals_workflow_metadata_consistent" CHECK (
    (
      "status" = 'DRAFT'
      AND "approved_by" IS NULL
      AND "approved_at" IS NULL
      AND "approval_reason" IS NULL
      AND "retired_by" IS NULL
      AND "retired_at" IS NULL
      AND "retirement_reason" IS NULL
    )
    OR (
      "status" = 'APPROVED'
      AND "approved_by" IS NOT NULL
      AND "approved_at" IS NOT NULL
      AND "approval_reason" IS NOT NULL
      AND LENGTH(BTRIM("approval_reason")) >= 10
      AND "retired_by" IS NULL
      AND "retired_at" IS NULL
      AND "retirement_reason" IS NULL
    )
    OR (
      "status" = 'RETIRED'
      AND "retired_by" IS NOT NULL
      AND "retired_at" IS NOT NULL
      AND "retirement_reason" IS NOT NULL
      AND LENGTH(BTRIM("retirement_reason")) >= 10
      AND (
        ("approved_by" IS NULL AND "approved_at" IS NULL AND "approval_reason" IS NULL)
        OR (
          "approved_by" IS NOT NULL
          AND "approved_at" IS NOT NULL
          AND "approval_reason" IS NOT NULL
          AND LENGTH(BTRIM("approval_reason")) >= 10
        )
      )
    )
  );

ALTER TABLE "goals"
  ADD CONSTRAINT "goals_sector_code_fkey" FOREIGN KEY ("sector_code") REFERENCES "sectors"("code") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "goals_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "production_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "goals_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "goals_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "goals_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "goals_responsible_id_fkey" FOREIGN KEY ("responsible_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "goals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "goals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "goals_retired_by_fkey" FOREIGN KEY ("retired_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "goals_previous_version_id_fkey" FOREIGN KEY ("previous_version_id") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "goals_series_id_version_key" ON "goals"("series_id", "version");
CREATE INDEX "goals_metric_status_starts_on_ends_on_idx" ON "goals"("metric", "status", "starts_on", "ends_on");
CREATE INDEX "goals_scope_key_status_starts_on_ends_on_idx" ON "goals"("scope_key", "status", "starts_on", "ends_on");
CREATE INDEX "goals_sector_code_line_id_equipment_id_shift_id_product_id_idx" ON "goals"("sector_code", "line_id", "equipment_id", "shift_id", "product_id");
CREATE INDEX "goals_responsible_id_idx" ON "goals"("responsible_id");
CREATE INDEX "goals_created_by_idx" ON "goals"("created_by");

ALTER TABLE "goals"
  ADD CONSTRAINT "goals_approved_scope_validity_no_overlap"
  EXCLUDE USING gist (
    "scope_key" WITH =,
    daterange("starts_on", COALESCE("ends_on", 'infinity'::date), '[]') WITH &&
  ) WHERE (
    "status" = 'APPROVED'
    AND "deleted_at" IS NULL
    AND "scope_key" IS NOT NULL
    AND "starts_on" IS NOT NULL
  );

-- Definição de cada versão é imutável. Workflow pode atualizar somente estado
-- e metadados de aprovação/retirada.
CREATE OR REPLACE FUNCTION prevent_goal_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT'
      OR NEW.approved_by IS NOT NULL
      OR NEW.approved_at IS NOT NULL
      OR NEW.approval_reason IS NOT NULL
      OR NEW.retired_by IS NOT NULL
      OR NEW.retired_at IS NOT NULL
      OR NEW.retirement_reason IS NOT NULL
    THEN
      RAISE EXCEPTION 'Nova versão de meta deve nascer DRAFT e sem metadados de decisão.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'RETIRED'))
      OR (OLD.status = 'APPROVED' AND NEW.status = 'RETIRED')
    )
  THEN
    RAISE EXCEPTION 'Transição de status da meta é inválida.';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status
    AND ROW(
      OLD.approved_by, OLD.approved_at, OLD.approval_reason,
      OLD.retired_by, OLD.retired_at, OLD.retirement_reason
    ) IS DISTINCT FROM ROW(
      NEW.approved_by, NEW.approved_at, NEW.approval_reason,
      NEW.retired_by, NEW.retired_at, NEW.retirement_reason
    )
  THEN
    RAISE EXCEPTION 'Metadados de decisão só podem mudar durante transição válida.';
  END IF;

  IF NEW.status = 'RETIRED' AND OLD.status IN ('DRAFT', 'APPROVED')
    AND ROW(OLD.approved_by, OLD.approved_at, OLD.approval_reason)
      IS DISTINCT FROM ROW(NEW.approved_by, NEW.approved_at, NEW.approval_reason)
  THEN
    RAISE EXCEPTION 'Retirada não pode reescrever metadados de aprovação.';
  END IF;

  IF NEW.status = 'APPROVED' AND OLD.status = 'DRAFT'
    AND ROW(OLD.retired_by, OLD.retired_at, OLD.retirement_reason)
      IS DISTINCT FROM ROW(NEW.retired_by, NEW.retired_at, NEW.retirement_reason)
  THEN
    RAISE EXCEPTION 'Aprovação não pode gravar metadados de retirada.';
  END IF;

  IF ROW(
    OLD.series_id, OLD.previous_version_id, OLD.version, OLD.name, OLD.metric,
    OLD.sector_code, OLD.line_id, OLD.equipment_id, OLD.shift_id, OLD.product_id,
    OLD.scope_key, OLD.target_value, OLD.comparator, OLD.measurement_unit,
    OLD.cadence, OLD.starts_on, OLD.ends_on, OLD.responsible_id,
    OLD.version_reason, OLD.created_by, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.series_id, NEW.previous_version_id, NEW.version, NEW.name, NEW.metric,
    NEW.sector_code, NEW.line_id, NEW.equipment_id, NEW.shift_id, NEW.product_id,
    NEW.scope_key, NEW.target_value, NEW.comparator, NEW.measurement_unit,
    NEW.cadence, NEW.starts_on, NEW.ends_on, NEW.responsible_id,
    NEW.version_reason, NEW.created_by, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Versões de metas são imutáveis; crie uma nova versão.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "goals_prevent_version_mutation"
BEFORE INSERT OR UPDATE ON "goals"
FOR EACH ROW EXECUTE FUNCTION prevent_goal_version_mutation();

COMMIT;
