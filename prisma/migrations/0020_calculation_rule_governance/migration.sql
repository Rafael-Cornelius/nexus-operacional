BEGIN;

CREATE TYPE "CalculationRuleApprovalStatus" AS ENUM ('APPROVED', 'RETIRED');

CREATE TABLE "calculation_rule_approvals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "rule_id" VARCHAR(160) NOT NULL,
  "rule_version" INTEGER NOT NULL,
  "status" "CalculationRuleApprovalStatus" NOT NULL DEFAULT 'APPROVED',
  "approved_at" TIMESTAMP(3) NOT NULL,
  "approved_by" UUID NOT NULL,
  "approval_reason" TEXT NOT NULL,
  "retired_at" TIMESTAMP(3),
  "retired_by" UUID,
  "retirement_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "calculation_rule_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "calculation_rule_approvals_rule_id_not_blank" CHECK (LENGTH(BTRIM("rule_id")) > 0),
  CONSTRAINT "calculation_rule_approvals_rule_version_positive" CHECK ("rule_version" > 0),
  CONSTRAINT "calculation_rule_approvals_approval_reason_required" CHECK (LENGTH(BTRIM("approval_reason")) >= 10),
  CONSTRAINT "calculation_rule_approvals_workflow_metadata_consistent" CHECK (
    (
      "status" = 'APPROVED'
      AND "retired_at" IS NULL
      AND "retired_by" IS NULL
      AND "retirement_reason" IS NULL
    )
    OR (
      "status" = 'RETIRED'
      AND "retired_at" IS NOT NULL
      AND "retired_by" IS NOT NULL
      AND "retirement_reason" IS NOT NULL
      AND LENGTH(BTRIM("retirement_reason")) >= 10
    )
  )
);

CREATE UNIQUE INDEX "calculation_rule_approvals_rule_id_rule_version_key"
  ON "calculation_rule_approvals"("rule_id", "rule_version");
CREATE INDEX "calculation_rule_approvals_status_rule_id_idx"
  ON "calculation_rule_approvals"("status", "rule_id");
CREATE INDEX "calculation_rule_approvals_approved_by_idx"
  ON "calculation_rule_approvals"("approved_by");
CREATE INDEX "calculation_rule_approvals_retired_by_idx"
  ON "calculation_rule_approvals"("retired_by");

ALTER TABLE "calculation_rule_approvals"
  ADD CONSTRAINT "calculation_rule_approvals_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "calculation_rule_approvals_retired_by_fkey"
    FOREIGN KEY ("retired_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Uma aprovação registra decisão humana final sobre definição imutável do
-- registry. Retirada permanece histórica; reativação exige nova versão.
CREATE OR REPLACE FUNCTION protect_calculation_rule_approval()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Decisão de regra de cálculo não pode ser excluída.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'APPROVED'
      OR NEW.retired_at IS NOT NULL
      OR NEW.retired_by IS NOT NULL
      OR NEW.retirement_reason IS NOT NULL
    THEN
      RAISE EXCEPTION 'Nova decisão de regra deve nascer APPROVED sem metadados de retirada.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.rule_id IS DISTINCT FROM OLD.rule_id
    OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approval_reason IS DISTINCT FROM OLD.approval_reason
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Identidade e aprovação original da regra são imutáveis.';
  END IF;

  IF OLD.status = 'APPROVED' AND NEW.status = 'RETIRED' THEN
    IF NEW.retired_at IS NULL
      OR NEW.retired_by IS NULL
      OR NEW.retirement_reason IS NULL
      OR LENGTH(BTRIM(NEW.retirement_reason)) < 10
    THEN
      RAISE EXCEPTION 'Retirada exige usuário, data e motivo com ao menos 10 caracteres.';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Transição de decisão de regra inválida; retirada é final.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "calculation_rule_approvals_protect_decision"
BEFORE INSERT OR UPDATE OR DELETE ON "calculation_rule_approvals"
FOR EACH ROW EXECUTE FUNCTION protect_calculation_rule_approval();

COMMIT;
