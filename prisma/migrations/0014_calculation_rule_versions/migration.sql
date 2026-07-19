BEGIN;

ALTER TABLE "production_entries"
ADD COLUMN "calculation_rule_versions" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "loss_entries"
ADD COLUMN "calculation_rule_versions" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "downtime_entries"
ADD COLUMN "calculation_rule_versions" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "productivity_entries"
ADD COLUMN "calculation_rule_versions" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "dosage_checks"
ADD COLUMN "calculation_rule_versions" JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
