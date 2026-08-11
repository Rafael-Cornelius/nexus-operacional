ALTER TABLE "audit_logs"
  ADD COLUMN "user_agent" TEXT,
  ADD COLUMN "correlation_id" TEXT,
  ADD COLUMN "request_origin" TEXT,
  ADD COLUMN "device_id" TEXT,
  ADD COLUMN "app_version" TEXT;

CREATE INDEX "audit_logs_correlation_id_idx" ON "audit_logs"("correlation_id");
