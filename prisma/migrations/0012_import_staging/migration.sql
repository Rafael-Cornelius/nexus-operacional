BEGIN;

ALTER TYPE "ImportStatus" ADD VALUE IF NOT EXISTS 'STAGED';
ALTER TYPE "ImportStatus" ADD VALUE IF NOT EXISTS 'PROMOTING';
ALTER TYPE "ImportStatus" ADD VALUE IF NOT EXISTS 'LEGACY_CERTIFIED';

CREATE TYPE "ImportStagingDomain" AS ENUM ('UNKNOWN', 'PRODUCT', 'PRODUCTION', 'LOSS', 'DOWNTIME');
CREATE TYPE "ImportStagingClassification" AS ENUM ('VALID', 'WARNING', 'ERROR', 'DUPLICATE', 'REQUIRES_REVIEW');
CREATE TYPE "ImportReviewDecision" AS ENUM ('PENDING', 'APPROVED', 'CORRECTED', 'IGNORED', 'REJECTED');

ALTER TABLE "import_batches"
  ADD COLUMN "promotion_started_at" TIMESTAMP(3),
  ADD COLUMN "promoted_at" TIMESTAMP(3),
  ADD COLUMN "promoted_by" UUID,
  ADD COLUMN "importer_version" TEXT;

CREATE TABLE "import_staging_records" (
  "id" UUID NOT NULL,
  "batch_id" UUID NOT NULL,
  "domain" "ImportStagingDomain" NOT NULL,
  "source_key" TEXT NOT NULL,
  "source_fingerprint" TEXT NOT NULL,
  "sheet_name" TEXT,
  "cell" TEXT,
  "row_number" INTEGER,
  "raw_original" JSONB NOT NULL,
  "interpreted_value" JSONB,
  "corrected_value" JSONB,
  "validation_issues" JSONB,
  "classification" "ImportStagingClassification" NOT NULL,
  "decision" "ImportReviewDecision" NOT NULL DEFAULT 'PENDING',
  "resolution_reason" TEXT,
  "resolved_by" UUID,
  "resolved_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "promoted_entity_id" TEXT,
  "promoted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "import_staging_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_staging_records_batch_id_domain_source_key_key"
  ON "import_staging_records"("batch_id", "domain", "source_key");
CREATE INDEX "import_staging_records_batch_id_domain_classification_idx"
  ON "import_staging_records"("batch_id", "domain", "classification");
CREATE INDEX "import_staging_records_batch_id_decision_idx"
  ON "import_staging_records"("batch_id", "decision");
CREATE INDEX "import_staging_records_source_fingerprint_idx"
  ON "import_staging_records"("source_fingerprint");

ALTER TABLE "import_staging_records"
  ADD CONSTRAINT "import_staging_records_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "import_staging_records"
  ADD CONSTRAINT "import_staging_records_resolution_consistency_check"
  CHECK (
    ("decision" = 'PENDING' AND "resolved_at" IS NULL AND "resolved_by" IS NULL)
    OR
    ("decision" <> 'PENDING' AND "resolved_at" IS NOT NULL AND "resolution_reason" IS NOT NULL)
  );

ALTER TABLE "import_staging_records"
  ADD CONSTRAINT "import_staging_records_correction_consistency_check"
  CHECK ("decision" <> 'CORRECTED' OR "corrected_value" IS NOT NULL);

COMMIT;
