import { describe, expect, it, vi } from "vitest";
import { EquipmentService } from "../../apps/api/src/modules/equipment/equipment.service";
import { ShiftsService } from "../../apps/api/src/modules/shifts/shifts.service";
import { dosageCheckSchema, downtimeEntrySchema, lossEntrySchema, productionEntrySchema } from "../../apps/api/src/domain/validators/schemas";

describe("equipment and shifts", () => {
  it("accepts equipment and shift lineage in every supported operational payload", () => {
    const equipmentId = "11111111-1111-4111-8111-111111111111";
    const shiftId = "22222222-2222-4222-8222-222222222222";
    const common = { equipmentId, shiftId };

    expect(productionEntrySchema.partial().parse(common)).toEqual(common);
    expect(lossEntrySchema.partial().parse(common)).toEqual(common);
    expect(downtimeEntrySchema.partial().parse(common)).toEqual(common);
    expect(dosageCheckSchema.partial().parse(common)).toEqual(common);
  });

  it("creates equipment only on an active production line", async () => {
    const lineId = "9d0b2bf5-f0a4-4e87-a919-12ce7bbd78d8";
    const created = { id: "equipment-1", productionLineId: lineId, code: "M1", name: "Máquina 1" };
    const prisma = {
      productionLine: { findUnique: vi.fn().mockResolvedValue({ id: lineId, active: true, deletedAt: null }) },
      equipment: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created)
      }
    };
    const audit = { record: vi.fn() };
    const service = new EquipmentService(prisma as never, audit as never);

    await expect(service.create({ productionLineId: lineId, code: "m1", name: "Máquina 1" })).resolves.toEqual(created);
    expect(prisma.equipment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ code: "M1" }) }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ module: "equipment", action: "create" }));
  });

  it("rejects equipment assigned to an inactive production line", async () => {
    const lineId = "b1f0c8b2-2fed-4623-a457-f6fcbe3ef349";
    const prisma = {
      productionLine: { findUnique: vi.fn().mockResolvedValue({ id: lineId, active: false, deletedAt: null }) },
      equipment: { findUnique: vi.fn(), create: vi.fn() }
    };
    const service = new EquipmentService(prisma as never, { record: vi.fn() } as never);

    await expect(service.create({ productionLineId: lineId, code: "M1", name: "Máquina 1" })).rejects.toThrow("Linha de producao ativa");
    expect(prisma.equipment.create).not.toHaveBeenCalled();
  });

  it("normalizes shift codes and returns HH:mm times", async () => {
    const shift = {
      id: "shift-1",
      code: "T1",
      name: "Turno 1",
      startsAt: new Date("1970-01-01T06:00:00.000Z"),
      endsAt: new Date("1970-01-01T14:00:00.000Z"),
      active: true,
      deletedAt: null
    };
    const prisma = {
      shift: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(shift)
      }
    };
    const service = new ShiftsService(prisma as never, { record: vi.fn() } as never);

    await expect(service.create({ code: "t1", name: "Turno 1", startsAt: "06:00", endsAt: "14:00" })).resolves.toMatchObject({
      code: "T1",
      startsAt: "06:00",
      endsAt: "14:00"
    });
  });

  it("rejects invalid shift time strings before database access", async () => {
    const prisma = { shift: { findUnique: vi.fn(), create: vi.fn() } };
    const service = new ShiftsService(prisma as never, { record: vi.fn() } as never);

    await expect(service.create({ code: "T1", name: "Turno 1", startsAt: "25:00", endsAt: "14:00" })).rejects.toThrow();
    expect(prisma.shift.create).not.toHaveBeenCalled();
  });
});
