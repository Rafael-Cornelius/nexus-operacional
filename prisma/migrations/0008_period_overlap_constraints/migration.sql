CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "weekly_periods" first_period
    JOIN "weekly_periods" second_period
      ON first_period.id < second_period.id
     AND first_period.deleted_at IS NULL
     AND second_period.deleted_at IS NULL
     AND daterange(first_period.starts_on, first_period.ends_on, '[]')
         && daterange(second_period.starts_on, second_period.ends_on, '[]')
  ) THEN
    RAISE EXCEPTION 'Existem semanas sobrepostas. Corrija os períodos antes de aplicar a restrição.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "product_price_periods" first_period
    JOIN "product_price_periods" second_period
      ON first_period.id < second_period.id
     AND first_period.product_id = second_period.product_id
     AND daterange(first_period.starts_on, COALESCE(first_period.ends_on, 'infinity'::date), '[]')
         && daterange(second_period.starts_on, COALESCE(second_period.ends_on, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'Existem vigências de preço sobrepostas. Corrija os períodos antes de aplicar a restrição.';
  END IF;
END $$;

ALTER TABLE "weekly_periods"
  ADD CONSTRAINT "weekly_periods_no_date_overlap"
  EXCLUDE USING gist (
    daterange("starts_on", "ends_on", '[]') WITH &&
  ) WHERE ("deleted_at" IS NULL);

ALTER TABLE "product_price_periods"
  ADD CONSTRAINT "product_price_periods_no_date_overlap"
  EXCLUDE USING gist (
    "product_id" WITH =,
    daterange("starts_on", COALESCE("ends_on", 'infinity'::date), '[]') WITH &&
  );
