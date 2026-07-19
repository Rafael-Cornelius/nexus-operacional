const p1Line = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "P1-L1",
  name: "Linha principal P1",
  sector: { code: "P1", name: "Produção P1" }
};

const p2Line = {
  id: "22222222-2222-4222-8222-222222222222",
  code: "P2-L1",
  name: "Linha principal P2",
  sector: { code: "P2", name: "Produção P2" }
};

const equipmentPreview = [
  { id: "31111111-1111-4111-8111-111111111111", productionLineId: p1Line.id, code: "EMB-P1", name: "Embaladora P1", type: "Embaladora", active: true, productionLine: p1Line },
  { id: "32222222-2222-4222-8222-222222222222", productionLineId: p2Line.id, code: "DOS-P2", name: "Dosador P2", type: "Dosador", active: true, productionLine: p2Line }
];

const shiftPreview = [
  { id: "41111111-1111-4111-8111-111111111111", code: "T1", name: "Primeiro turno", startsAt: "06:00", endsAt: "14:00", active: true },
  { id: "42222222-2222-4222-8222-222222222222", code: "T2", name: "Segundo turno", startsAt: "14:00", endsAt: "22:00", active: true }
];

export function createDemoEquipmentRows() {
  return equipmentPreview.map((equipment) => ({
    ...equipment,
    productionLine: {
      ...equipment.productionLine,
      sector: { ...equipment.productionLine.sector }
    }
  }));
}

export function createDemoShiftRows() {
  return shiftPreview.map((shift) => ({ ...shift }));
}
