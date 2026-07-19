BEGIN;

-- Serialize every operational mutation with week closure. The trigger takes a
-- parent-row lock for the whole statement/transaction and rejects immutable
-- periods after a concurrent close commits.
CREATE OR REPLACE FUNCTION "nexus_assert_week_writable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_week_id uuid;
  target_status text;
  previous_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.week_id IS DISTINCT FROM NEW.week_id THEN
    -- Lock both periods in deterministic order. This prevents a move from
    -- escaping the snapshot of the old week while another request closes it.
    PERFORM 1
      FROM "weekly_periods"
     WHERE "id" IN (OLD.week_id, NEW.week_id)
     ORDER BY "id"
     FOR KEY SHARE;

    SELECT "status"::text INTO previous_status FROM "weekly_periods" WHERE "id" = OLD.week_id;
    SELECT "status"::text INTO target_status FROM "weekly_periods" WHERE "id" = NEW.week_id;

    IF previous_status IS NULL OR target_status IS NULL THEN
      RAISE EXCEPTION 'Semana operacional de origem ou destino não encontrada'
        USING ERRCODE = '23503';
    END IF;
    IF previous_status NOT IN ('OPEN', 'REVIEW') OR target_status NOT IN ('OPEN', 'REVIEW') THEN
      RAISE EXCEPTION 'Semanas de origem e destino precisam aceitar alterações operacionais'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_week_id := OLD.week_id;
  ELSE
    target_week_id := NEW.week_id;
  END IF;

  SELECT "status"::text
    INTO target_status
    FROM "weekly_periods"
   WHERE "id" = target_week_id
   FOR KEY SHARE;

  IF target_status IS NULL THEN
    RAISE EXCEPTION 'Semana operacional não encontrada: %', target_week_id
      USING ERRCODE = '23503';
  END IF;

  IF target_status NOT IN ('OPEN', 'REVIEW') THEN
    RAISE EXCEPTION 'Semana % está % e não aceita alterações operacionais', target_week_id, target_status
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "production_orders_week_writable"
  BEFORE INSERT OR UPDATE OR DELETE ON "production_orders"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_week_writable"();

CREATE TRIGGER "production_entries_week_writable"
  BEFORE INSERT OR UPDATE OR DELETE ON "production_entries"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_week_writable"();

CREATE TRIGGER "loss_entries_week_writable"
  BEFORE INSERT OR UPDATE OR DELETE ON "loss_entries"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_week_writable"();

CREATE TRIGGER "downtime_entries_week_writable"
  BEFORE INSERT OR UPDATE OR DELETE ON "downtime_entries"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_week_writable"();

CREATE TRIGGER "productivity_entries_week_writable"
  BEFORE INSERT OR UPDATE OR DELETE ON "productivity_entries"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_week_writable"();

CREATE TRIGGER "dosage_checks_week_writable"
  BEFORE INSERT OR UPDATE OR DELETE ON "dosage_checks"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_week_writable"();

COMMIT;
