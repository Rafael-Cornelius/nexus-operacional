CREATE TYPE "WorkflowStatus" AS ENUM (
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED'
);

ALTER TABLE "production_entries"
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
  ADD COLUMN "rejection_reason" TEXT;

ALTER TABLE "loss_entries"
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
  ADD COLUMN "rejection_reason" TEXT;

ALTER TABLE "downtime_entries"
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
  ADD COLUMN "rejection_reason" TEXT;

UPDATE "production_entries"
SET
  "workflow_status" = 'UNDER_REVIEW',
  "submitted_at" = "created_at",
  "submitted_by" = COALESCE("created_by", "updated_by"),
  "submission_reason" = 'Registro legado migrado; exige revisao humana.';

UPDATE "loss_entries"
SET
  "workflow_status" = 'UNDER_REVIEW',
  "submitted_at" = "created_at",
  "submitted_by" = COALESCE("created_by", "updated_by"),
  "submission_reason" = 'Registro legado migrado; exige revisao humana.';

UPDATE "downtime_entries"
SET
  "workflow_status" = 'UNDER_REVIEW',
  "submitted_at" = "created_at",
  "submitted_by" = COALESCE("created_by", "updated_by"),
  "submission_reason" = 'Registro legado migrado; exige revisao humana.';

ALTER TABLE "production_entries"
  ADD CONSTRAINT "production_entries_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "production_entries_rejection_reason_required" CHECK ("workflow_status" <> 'REJECTED' OR ("rejection_reason" IS NOT NULL AND LENGTH(BTRIM("rejection_reason")) > 0));

ALTER TABLE "loss_entries"
  ADD CONSTRAINT "loss_entries_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "loss_entries_rejection_reason_required" CHECK ("workflow_status" <> 'REJECTED' OR ("rejection_reason" IS NOT NULL AND LENGTH(BTRIM("rejection_reason")) > 0));

ALTER TABLE "downtime_entries"
  ADD CONSTRAINT "downtime_entries_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "downtime_entries_rejection_reason_required" CHECK ("workflow_status" <> 'REJECTED' OR ("rejection_reason" IS NOT NULL AND LENGTH(BTRIM("rejection_reason")) > 0));

CREATE INDEX "production_entries_week_id_workflow_status_idx" ON "production_entries"("week_id", "workflow_status");
CREATE INDEX "loss_entries_week_id_workflow_status_idx" ON "loss_entries"("week_id", "workflow_status");
CREATE INDEX "downtime_entries_week_id_workflow_status_idx" ON "downtime_entries"("week_id", "workflow_status");
