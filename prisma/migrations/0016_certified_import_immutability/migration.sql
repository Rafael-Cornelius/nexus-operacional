BEGIN;

-- Certifications created before the full evidence/hash contract are preserved
-- explicitly, never silently upgraded to the new certification semantics.
UPDATE "import_batches"
   SET "status" = 'LEGACY_CERTIFIED'
 WHERE "status" = 'CERTIFIED';

-- A certified import is evidence. Mutations take a lock on every referenced
-- batch, serialize with certification, and reject changes after certification.
CREATE OR REPLACE FUNCTION "nexus_assert_import_batch_mutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reference_column text := TG_ARGV[0];
  old_batch_id uuid;
  new_batch_id uuid;
  batch_record record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_batch_id := NULLIF(to_jsonb(OLD) ->> reference_column, '')::uuid;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_batch_id := NULLIF(to_jsonb(NEW) ->> reference_column, '')::uuid;
  END IF;

  FOR batch_record IN
    SELECT "id", "status"::text AS status
      FROM "import_batches"
     WHERE "id" IN (old_batch_id, new_batch_id)
     ORDER BY "id"
     FOR KEY SHARE
  LOOP
    IF batch_record.status IN ('CERTIFIED', 'LEGACY_CERTIFIED') THEN
      RAISE EXCEPTION 'Lote certificado % é imutável', batch_record.id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "nexus_assert_certified_batch_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status"::text IN ('CERTIFIED', 'LEGACY_CERTIFIED') THEN
    RAISE EXCEPTION 'Lote certificado % é imutável', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "production_entries_import_batch_mutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "production_entries"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_import_batch_mutable"('import_batch_id');

CREATE TRIGGER "loss_entries_import_batch_mutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "loss_entries"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_import_batch_mutable"('import_batch_id');

CREATE TRIGGER "downtime_entries_import_batch_mutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "downtime_entries"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_import_batch_mutable"('import_batch_id');

CREATE TRIGGER "import_staging_records_batch_mutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "import_staging_records"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_import_batch_mutable"('batch_id');

CREATE TRIGGER "import_errors_batch_mutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "import_errors"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_import_batch_mutable"('batch_id');

CREATE TRIGGER "import_batches_certified_immutable"
  BEFORE UPDATE OR DELETE ON "import_batches"
  FOR EACH ROW EXECUTE FUNCTION "nexus_assert_certified_batch_immutable"();

COMMIT;
