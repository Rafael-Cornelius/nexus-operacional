BEGIN;

CREATE TYPE "ProductPriceStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

ALTER TABLE "product_price_periods"
  ADD COLUMN "currency" VARCHAR(3),
  ADD COLUMN "origin" TEXT,
  ADD COLUMN "observation" TEXT,
  ADD COLUMN "responsible_by" UUID,
  ADD COLUMN "approved_by" UUID,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approval_reason" TEXT,
  ADD COLUMN "retired_by" UUID,
  ADD COLUMN "retired_at" TIMESTAMP(3),
  ADD COLUMN "retirement_reason" TEXT,
  ADD COLUMN "status" "ProductPriceStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "version" INTEGER,
  ADD COLUMN "record_version" INTEGER NOT NULL DEFAULT 1;

-- Rascunhos e históricos aposentados podem sobrepor vigência: somente um
-- preço APPROVED pode ser fonte financeira em cada data. Isso permite criar
-- uma versão governada sem apagar ou falsificar o período legado em DRAFT.
ALTER TABLE "product_price_periods"
  DROP CONSTRAINT "product_price_periods_no_date_overlap";

ALTER TABLE "product_price_periods"
  ADD CONSTRAINT "product_price_periods_no_approved_date_overlap"
  EXCLUDE USING gist (
    "product_id" WITH =,
    daterange("starts_on", COALESCE("ends_on", 'infinity'::date), '[]') WITH &&
  ) WHERE ("status" = 'APPROVED');

-- Registros legados recebem somente versão técnica determinística. Permanecem
-- DRAFT, sem moeda, origem, responsável ou aprovação presumidos.
WITH numbered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "product_id"
      ORDER BY "starts_on", "created_at", "id"
    )::INTEGER AS "legacy_version"
  FROM "product_price_periods"
)
UPDATE "product_price_periods" AS price
SET "version" = numbered."legacy_version"
FROM numbered
WHERE price."id" = numbered."id";

ALTER TABLE "product_price_periods"
  ALTER COLUMN "version" SET NOT NULL,
  ALTER COLUMN "version" SET DEFAULT 1,
  ADD CONSTRAINT "product_price_periods_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "product_price_periods_record_version_positive" CHECK ("record_version" > 0),
  ADD CONSTRAINT "product_price_periods_valid_period" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
  ADD CONSTRAINT "product_price_periods_currency_format" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "product_price_periods_approved_metadata_required" CHECK (
    "status" <> 'APPROVED'
    OR (
      "price_per_kg" > 0
      AND "currency" IS NOT NULL
      AND "origin" IS NOT NULL
      AND LENGTH(BTRIM("origin")) >= 2
      AND "responsible_by" IS NOT NULL
      AND "approved_by" IS NOT NULL
      AND "approved_by" <> "responsible_by"
      AND "approved_at" IS NOT NULL
      AND "approval_reason" IS NOT NULL
      AND LENGTH(BTRIM("approval_reason")) >= 5
    )
  ),
  ADD CONSTRAINT "product_price_periods_retirement_metadata_required" CHECK (
    "status" <> 'RETIRED'
    OR (
      "retired_by" IS NOT NULL
      AND "retired_at" IS NOT NULL
      AND "retirement_reason" IS NOT NULL
      AND LENGTH(BTRIM("retirement_reason")) >= 5
    )
  ),
  ADD CONSTRAINT "product_price_periods_workflow_metadata_consistent" CHECK (
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
      AND LENGTH(BTRIM("approval_reason")) >= 5
      AND "approved_by" <> "responsible_by"
      AND "retired_by" IS NULL
      AND "retired_at" IS NULL
      AND "retirement_reason" IS NULL
    )
    OR (
      "status" = 'RETIRED'
      AND "retired_by" IS NOT NULL
      AND "retired_at" IS NOT NULL
      AND "retirement_reason" IS NOT NULL
      AND LENGTH(BTRIM("retirement_reason")) >= 5
      AND (
        ("approved_by" IS NULL AND "approved_at" IS NULL AND "approval_reason" IS NULL)
        OR (
          "approved_by" IS NOT NULL
          AND "approved_at" IS NOT NULL
          AND "approval_reason" IS NOT NULL
          AND LENGTH(BTRIM("approval_reason")) >= 5
          AND "approved_by" <> "responsible_by"
        )
      )
    )
  ),
  ADD CONSTRAINT "product_price_periods_responsible_by_fkey" FOREIGN KEY ("responsible_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "product_price_periods_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "product_price_periods_retired_by_fkey" FOREIGN KEY ("retired_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "product_price_periods_product_id_starts_on_idx";
CREATE UNIQUE INDEX "product_price_periods_product_id_version_key" ON "product_price_periods"("product_id", "version");
CREATE INDEX "product_price_periods_product_id_status_starts_on_ends_on_idx" ON "product_price_periods"("product_id", "status", "starts_on", "ends_on");
CREATE INDEX "product_price_periods_responsible_by_idx" ON "product_price_periods"("responsible_by");

ALTER TABLE "production_entries"
  ADD COLUMN "price_period_id" UUID,
  ADD COLUMN "price_version" INTEGER,
  ADD COLUMN "price_origin" TEXT,
  ADD COLUMN "price_currency" VARCHAR(3),
  ADD CONSTRAINT "production_entries_price_period_id_fkey" FOREIGN KEY ("price_period_id") REFERENCES "product_price_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "production_entries_price_lineage_complete" CHECK (
    (
      "price_period_id" IS NULL
      AND "price_version" IS NULL
      AND "price_origin" IS NULL
      AND "price_currency" IS NULL
    )
    OR (
      "price_period_id" IS NOT NULL
      AND "price_version" IS NOT NULL
      AND "price_origin" IS NOT NULL
      AND "price_currency" IS NOT NULL
    )
  );

ALTER TABLE "loss_entries"
  ADD COLUMN "price_period_id" UUID,
  ADD COLUMN "price_version" INTEGER,
  ADD COLUMN "price_origin" TEXT,
  ADD COLUMN "price_currency" VARCHAR(3),
  ADD CONSTRAINT "loss_entries_price_period_id_fkey" FOREIGN KEY ("price_period_id") REFERENCES "product_price_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "loss_entries_price_lineage_complete" CHECK (
    (
      "price_period_id" IS NULL
      AND "price_version" IS NULL
      AND "price_origin" IS NULL
      AND "price_currency" IS NULL
    )
    OR (
      "price_period_id" IS NOT NULL
      AND "price_version" IS NOT NULL
      AND "price_origin" IS NOT NULL
      AND "price_currency" IS NOT NULL
    )
  );

