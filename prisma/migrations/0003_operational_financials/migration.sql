CREATE TYPE "GoalCadence" AS ENUM ('DAILY', 'WEEKLY');

ALTER TABLE "products"
  ADD COLUMN "price_per_kg" DECIMAL(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN "film_cost_per_kg" DECIMAL(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN "package_film_weight_g" DECIMAL(12,3) NOT NULL DEFAULT 0;

CREATE TABLE "product_price_periods" (
  "id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "starts_on" DATE NOT NULL,
  "ends_on" DATE,
  "price_per_kg" DECIMAL(14,4) NOT NULL,
  "film_cost_per_kg" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_price_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_price_periods_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "product_price_periods_product_id_starts_on_idx" ON "product_price_periods"("product_id", "starts_on");

ALTER TABLE "production_entries"
  ADD COLUMN "unit_price_per_kg" DECIMAL(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN "production_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "losses_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "overweight_cost" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "loss_entries"
  ADD COLUMN "unit_cost" DECIMAL(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN "loss_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "packed_boxes" DECIMAL(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN "package_film_weight_g" DECIMAL(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN "film_cost_per_kg" DECIMAL(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN "film_used_kg" DECIMAL(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN "film_used_value" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "financial_result" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "weekly_periods" ADD COLUMN "snapshot_data" JSONB;
ALTER TABLE "goals"
  ADD COLUMN "cadence" "GoalCadence" NOT NULL DEFAULT 'WEEKLY',
  ADD COLUMN "due_date" DATE;

CREATE TABLE "dosage_checks" (
  "id" UUID NOT NULL,
  "week_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "sector_code" "SectorCode" NOT NULL,
  "date" DATE NOT NULL,
  "target_weight_g" DECIMAL(12,3) NOT NULL,
  "sample_weights_g" JSONB NOT NULL,
  "sample_count" INTEGER NOT NULL,
  "average_weight_g" DECIMAL(12,3) NOT NULL,
  "standard_deviation_g" DECIMAL(12,3) NOT NULL,
  "overweight_g" DECIMAL(12,3) NOT NULL,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dosage_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dosage_checks_week_id_fkey"
    FOREIGN KEY ("week_id") REFERENCES "weekly_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "dosage_checks_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "dosage_checks_week_id_product_id_date_idx" ON "dosage_checks"("week_id", "product_id", "date");
