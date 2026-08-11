BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- New/updated rows must identify a resource. Existing legacy gaps remain
-- visible for cleanup instead of receiving an invented line or equipment.
ALTER TABLE "downtime_entries"
  ADD CONSTRAINT "downtime_entries_resource_required"
  CHECK ("deleted_at" IS NOT NULL OR "line_id" IS NOT NULL OR "equipment_id" IS NOT NULL) NOT VALID;

-- Refuse deployment when active historical data already violates the same
-- resource semantics enforced below. Soft-deleted rows remain preserved and
-- intentionally do not participate in overlap detection.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "downtime_entries" first_entry
      JOIN "downtime_entries" second_entry
        ON first_entry.id < second_entry.id
       AND first_entry.deleted_at IS NULL
       AND second_entry.deleted_at IS NULL
       AND tsrange(first_entry.downtime_start, first_entry.downtime_end, '[)')
           && tsrange(second_entry.downtime_start, second_entry.downtime_end, '[)')
       AND (
         (
           first_entry.equipment_id IS NOT NULL
           AND first_entry.equipment_id = second_entry.equipment_id
         )
         OR
         (
           first_entry.equipment_id IS NULL
           AND second_entry.equipment_id IS NULL
           AND first_entry.line_id IS NOT NULL
           AND first_entry.line_id = second_entry.line_id
         )
       )
  ) THEN
    RAISE EXCEPTION 'Existem paradas ativas sobrepostas para o mesmo equipamento ou linha sem equipamento. Corrija os intervalos antes de aplicar a restrição.';
  END IF;
END $$;

-- Equipment is the most precise resource. Entries on the same line may run in
-- parallel when they refer to different equipment.
ALTER TABLE "downtime_entries"
  ADD CONSTRAINT "downtime_entries_no_equipment_overlap"
  EXCLUDE USING gist (
    "equipment_id" WITH =,
    tsrange("downtime_start", "downtime_end", '[)') WITH &&
  ) WHERE (
    "deleted_at" IS NULL
    AND "equipment_id" IS NOT NULL
  );

-- Legacy/manual entries without equipment fall back to their production line.
ALTER TABLE "downtime_entries"
  ADD CONSTRAINT "downtime_entries_no_line_overlap_without_equipment"
  EXCLUDE USING gist (
    "line_id" WITH =,
    tsrange("downtime_start", "downtime_end", '[)') WITH &&
  ) WHERE (
    "deleted_at" IS NULL
    AND "equipment_id" IS NULL
    AND "line_id" IS NOT NULL
  );

COMMIT;
