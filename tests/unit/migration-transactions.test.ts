import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationNames = [
  "0012_import_staging",
  "0013_week_close_concurrency",
  "0014_calculation_rule_versions",
  "0015_downtime_overlap_constraints",
  "0016_certified_import_immutability",
  "0017_goal_governance",
  "0018_product_price_governance",
  "0019_loss_dimensions_and_source_quarantine"
];

describe("hardening migrations", () => {
  it.each(migrationNames)("wraps %s in an explicit PostgreSQL transaction", (name) => {
    const sql = readFileSync(join(__dirname, `../../prisma/migrations/${name}/migration.sql`), "utf8").trim();
    expect(sql.startsWith("BEGIN;"), `${name} must start with BEGIN`).toBe(true);
    expect(sql.endsWith("COMMIT;"), `${name} must end with COMMIT`).toBe(true);
  });
});
