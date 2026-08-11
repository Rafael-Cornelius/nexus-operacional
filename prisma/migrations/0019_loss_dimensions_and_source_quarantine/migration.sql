BEGIN;

ALTER TYPE "ImportStagingDomain" ADD VALUE IF NOT EXISTS 'DOSAGE';
ALTER TYPE "ImportStagingDomain" ADD VALUE IF NOT EXISTS 'HISTORY';

ALTER TABLE "loss_entries"
  ADD COLUMN "film_shift_1_kg" DECIMAL(12, 3),
  ADD COLUMN "film_shift_2_kg" DECIMAL(12, 3),
  ADD COLUMN "box_loss_units" DECIMAL(12, 3),
  ADD COLUMN "box_loss_shift_1_units" DECIMAL(12, 3),
  ADD COLUMN "box_loss_shift_2_units" DECIMAL(12, 3),
  ADD CONSTRAINT "loss_entries_measurements_nonnegative" CHECK (
    "quantity_kg" >= 0
    AND ("film_shift_1_kg" IS NULL OR "film_shift_1_kg" >= 0)
    AND ("film_shift_2_kg" IS NULL OR "film_shift_2_kg" >= 0)
    AND ("box_loss_units" IS NULL OR ("box_loss_units" >= 0 AND "box_loss_units" = TRUNC("box_loss_units")))
    AND ("box_loss_shift_1_units" IS NULL OR ("box_loss_shift_1_units" >= 0 AND "box_loss_shift_1_units" = TRUNC("box_loss_shift_1_units")))
    AND ("box_loss_shift_2_units" IS NULL OR ("box_loss_shift_2_units" >= 0 AND "box_loss_shift_2_units" = TRUNC("box_loss_shift_2_units")))
  ),
  ADD CONSTRAINT "loss_entries_film_shifts_match_total" CHECK (
    ("film_shift_1_kg" IS NULL AND "film_shift_2_kg" IS NULL)
    OR (
      "film_shift_1_kg" IS NOT NULL
      AND "film_shift_2_kg" IS NOT NULL
      AND ABS("quantity_kg" - ("film_shift_1_kg" + "film_shift_2_kg")) <= 0.001
    )
  ),
  ADD CONSTRAINT "loss_entries_box_shifts_match_total" CHECK (
    ("box_loss_units" IS NULL AND "box_loss_shift_1_units" IS NULL AND "box_loss_shift_2_units" IS NULL)
    OR (
      "box_loss_units" IS NOT NULL
      AND "box_loss_shift_1_units" IS NOT NULL
      AND "box_loss_shift_2_units" IS NOT NULL
      AND ABS("box_loss_units" - ("box_loss_shift_1_units" + "box_loss_shift_2_units")) <= 0.001
    )
  );

COMMENT ON COLUMN "loss_entries"."quantity_kg" IS 'Perda de filme ou material mensurada em kg; nunca inclui caixas em unidades.';
COMMENT ON COLUMN "loss_entries"."box_loss_units" IS 'Perda de caixas preservada em unidades; nenhuma conversao implicita para kg.';

COMMIT;