CREATE INDEX "production_entries_price_period_id_idx" ON "production_entries"("price_period_id");
CREATE INDEX "loss_entries_price_period_id_idx" ON "loss_entries"("price_period_id");

-- Valor, vigência, origem e versão são imutáveis. Alteração exige novo período.
CREATE OR REPLACE FUNCTION prevent_product_price_business_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT'
      OR NEW.record_version <> 1
      OR NEW.approved_by IS NOT NULL
      OR NEW.approved_at IS NOT NULL
      OR NEW.approval_reason IS NOT NULL
      OR NEW.retired_by IS NOT NULL
      OR NEW.retired_at IS NOT NULL
      OR NEW.retirement_reason IS NOT NULL
    THEN
      RAISE EXCEPTION 'Novo período de preço deve nascer DRAFT, versão de registro 1 e sem metadados de decisão.';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    OLD.product_id, OLD.starts_on, OLD.ends_on, OLD.price_per_kg,
    OLD.film_cost_per_kg, OLD.currency, OLD.origin, OLD.observation,
    OLD.responsible_by, OLD.version, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.product_id, NEW.starts_on, NEW.ends_on, NEW.price_per_kg,
    NEW.film_cost_per_kg, NEW.currency, NEW.origin, NEW.observation,
    NEW.responsible_by, NEW.version, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Versões de preço são imutáveis; crie um novo período.';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'RETIRED'))
      OR (OLD.status = 'APPROVED' AND NEW.status = 'RETIRED')
    )
  THEN
    RAISE EXCEPTION 'Transição de status do preço é inválida.';
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
    RAISE EXCEPTION 'Metadados de decisão do preço só podem mudar durante transição válida.';
  END IF;

  IF NEW.status = 'RETIRED' AND OLD.status IN ('DRAFT', 'APPROVED')
    AND ROW(OLD.approved_by, OLD.approved_at, OLD.approval_reason)
      IS DISTINCT FROM ROW(NEW.approved_by, NEW.approved_at, NEW.approval_reason)
  THEN
    RAISE EXCEPTION 'Aposentadoria não pode reescrever metadados de aprovação do preço.';
  END IF;

  IF NEW.status = 'APPROVED' AND OLD.status = 'DRAFT'
    AND ROW(OLD.retired_by, OLD.retired_at, OLD.retirement_reason)
      IS DISTINCT FROM ROW(NEW.retired_by, NEW.retired_at, NEW.retirement_reason)
  THEN
    RAISE EXCEPTION 'Aprovação não pode gravar metadados de aposentadoria do preço.';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.record_version <> OLD.record_version + 1 THEN
    RAISE EXCEPTION 'Transição de preço exige incremento único de record_version.';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.record_version <> OLD.record_version THEN
    RAISE EXCEPTION 'record_version só muda durante transição de status.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "product_price_periods_prevent_business_mutation"
