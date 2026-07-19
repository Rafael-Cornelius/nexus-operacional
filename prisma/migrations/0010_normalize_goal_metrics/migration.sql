UPDATE "goals"
SET "metric" = 'yield'
WHERE LOWER(BTRIM("metric")) IN ('yield', 'yield_percent');

UPDATE "goals"
SET "metric" = 'overweight'
WHERE LOWER(BTRIM("metric")) IN ('overweight', 'overweight_percent');

UPDATE "goals"
SET "metric" = 'losses_kg'
WHERE LOWER(BTRIM("metric")) IN ('losses_kg', 'loss_kg', 'loss');

UPDATE "goals"
SET "metric" = 'downtime_minutes'
WHERE LOWER(BTRIM("metric")) IN ('downtime_minutes', 'stopped_minutes', 'downtime');

UPDATE "goals"
SET "metric" = 'produced_kg'
WHERE LOWER(BTRIM("metric")) IN ('produced_kg', 'production_kg');
