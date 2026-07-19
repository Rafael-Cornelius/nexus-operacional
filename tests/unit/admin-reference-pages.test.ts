import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canDeactivateReference, canManageEquipment, canManageShifts, isUuid } from "../../apps/web/lib/admin-reference-permissions";
import { createDemoEquipmentRows, createDemoShiftRows } from "../../apps/web/lib/demo/admin-reference-preview";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

describe("equipment and shift administration pages", () => {
  it("matches the API role boundaries", () => {
    expect(canManageEquipment(["SUPERVISOR"])).toBe(true);
    expect(canManageEquipment(["VIEWER"])).toBe(false);
    expect(canManageShifts(["MANAGER"])).toBe(true);
    expect(canManageShifts(["SUPERVISOR"])).toBe(false);
    expect(canDeactivateReference(["ADMIN"])).toBe(true);
    expect(canDeactivateReference(["MANAGER"])).toBe(false);
  });

  it("validates real UUIDs for equipment production lines", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("linha-p1")).toBe(false);
  });

  it("returns isolated preview fixtures for each page load", () => {
    const firstEquipment = createDemoEquipmentRows();
    const secondEquipment = createDemoEquipmentRows();
    firstEquipment[0]!.name = "Alterado no teste";
    firstEquipment[0]!.productionLine.name = "Linha alterada";

    expect(secondEquipment[0]!.name).not.toBe("Alterado no teste");
    expect(secondEquipment[0]!.productionLine.name).not.toBe("Linha alterada");
    expect(createDemoShiftRows()).toHaveLength(2);
  });

  it("ships both routes with list, create, edit and deactivate contracts", () => {
    const equipmentPath = join(repoRoot, "apps/web/app/equipamentos/page.tsx");
    const shiftsPath = join(repoRoot, "apps/web/app/turnos/page.tsx");
    expect(existsSync(equipmentPath)).toBe(true);
    expect(existsSync(shiftsPath)).toBe(true);

    const equipment = readFileSync(equipmentPath, "utf-8");
    const shifts = readFileSync(shiftsPath, "utf-8");
    expect(equipment).toContain('apiGetClient<EquipmentRow[]>("/equipment")');
    expect(equipment).toContain('apiPostClient("/equipment", payload)');
    expect(equipment).toContain("apiPatchClient(`/equipment/${editingId}`, payload)");
    expect(equipment).toContain("apiDeleteClient(`/equipment/${row.id}`)");
    expect(equipment).toContain("UUID real da linha");
    expect(shifts).toContain('apiGetClient<ShiftRow[]>("/shifts")');
    expect(shifts).toContain('apiPostClient("/shifts", payload)');
    expect(shifts).toContain("apiPatchClient(`/shifts/${editingId}`, payload)");
    expect(shifts).toContain("apiDeleteClient(`/shifts/${row.id}`)");
  });

  it("integrates both pages into role-filtered navigation", () => {
    const navigation = readFileSync(join(repoRoot, "apps/web/lib/navigation.ts"), "utf-8");
    expect(navigation).toContain('href: "/equipamentos"');
    expect(navigation).toContain('href: "/turnos"');
  });
});