BEFORE INSERT OR UPDATE ON "product_price_periods"
FOR EACH ROW EXECUTE FUNCTION prevent_product_price_business_mutation();

-- Uma FK confirma apenas existência. Estes triggers validam significado da
-- linhagem no instante em que o lançamento recebe ou troca sua fonte de preço.
-- O FOR SHARE serializa essa validação contra alteração concorrente do período.
CREATE OR REPLACE FUNCTION validate_production_entry_price_lineage()
RETURNS TRIGGER AS $$
DECLARE
  linked_price product_price_periods%ROWTYPE;
BEGIN
  IF NEW.price_period_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
  INTO linked_price
  FROM "product_price_periods"
  WHERE "id" = NEW.price_period_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Período de preço da produção não existe.' USING ERRCODE = '23514';
  END IF;
  IF linked_price.product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'Período de preço da produção pertence a outro produto.' USING ERRCODE = '23514';
  END IF;
  IF linked_price.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Período de preço da produção não está aprovado.' USING ERRCODE = '23514';
  END IF;
  IF NEW.date < linked_price.starts_on
    OR (linked_price.ends_on IS NOT NULL AND NEW.date > linked_price.ends_on)
  THEN
    RAISE EXCEPTION 'Data da produção está fora da vigência do preço.' USING ERRCODE = '23514';
  END IF;
  IF NEW.price_version IS DISTINCT FROM linked_price.version
    OR NEW.price_origin IS DISTINCT FROM linked_price.origin
    OR NEW.price_currency IS DISTINCT FROM linked_price.currency
  THEN
    RAISE EXCEPTION 'Snapshot de versão, origem ou moeda da produção diverge do período.' USING ERRCODE = '23514';
  END IF;
  IF NEW.unit_price_per_kg IS DISTINCT FROM linked_price.price_per_kg THEN
    RAISE EXCEPTION 'Preço unitário da produção diverge do período aprovado.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "production_entries_validate_price_lineage_insert"
BEFORE INSERT ON "production_entries"
FOR EACH ROW EXECUTE FUNCTION validate_production_entry_price_lineage();

CREATE TRIGGER "production_entries_validate_price_lineage_update"
BEFORE UPDATE OF "price_period_id", "product_id", "date", "price_version", "price_origin", "price_currency", "unit_price_per_kg"
ON "production_entries"
FOR EACH ROW EXECUTE FUNCTION validate_production_entry_price_lineage();

CREATE OR REPLACE FUNCTION validate_loss_entry_price_lineage()
RETURNS TRIGGER AS $$
DECLARE
  linked_price product_price_periods%ROWTYPE;
BEGIN
  IF NEW.price_period_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
  INTO linked_price
  FROM "product_price_periods"
  WHERE "id" = NEW.price_period_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Período de preço da perda não existe.' USING ERRCODE = '23514';
  END IF;
  IF linked_price.product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'Período de preço da perda pertence a outro produto.' USING ERRCODE = '23514';
  END IF;
  IF linked_price.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Período de preço da perda não está aprovado.' USING ERRCODE = '23514';
  END IF;
  IF NEW.date < linked_price.starts_on
    OR (linked_price.ends_on IS NOT NULL AND NEW.date > linked_price.ends_on)
  THEN
    RAISE EXCEPTION 'Data da perda está fora da vigência do preço.' USING ERRCODE = '23514';
  END IF;
  IF NEW.price_version IS DISTINCT FROM linked_price.version
    OR NEW.price_origin IS DISTINCT FROM linked_price.origin
    OR NEW.price_currency IS DISTINCT FROM linked_price.currency
  THEN
    RAISE EXCEPTION 'Snapshot de versão, origem ou moeda da perda diverge do período.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "loss_entries_validate_price_lineage_insert"
BEFORE INSERT ON "loss_entries"
FOR EACH ROW EXECUTE FUNCTION validate_loss_entry_price_lineage();

CREATE TRIGGER "loss_entries_validate_price_lineage_update"
BEFORE UPDATE OF "price_period_id", "product_id", "date", "price_version", "price_origin", "price_currency"
ON "loss_entries"
FOR EACH ROW EXECUTE FUNCTION validate_loss_entry_price_lineage();

COMMIT;
