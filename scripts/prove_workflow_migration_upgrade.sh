#!/usr/bin/env bash
set -euo pipefail

: "${MIGRATION_UPGRADE_DATABASE_URL:?MIGRATION_UPGRADE_DATABASE_URL obrigatoria}"

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migrations_root="$repository_root/prisma/migrations"

while IFS= read -r migration_file; do
  migration_name="$(basename "$(dirname "$migration_file")")"
  if [[ "$migration_name" == "0021_dosage_productivity_workflow" ]]; then
    break
  fi
  psql "$MIGRATION_UPGRADE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$migration_file" >/dev/null
done < <(find "$migrations_root" -mindepth 2 -maxdepth 2 -name migration.sql -print | sort)

psql "$MIGRATION_UPGRADE_DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO "sectors" ("id", "code", "name", "updated_at")
VALUES ('10000000-0000-4000-8000-000000000001', 'P1', 'Setor histórico', NOW());

INSERT INTO "products" ("id", "code", "name", "default_sector_id", "updated_at")
VALUES (
  '10000000-0000-4000-8000-000000000002',
  'HIST-001',
  'Produto histórico',
  '10000000-0000-4000-8000-000000000001',
  NOW()
);

INSERT INTO "weekly_periods" (
  "id", "year", "month", "week_number", "label", "starts_on", "ends_on", "updated_at"
) VALUES (
  '10000000-0000-4000-8000-000000000003',
  2026,
  5,
  1,
  'Histórico fechado',
  DATE '2026-05-04',
  DATE '2026-05-10',
  NOW()
);

INSERT INTO "dosage_checks" (
  "id", "week_id", "product_id", "sector_code", "date", "target_weight_g",
  "sample_weights_g", "sample_count", "average_weight_g", "standard_deviation_g",
  "overweight_g", "updated_at"
) VALUES (
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000002',
  'P1',
  DATE '2026-05-05',
  1000,
  '[1000]'::jsonb,
  1,
  1000,
  0,
  0,
  NOW()
);

INSERT INTO "productivity_entries" (
  "id", "week_id", "sector_code", "date", "produced_kg", "productive_hours",
  "kg_per_hour", "updated_at"
) VALUES (
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000003',
  'P1',
  DATE '2026-05-05',
  100,
  2,
  50,
  NOW()
);

UPDATE "weekly_periods"
SET "status" = 'CLOSED', "closed_at" = NOW(), "updated_at" = NOW()
WHERE "id" = '10000000-0000-4000-8000-000000000003';
SQL

psql "$MIGRATION_UPGRADE_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f "$migrations_root/0021_dosage_productivity_workflow/migration.sql" >/dev/null

proof="$({ psql "$MIGRATION_UPGRADE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT
  (SELECT "workflow_status"::text FROM "dosage_checks" WHERE "id" = '10000000-0000-4000-8000-000000000004')
  || '|' ||
  (SELECT "workflow_status"::text FROM "productivity_entries" WHERE "id" = '10000000-0000-4000-8000-000000000005')
  || '|' ||
  (SELECT COUNT(*)::text
     FROM pg_trigger
    WHERE tgname IN ('dosage_checks_week_writable', 'productivity_entries_week_writable')
      AND tgenabled = 'O');
SQL
} | tr -d '[:space:]')"

if [[ "$proof" != "UNDER_REVIEW|UNDER_REVIEW|2" ]]; then
  echo "Prova de upgrade falhou: $proof" >&2
  exit 1
fi

echo "WORKFLOW_MIGRATION_UPGRADE_PROOF_PASSED"
