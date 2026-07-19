-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SectorCode" AS ENUM ('P1', 'P2');

-- CreateEnum
CREATE TYPE "WeekStatus" AS ENUM ('OPEN', 'REVIEW', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RoleCode" AS ENUM ('ADMIN', 'MANAGER', 'SUPERVISOR', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "LossTypeCode" AS ENUM ('PACKAGING', 'BOX', 'ORGANIC', 'MACHINE', 'WEIGHING', 'OVERWEIGHT', 'OTHER');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OK', 'MEDIUM', 'ATTENTION', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ProductionFormula" AS ENUM ('BOX_WEIGHT', 'PACKAGE_WEIGHT');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'GENERATED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('RECEIVED', 'CLEANED', 'IMPORTED', 'IMPORTED_WITH_ERRORS', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" "RoleCode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "sectors" (
    "id" UUID NOT NULL,
    "code" "SectorCode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_lines" (
    "id" UUID NOT NULL,
    "sector_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "production_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_sector_id" UUID NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'kg',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_weight_configs" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "package_weight_kg" DECIMAL(12,3) NOT NULL,
    "box_weight_kg" DECIMAL(12,3) NOT NULL,
    "packages_per_box" INTEGER NOT NULL,
    "mass_weight_kg" DECIMAL(12,3) NOT NULL,
    "target_package_weight_g" DECIMAL(12,3) NOT NULL,
    "overweight_tolerance_percent" DECIMAL(8,6) NOT NULL DEFAULT 0.02,
    "formula" "ProductionFormula" NOT NULL DEFAULT 'BOX_WEIGHT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_weight_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_periods" (
    "id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "week_number" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" "WeekStatus" NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "weekly_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_orders" (
    "id" UUID NOT NULL,
    "week_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sector_code" "SectorCode" NOT NULL,
    "order_number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_entries" (
    "id" UUID NOT NULL,
    "week_id" UUID NOT NULL,
    "sector_id" UUID NOT NULL,
    "line_id" UUID,
    "product_id" UUID NOT NULL,
    "production_order_id" UUID,
    "date" DATE NOT NULL,
    "production_order" TEXT NOT NULL,
    "planned_batches" DECIMAL(12,3) NOT NULL,
    "realized_batches" DECIMAL(12,3) NOT NULL,
    "used_rework_kg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "packed_boxes" DECIMAL(12,3) NOT NULL,
    "produced_kg" DECIMAL(14,3) NOT NULL,
    "weighing_loss_kg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "generated_rework_kg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "expected_yield_kg" DECIMAL(14,3) NOT NULL,
    "real_yield_percent" DECIMAL(10,6) NOT NULL,
    "mass_weight_kg" DECIMAL(12,3) NOT NULL,
    "box_weight_kg" DECIMAL(12,3) NOT NULL,
    "target_package_weight_g" DECIMAL(12,3) NOT NULL,
    "average_package_weight_g" DECIMAL(12,3),
    "overweight_g_per_package" DECIMAL(12,3) NOT NULL,
    "overweight_total_kg" DECIMAL(14,3) NOT NULL,
    "overweight_percent" DECIMAL(10,6) NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OK',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "production_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loss_types" (
    "id" UUID NOT NULL,
    "code" "LossTypeCode" NOT NULL,
    "name" TEXT NOT NULL,
    "default_goal_kg" DECIMAL(12,3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loss_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loss_entries" (
    "id" UUID NOT NULL,
    "week_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "sector_id" UUID,
    "product_id" UUID,
    "production_order_id" UUID,
    "loss_type_id" UUID NOT NULL,
    "quantity_kg" DECIMAL(12,3) NOT NULL,
    "reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "loss_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "downtime_reasons" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "downtime_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "downtime_entries" (
    "id" UUID NOT NULL,
    "week_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "sector_id" UUID NOT NULL,
    "line_id" UUID,
    "production_start" TIMESTAMP(3) NOT NULL,
    "production_end" TIMESTAMP(3) NOT NULL,
    "produced_mass_kg" DECIMAL(14,3) NOT NULL,
    "downtime_start" TIMESTAMP(3) NOT NULL,
    "downtime_end" TIMESTAMP(3) NOT NULL,
    "stopped_minutes" DECIMAL(12,2) NOT NULL,
    "stopped_percent" DECIMAL(10,6) NOT NULL,
    "real_kg_hour" DECIMAL(14,3) NOT NULL,
    "possible_kg_hour" DECIMAL(14,3) NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OK',
    "downtime_reason_id" UUID NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "downtime_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productivity_entries" (
    "id" UUID NOT NULL,
    "week_id" UUID NOT NULL,
    "sector_code" "SectorCode" NOT NULL,
    "date" DATE NOT NULL,
    "produced_kg" DECIMAL(14,3) NOT NULL,
    "productive_hours" DECIMAL(12,3) NOT NULL,
    "kg_per_hour" DECIMAL(14,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "productivity_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "sector_code" "SectorCode",
    "target_value" DECIMAL(14,6) NOT NULL,
    "comparator" TEXT NOT NULL DEFAULT '<=',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_snapshots" (
    "id" UUID NOT NULL,
    "week_id" UUID,
    "filter" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "file_path" TEXT,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presentation_exports" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "payload" JSONB,
    "file_path" TEXT,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "presentation_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "mime_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "source_file" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'RECEIVED',
    "summary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_by" UUID,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_errors" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "sheet_name" TEXT,
    "cell" TEXT,
    "row_number" INTEGER,
    "field" TEXT,
    "message" TEXT NOT NULL,
    "raw_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" UUID NOT NULL,
    "file_path" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "checksum" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sectors_code_key" ON "sectors"("code");

-- CreateIndex
CREATE UNIQUE INDEX "production_lines_sector_id_code_key" ON "production_lines"("sector_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "products_default_sector_id_idx" ON "products"("default_sector_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_weight_configs_product_id_key" ON "product_weight_configs"("product_id");

-- CreateIndex
CREATE INDEX "weekly_periods_status_idx" ON "weekly_periods"("status");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_periods_year_month_week_number_key" ON "weekly_periods"("year", "month", "week_number");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_week_id_order_number_product_id_key" ON "production_orders"("week_id", "order_number", "product_id");

-- CreateIndex
CREATE INDEX "production_entries_week_id_sector_id_date_idx" ON "production_entries"("week_id", "sector_id", "date");

-- CreateIndex
CREATE INDEX "production_entries_product_id_idx" ON "production_entries"("product_id");

-- CreateIndex
CREATE INDEX "production_entries_production_order_idx" ON "production_entries"("production_order");

-- CreateIndex
CREATE UNIQUE INDEX "loss_types_code_key" ON "loss_types"("code");

-- CreateIndex
CREATE INDEX "loss_entries_week_id_date_idx" ON "loss_entries"("week_id", "date");

-- CreateIndex
CREATE INDEX "loss_entries_loss_type_id_idx" ON "loss_entries"("loss_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "downtime_reasons_name_key" ON "downtime_reasons"("name");

-- CreateIndex
CREATE INDEX "downtime_entries_week_id_date_idx" ON "downtime_entries"("week_id", "date");

-- CreateIndex
CREATE INDEX "downtime_entries_downtime_reason_id_idx" ON "downtime_entries"("downtime_reason_id");

-- CreateIndex
CREATE INDEX "productivity_entries_week_id_sector_code_idx" ON "productivity_entries"("week_id", "sector_code");

-- CreateIndex
CREATE INDEX "goals_metric_active_idx" ON "goals"("metric", "active");

-- CreateIndex
CREATE INDEX "audit_logs_module_action_idx" ON "audit_logs"("module", "action");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entity_id_idx" ON "audit_logs"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "attachments_entity_entity_id_idx" ON "attachments"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "comments_entity_entity_id_idx" ON "comments"("entity", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE INDEX "import_errors_batch_id_idx" ON "import_errors"("batch_id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_lines" ADD CONSTRAINT "production_lines_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "sectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_default_sector_id_fkey" FOREIGN KEY ("default_sector_id") REFERENCES "sectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_weight_configs" ADD CONSTRAINT "product_weight_configs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_week_id_fkey" FOREIGN KEY ("week_id") REFERENCES "weekly_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_entries" ADD CONSTRAINT "production_entries_week_id_fkey" FOREIGN KEY ("week_id") REFERENCES "weekly_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_entries" ADD CONSTRAINT "production_entries_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "sectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_entries" ADD CONSTRAINT "production_entries_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "production_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_entries" ADD CONSTRAINT "production_entries_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_entries" ADD CONSTRAINT "production_entries_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_entries" ADD CONSTRAINT "loss_entries_week_id_fkey" FOREIGN KEY ("week_id") REFERENCES "weekly_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_entries" ADD CONSTRAINT "loss_entries_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "sectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_entries" ADD CONSTRAINT "loss_entries_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_entries" ADD CONSTRAINT "loss_entries_loss_type_id_fkey" FOREIGN KEY ("loss_type_id") REFERENCES "loss_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downtime_entries" ADD CONSTRAINT "downtime_entries_week_id_fkey" FOREIGN KEY ("week_id") REFERENCES "weekly_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downtime_entries" ADD CONSTRAINT "downtime_entries_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "sectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downtime_entries" ADD CONSTRAINT "downtime_entries_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "production_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downtime_entries" ADD CONSTRAINT "downtime_entries_downtime_reason_id_fkey" FOREIGN KEY ("downtime_reason_id") REFERENCES "downtime_reasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_snapshots" ADD CONSTRAINT "dashboard_snapshots_week_id_fkey" FOREIGN KEY ("week_id") REFERENCES "weekly_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_errors" ADD CONSTRAINT "import_errors_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
