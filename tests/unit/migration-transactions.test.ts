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
  "0019_loss_dimensions_and_source_quarantine",
  "0020_calculation_rule_governance",
  "0021_dosage_productivity_workflow",
  "0022_workflow_actor_foreign_keys"
];

describe("hardening migrations", () => {
  it.each(migrationNames)("wraps %s in an explicit PostgreSQL transaction", (name) => {
    const sql = readFileSync(join(__dirname, `../../prisma/migrations/${name}/migration.sql`), "utf8").trim();
    expect(sql.startsWith("BEGIN;"), `${name} must start with BEGIN`).toBe(true);
    expect(sql.endsWith("COMMIT;"), `${name} must end with COMMIT`).toBe(true);
  });

  it("backfills closed dosage/productivity history without leaving week guards disabled", () => {
    const sql = readFileSync(
      join(__dirname, "../../prisma/migrations/0021_dosage_productivity_workflow/migration.sql"),
      "utf8"
    );
    const dosageDisable = sql.indexOf('DISABLE TRIGGER "dosage_checks_week_writable"');
    const productivityDisable = sql.indexOf('DISABLE TRIGGER "productivity_entries_week_writable"');
    const dosageBackfill = sql.indexOf('UPDATE "dosage_checks"');
    const productivityBackfill = sql.indexOf('UPDATE "productivity_entries"');
    const dosageEnable = sql.indexOf('ENABLE TRIGGER "dosage_checks_week_writable"');
    const productivityEnable = sql.indexOf('ENABLE TRIGGER "productivity_entries_week_writable"');

    expect(dosageDisable).toBeGreaterThan(-1);
    expect(productivityDisable).toBeGreaterThan(-1);
    expect(dosageDisable).toBeLessThan(dosageBackfill);
    expect(productivityDisable).toBeLessThan(productivityBackfill);
    expect(dosageEnable).toBeGreaterThan(dosageBackfill);
    expect(productivityEnable).toBeGreaterThan(productivityBackfill);
    expect(sql.match(/DISABLE TRIGGER/g)).toHaveLength(2);
    expect(sql.match(/ENABLE TRIGGER/g)).toHaveLength(2);
  });
});
