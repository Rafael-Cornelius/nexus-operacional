import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(__dirname, "../../prisma/migrations/0022_workflow_actor_foreign_keys/migration.sql"),
  "utf8"
);
const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");

const actors = [
  { column: "submitted_by", field: "submittedBy", role: "Submitter" },
  { column: "approved_by", field: "approvedBy", role: "Approver" },
  { column: "rejected_by", field: "rejectedBy", role: "Rejector" },
  { column: "created_by", field: "createdBy", role: "Creator" },
  { column: "updated_by", field: "updatedBy", role: "Updater" }
] as const;

const tables = [
  { table: "production_entries", model: "ProductionEntry" },
  { table: "loss_entries", model: "LossEntry" },
  { table: "downtime_entries", model: "DowntimeEntry" },
  { table: "dosage_checks", model: "DosageCheck" },
  { table: "productivity_entries", model: "ProductivityEntry" }
] as const;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("workflow actor foreign keys", () => {
  it("adds every actor foreign key as NOT VALID while enforcing future writes", () => {
    for (const { table } of tables) {
      for (const { column } of actors) {
        const constraint = `${table}_${column}_fkey`;
        expect(migration).toMatch(
          new RegExp(
            `ADD CONSTRAINT "${escapeRegex(constraint)}"\\s+` +
              `FOREIGN KEY \\(\\"${escapeRegex(column)}\\"\\) REFERENCES \\"users\\"\\(\\"id\\"\\) ` +
              "ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID"
          )
        );
      }
    }

    expect(migration.match(/ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID/g)).toHaveLength(
      tables.length * actors.length
    );
  });

  it("validates a table only inside its no-orphan guard", () => {
    const blocks = [...migration.matchAll(/DO \$validation\$\s*BEGIN([\s\S]*?)END\s*\$validation\$;/g)].map(
      (match) => match[1]
    );

    expect(blocks).toHaveLength(tables.length);
    for (const { table } of tables) {
      const block = blocks.find((candidate) => candidate.includes(`FROM "${table}" AS entry`));
      expect(block, `${table} must have a conditional validation block`).toBeDefined();
      expect(block).toContain("IF NOT EXISTS (");

      for (const { column } of actors) {
        expect(block).toContain(`entry."${column}" IS NOT NULL`);
        expect(block).toContain(`actor."id" = entry."${column}"`);
        expect(block).toContain(
          `ALTER TABLE "${table}" VALIDATE CONSTRAINT "${table}_${column}_fkey";`
        );
      }
    }

    expect(migration.match(/VALIDATE CONSTRAINT/g)).toHaveLength(tables.length * actors.length);
  });

  it("maps every actor UUID to a named User relation in Prisma", () => {
    for (const { model } of tables) {
      for (const { field, role } of actors) {
        const relation = `${model}${role}`;
        const relationOccurrences = schema.match(new RegExp(`@relation\\("${relation}"`, "g")) ?? [];
        expect(relationOccurrences, `${relation} must exist on both relation sides`).toHaveLength(2);
        expect(schema).toMatch(
          new RegExp(
            `User\\?\\s+@relation\\("${relation}", fields: \\[${field}\\], references: \\[id\\], onDelete: Restrict\\)`
          )
        );
      }
    }
  });
});
