import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { operationalDateInputValue } from "../../apps/web/lib/operational-date";
import {
  equipmentForOperationalScope,
  productionLinesForSector,
  traceabilityPayload,
  type EquipmentReference,
} from "../../apps/web/lib/operational-traceability";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

const equipment: EquipmentReference[] = [
  {
    id: "equipment-p1",
    productionLineId: "line-p1",
    code: "M1",
    name: "Máquina 1",
    productionLine: {
      id: "line-p1",
      code: "P1-L1",
      name: "Linha P1",
      sector: { code: "P1" },
    },
  },
  {
    id: "equipment-p2",
    productionLineId: "line-p2",
    code: "M2",
    name: "Máquina 2",
    productionLine: {
      id: "line-p2",
      code: "P2-L1",
      name: "Linha P2",
      sector: { code: "P2" },
    },
  },
];

describe("frontend operational traceability", () => {
  it("uses the Sao Paulo calendar date after 21h instead of the next UTC day", () => {
    expect(
      operationalDateInputValue(new Date("2026-08-02T00:30:00.000Z")),
    ).toBe("2026-08-01");
    expect(
      operationalDateInputValue(new Date("2026-08-02T03:00:00.000Z")),
    ).toBe("2026-08-02");
  });

  it("filters official equipment and lines by operational sector", () => {
    expect(
      productionLinesForSector(equipment, "P1").map((line) => line.id),
    ).toEqual(["line-p1"]);
    expect(
      equipmentForOperationalScope(equipment, "P2").map((item) => item.id),
    ).toEqual(["equipment-p2"]);
    expect(equipmentForOperationalScope(equipment, "P1", "line-p2")).toEqual(
      [],
    );
  });

  it("sends only selected IDs accepted by each API contract", () => {
    expect(
      traceabilityPayload({
        lineId: "line-p1",
        equipmentId: "equipment-p1",
        shiftId: "shift-1",
      }),
    ).toEqual({
      lineId: "line-p1",
      equipmentId: "equipment-p1",
      shiftId: "shift-1",
    });
    expect(
      traceabilityPayload({ equipmentId: "equipment-p1", shiftId: "" }),
    ).toEqual({ equipmentId: "equipment-p1" });
  });

  it("loads and submits traceability in every daily operational form", () => {
    const files = [
      "apps/web/components/forms/production-form.tsx",
      "apps/web/app/perdas/page.tsx",
      "apps/web/app/paradas/page.tsx",
      "apps/web/app/dosagem/page.tsx",
    ];

    for (const file of files) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      expect(source, file).toContain("TraceabilityFields");
      expect(source, file).toContain('"/equipment?active=true"');
      expect(source, file).toContain('"/shifts?active=true"');
      expect(source, file).toContain("traceabilityPayload({");
      expect(source, file).toContain("operationalDateInputValue()");
      expect(source, file).not.toContain(
        "new Date().toISOString().slice(0, 10)",
      );
    }
  });
});
