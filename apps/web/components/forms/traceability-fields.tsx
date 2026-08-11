import {
  equipmentForOperationalScope,
  productionLinesForSector,
  type EquipmentReference,
  type ShiftReference,
} from "@/lib/operational-traceability";

interface TraceabilityFieldsProps {
  sector: "P1" | "P2";
  equipment: EquipmentReference[];
  shifts: ShiftReference[];
  equipmentId: string;
  shiftId: string;
  onEquipmentChange: (value: string) => void;
  onShiftChange: (value: string) => void;
  lineId?: string;
  onLineChange?: (value: string) => void;
}

export function TraceabilityFields({
  sector,
  equipment,
  shifts,
  equipmentId,
  shiftId,
  onEquipmentChange,
  onShiftChange,
  lineId,
  onLineChange,
}: TraceabilityFieldsProps) {
  const showsLine = lineId !== undefined && Boolean(onLineChange);
  const lines = productionLinesForSector(equipment, sector);
  const availableEquipment = equipmentForOperationalScope(
    equipment,
    sector,
    lineId,
  );

  function changeLine(value: string) {
    onLineChange?.(value);
    const currentEquipment = equipment.find((item) => item.id === equipmentId);
    if (currentEquipment && currentEquipment.productionLineId !== value)
      onEquipmentChange("");
  }

  function changeEquipment(value: string) {
    const selected = equipment.find((item) => item.id === value);
    if (selected && onLineChange) onLineChange(selected.productionLineId);
    onEquipmentChange(value);
  }

  return (
    <>
      {showsLine ? (
        <Select
          label="Linha de produção"
          value={lineId ?? ""}
          onChange={changeLine}
          options={lines.map((line) => ({
            value: line.id,
            label: `${line.code} - ${line.name}`,
          }))}
        />
      ) : null}
      <Select
        label="Equipamento"
        value={equipmentId}
        onChange={changeEquipment}
        options={availableEquipment.map((item) => ({
          value: item.id,
          label: `${item.code} - ${item.name}`,
        }))}
      />
      <Select
        label="Turno"
        value={shiftId}
        onChange={onShiftChange}
        options={shifts.map((shift) => ({
          value: shift.id,
          label: `${shift.code} - ${shift.name}${shift.startsAt && shift.endsAt ? ` (${shift.startsAt}-${shift.endsAt})` : ""}`,
        }))}
      />
    </>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <select
        className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm outline-none focus:border-cyan-300/60"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Não informado</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
