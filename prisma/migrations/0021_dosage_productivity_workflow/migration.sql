BEGIN;

CREATE TYPE "ProductivitySource" AS ENUM (
  'INFORMED_MANUALLY',
  'LEGACY_UNVERIFIED'
);

ALTER TABLE "dosage_checks"
  ADD COLUMN "workflow_status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "submitted_at" TIMESTAMP(3),
  ADD COLUMN "submitted_by" UUID,
  ADD COLUMN "submission_reason" TEXT,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approved_by" UUID,
  ADD COLUMN "approval_reason" TEXT,
  ADD COLUMN "rejected_at" TIMESTAMP(3),
  ADD COLUMN "rejected_by" UUID,
  ADD COLUMN "rejection_reason" TEXT,
  ADD COLUMN "deleted_at" TIMESTAMP(3),
  ADD COLUMN "created_by" UUID,
  ADD COLUMN "updated_by" UUID;

ALTER TABLE "productivity_entries"
  ADD COLUMN "data_source" "ProductivitySource" NOT NULL DEFAULT 'LEGACY_UNVERIFIED',
  ADD COLUMN "workflow_status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "submitted_at" TIMESTAMP(3),
  ADD COLUMN "submitted_by" UUID,
  ADD COLUMN "submission_reason" TEXT,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approved_by" UUID,
  ADD COLUMN "approval_reason" TEXT,
  ADD COLUMN "rejected_at" TIMESTAMP(3),
  ADD COLUMN "rejected_by" UUID,
  ADD COLUMN "rejection_reason" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "deleted_at" TIMESTAMP(3),
  ADD COLUMN "created_by" UUID,
  ADD COLUMN "updated_by" UUID;

-- The week immutability triggers from 0013 correctly reject ordinary changes
-- to CLOSED/ARCHIVED history. This one-time metadata backfill must also cover
-- those legacy rows, so disable only the two affected triggers and restore
-- both before any constraint is added. ALTER TABLE is transactional in
-- PostgreSQL: a failed migration rolls the trigger state back as well.
ALTER TABLE "dosage_checks"
  DISABLE TRIGGER "dosage_checks_week_writable";
ALTER TABLE "productivity_entries"
  DISABLE TRIGGER "productivity_entries_week_writable";

UPDATE "dosage_checks"
SET
  "workflow_status" = 'UNDER_REVIEW',
  "submitted_at" = "created_at",
  "submission_reason" = 'Registro legado migrado; exige revisao humana.';

UPDATE "productivity_entries"
SET
  "workflow_status" = 'UNDER_REVIEW',
  "submitted_at" = "created_at",
  "submission_reason" = 'Registro legado migrado; origem e valores exigem revisao humana.';

ALTER TABLE "dosage_checks"
  ENABLE TRIGGER "dosage_checks_week_writable";
ALTER TABLE "productivity_entries"
  ENABLE TRIGGER "productivity_entries_week_writable";

ALTER TABLE "productivity_entries"
  ALTER COLUMN "data_source" SET DEFAULT 'INFORMED_MANUALLY';

