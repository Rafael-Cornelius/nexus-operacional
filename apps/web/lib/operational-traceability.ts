export interface ProductionLineReference {
  id: string;
  code: string;
  name: string;
  sector?: { code: "P1" | "P2"; name?: string };
}

export interface EquipmentReference {
  id: string;
  productionLineId: string;
  code: string;
  name: string;
  active?: boolean;
  productionLine?: ProductionLineReference;
}

export interface ShiftReference {
  id: string;
  code: string;
  name: string;
  startsAt?: string;
  endsAt?: string;
  active?: boolean;
}

export interface TraceabilitySelection {
  lineId?: string;
  equipmentId?: string;
  shiftId?: string;
}

export function productionLinesForSector(
  equipment: EquipmentReference[],
  sector: "P1" | "P2",
) {
  const lines = equipment.flatMap((item) => {
    const line = item.productionLine;
    return line?.sector?.code === sector ? [line] : [];
  });

  return Array.from(new Map(lines.map((line) => [line.id, line])).values());
}

export function equipmentForOperationalScope(
  equipment: EquipmentReference[],
  sector: "P1" | "P2",
  lineId?: string,
) {
  return equipment.filter(
    (item) =>
      item.productionLine?.sector?.code === sector &&
      (!lineId || item.productionLineId === lineId),
  );
}

export function traceabilityPayload(selection: TraceabilitySelection) {
  return {
    ...(selection.lineId ? { lineId: selection.lineId } : {}),
    ...(selection.equipmentId ? { equipmentId: selection.equipmentId } : {}),
    ...(selection.shiftId ? { shiftId: selection.shiftId } : {}),
  };
}