ALTER TABLE "dosage_checks"
  ADD CONSTRAINT "dosage_checks_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "dosage_checks_rejection_reason_required" CHECK ("workflow_status" <> 'REJECTED' OR ("rejection_reason" IS NOT NULL AND LENGTH(BTRIM("rejection_reason")) > 0)),
  ADD CONSTRAINT "dosage_checks_workflow_metadata_consistent" CHECK (
    "workflow_status" = 'CANCELLED'
    OR (
      "workflow_status" = 'DRAFT'
      AND "submitted_at" IS NULL AND "submitted_by" IS NULL AND "submission_reason" IS NULL
      AND "approved_at" IS NULL AND "approved_by" IS NULL AND "approval_reason" IS NULL
      AND "rejected_at" IS NULL AND "rejected_by" IS NULL AND "rejection_reason" IS NULL
    )
    OR (
      "workflow_status" = 'SUBMITTED'
      AND "submitted_at" IS NOT NULL AND "submitted_by" IS NOT NULL
      AND "approved_at" IS NULL AND "approved_by" IS NULL AND "approval_reason" IS NULL
      AND "rejected_at" IS NULL AND "rejected_by" IS NULL AND "rejection_reason" IS NULL
    )
    OR (
      "workflow_status" = 'UNDER_REVIEW'
      AND "submitted_at" IS NOT NULL
      AND "approved_at" IS NULL AND "approved_by" IS NULL AND "approval_reason" IS NULL
      AND "rejected_at" IS NULL AND "rejected_by" IS NULL AND "rejection_reason" IS NULL
    )
    OR (
      "workflow_status" = 'APPROVED'
      AND "submitted_at" IS NOT NULL
      AND "approved_at" IS NOT NULL AND "approved_by" IS NOT NULL
      AND "rejected_at" IS NULL AND "rejected_by" IS NULL AND "rejection_reason" IS NULL
    )
    OR (
      "workflow_status" = 'REJECTED'
      AND "submitted_at" IS NOT NULL
      AND "approved_at" IS NULL AND "approved_by" IS NULL AND "approval_reason" IS NULL
      AND "rejected_at" IS NOT NULL AND "rejected_by" IS NOT NULL
      AND "rejection_reason" IS NOT NULL AND LENGTH(BTRIM("rejection_reason")) > 0
    )
  );

ALTER TABLE "productivity_entries"
  ADD CONSTRAINT "productivity_entries_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "productivity_entries_rejection_reason_required" CHECK ("workflow_status" <> 'REJECTED' OR ("rejection_reason" IS NOT NULL AND LENGTH(BTRIM("rejection_reason")) > 0)),
  ADD CONSTRAINT "productivity_entries_workflow_metadata_consistent" CHECK (
    "workflow_status" = 'CANCELLED'
    OR (
      "workflow_status" = 'DRAFT'
      AND "submitted_at" IS NULL AND "submitted_by" IS NULL AND "submission_reason" IS NULL
      AND "approved_at" IS NULL AND "approved_by" IS NULL AND "approval_reason" IS NULL
      AND "rejected_at" IS NULL AND "rejected_by" IS NULL AND "rejection_reason" IS NULL
    )
    OR (
      "workflow_status" = 'SUBMITTED'
      AND "submitted_at" IS NOT NULL AND "submitted_by" IS NOT NULL
      AND "approved_at" IS NULL AND "approved_by" IS NULL AND "approval_reason" IS NULL
      AND "rejected_at" IS NULL AND "rejected_by" IS NULL AND "rejection_reason" IS NULL
    )
    OR (
      "workflow_status" = 'UNDER_REVIEW'
      AND "submitted_at" IS NOT NULL
      AND "approved_at" IS NULL AND "approved_by" IS NULL AND "approval_reason" IS NULL
      AND "rejected_at" IS NULL AND "rejected_by" IS NULL AND "rejection_reason" IS NULL
    )
    OR (
      "workflow_status" = 'APPROVED'
      AND "submitted_at" IS NOT NULL
      AND "approved_at" IS NOT NULL AND "approved_by" IS NOT NULL
      AND "rejected_at" IS NULL AND "rejected_by" IS NULL AND "rejection_reason" IS NULL
    )
    OR (
      "workflow_status" = 'REJECTED'
      AND "submitted_at" IS NOT NULL
      AND "approved_at" IS NULL AND "approved_by" IS NULL AND "approval_reason" IS NULL
      AND "rejected_at" IS NOT NULL AND "rejected_by" IS NOT NULL
      AND "rejection_reason" IS NOT NULL AND LENGTH(BTRIM("rejection_reason")) > 0
    )
  );

CREATE INDEX "dosage_checks_week_id_workflow_status_idx" ON "dosage_checks"("week_id", "workflow_status");
CREATE INDEX "productivity_entries_week_id_workflow_status_idx" ON "productivity_entries"("week_id", "workflow_status");

COMMIT;
