"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { TraceabilityFields } from "@/components/forms/traceability-fields";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { EntryWorkflowActions } from "@/components/workflow/entry-workflow-actions";
import {
  createDemoEquipmentRows,
  createDemoShiftRows,
} from "@/lib/demo/admin-reference-preview";
import {
  demoWorkflowProducts,
  demoWorkflowWeek,
} from "@/lib/demo/workflow-preview";
import { operationalDateInputValue } from "@/lib/operational-date";
import type { WorkflowEntry } from "@/lib/operational-workflow";
import {
  traceabilityPayload,
  type EquipmentReference,
  type ShiftReference,
} from "@/lib/operational-traceability";
import { resolveExplicitWeekId } from "@/lib/week-selection";
import {
  apiGetClient,
  apiPostClient,
  DEMO_MODE,
  getSession,
} from "@/services/api";

interface Week {
  id: string;
  label: string;
  status: string;
}
interface Product {
  id: string;
  code: string;
  name: string;
  defaultSector?: { code: "P1" | "P2" };
  weightConfig?: { targetPackageWeightG: string | number } | null;
}
interface Check extends WorkflowEntry {
  id: string;
  date: string;
  sectorCode?: "P1" | "P2";
  sampleCount: number;
  averageWeightG: string | number;
  standardDeviationG: string | number;
  overweightG: string | number;
  product?: { code: string; name: string };
  equipment?: { code: string; name: string } | null;
  shift?: { code: string; name: string } | null;
}

export default function DosagePage() {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [equipment, setEquipment] = useState<EquipmentReference[]>([]);
  const [shifts, setShifts] = useState<ShiftReference[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [weekId, setWeekId] = useState("");
  const [productId, setProductId] = useState("");
  const [sector, setSector] = useState<"P1" | "P2">("P1");
  const [date, setDate] = useState(operationalDateInputValue());
  const [equipmentId, setEquipmentId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [samples, setSamples] = useState("");
  const [message, setMessage] = useState("Carregando referências de dosagem.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function load(nextWeek = weekId) {
    if (!session) return;
    setLoading(true);
    try {
      if (DEMO_MODE) {
        const demoProducts = demoWorkflowProducts as Product[];
        setWeeks([demoWorkflowWeek]);
        setProducts(demoProducts);
        setEquipment(createDemoEquipmentRows());
        setShifts(createDemoShiftRows());
        setWeekId(demoWorkflowWeek.id);
        setProductId(
          (current) =>
            current ||
            demoProducts.find(
              (product) => product.defaultSector?.code === sector,
            )?.id ||
            "",
        );
        setMessage(
          "Referências demonstrativas de dosagem carregadas localmente.",
        );
        return;
      }
      const [weekRows, productRows, equipmentRows, shiftRows] =
        await Promise.all([
          apiGetClient<Week[]>("/weeks"),
          apiGetClient<Product[]>("/products?active=true"),
          apiGetClient<EquipmentReference[]>("/equipment?active=true"),
          apiGetClient<ShiftReference[]>("/shifts?active=true"),
        ]);
      const selectedWeek = resolveExplicitWeekId(weekRows, nextWeek);
      const sectorProducts = productRows.filter(
        (product) => product.defaultSector?.code === sector,
      );
      setWeeks(weekRows);
      setProducts(productRows);
      setEquipment(equipmentRows);
      setShifts(shiftRows);
      setWeekId(selectedWeek);
      setProductId((current) => current || sectorProducts[0]?.id || "");
      if (selectedWeek) {
        setChecks(
          await apiGetClient<Check[]>(
            `/dosage?weekId=${encodeURIComponent(selectedWeek)}`,
          ),
        );
        setMessage("Amostras e referências carregadas.");
      } else {
        setChecks([]);
        setMessage(
          weekRows.length
            ? "Selecione uma semana para carregar as amostras."
            : "Nenhuma semana operacional cadastrada.",
        );
      }
    } catch (error) {
      setEquipment([]);
      setShifts([]);
      setMessage(
        error instanceof Error
          ? error.message
          : "Não foi possível carregar a dosagem.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load("");
  }, []);

  async function save() {
    const sampleWeightsG = samples
      .split(/[;,\s]+/)
      .filter(Boolean)
      .map((value) => Number(value.replace(",", ".")))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!session || !weekId || !productId || !sampleWeightsG.length) {
      setMessage("Informe semana, produto e pelo menos uma pesagem válida.");
      return;
    }
    setLoading(true);
    try {
      if (DEMO_MODE) {
        const selectedProduct = products.find(
          (product) => product.id === productId,
        );
        const selectedEquipment = equipment.find(
          (item) => item.id === equipmentId,
        );
        const selectedShift = shifts.find((item) => item.id === shiftId);
        const averageWeightG =
          sampleWeightsG.reduce((sum, value) => sum + value, 0) /
          sampleWeightsG.length;
        const variance =
          sampleWeightsG.reduce(
            (sum, value) => sum + (value - averageWeightG) ** 2,
            0,
          ) / sampleWeightsG.length;
        const target = Number(
          selectedProduct?.weightConfig?.targetPackageWeightG ?? averageWeightG,
        );
        setChecks((current) => [
          {
            id: `demo-dosage-${Date.now()}`,
            date: `${date}T00:00:00.000Z`,
            sectorCode: sector,
            sampleCount: sampleWeightsG.length,
            averageWeightG,
            standardDeviationG: Math.sqrt(variance),
            overweightG: Math.max(averageWeightG - target, 0),
            product: selectedProduct
              ? { code: selectedProduct.code, name: selectedProduct.name }
              : undefined,
            equipment: selectedEquipment
              ? { code: selectedEquipment.code, name: selectedEquipment.name }
              : null,
            shift: selectedShift
              ? { code: selectedShift.code, name: selectedShift.name }
              : null,
            workflowStatus: "DRAFT",
            version: 1,
          },
          ...current,
        ]);
        setSamples("");
        setMessage("Amostras demonstrativas salvas somente neste preview.");
        return;
      }
      await apiPostClient("/dosage", {
        weekId,
        productId,
        sector,
        ...traceabilityPayload({ equipmentId, shiftId }),
        date,
        sampleWeightsG,
      });
      setSamples("");
      await load(weekId);
      setMessage("Amostras salvas; média e desvio padrão calculados pela API.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Falha ao salvar amostras.",
      );
    } finally {
      setLoading(false);
    }
  }

  const average = checks.length
    ? checks.reduce((sum, check) => sum + Number(check.averageWeightG), 0) /
      checks.length
    : 0;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Controle de dosagem"
        description="Registre amostras individuais de peso para calcular média, desvio padrão e sobrepeso."
      />
      <Card className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Select
            label="Semana"
            value={weekId}
            onChange={(value) => {
              setWeekId(value);
              void load(value);
            }}
            options={weeks.map((week) => ({
              value: week.id,
              label: `${week.label} - ${week.status}`,
            }))}
          />
          <Select
            label="Setor"
            value={sector}
            onChange={(value) => {
              setSector(value as "P1" | "P2");
              setProductId("");
              setEquipmentId("");
            }}
            options={[
              { value: "P1", label: "P1" },
              { value: "P2", label: "P2" },
            ]}
          />
          <Select
            label="Produto"
            value={productId}
            onChange={setProductId}
            options={products
              .filter((product) => product.defaultSector?.code === sector)
              .map((product) => ({
                value: product.id,
                label: `${product.code} - ${product.name}`,
              }))}
          />
          <Input label="Data" value={date} onChange={setDate} type="date" />
          <TraceabilityFields
            sector={sector}
            equipment={equipment}
            shifts={shifts}
            equipmentId={equipmentId}
            shiftId={shiftId}
            onEquipmentChange={setEquipmentId}
            onShiftChange={setShiftId}
          />
          <label className="space-y-2 md:col-span-2">
            <span className="text-xs uppercase text-slate-400">
              Pesagens em gramas
            </span>
            <input
              className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm"
              value={samples}
              onChange={(event) => setSamples(event.target.value)}
              placeholder="Ex.: 410, 400, 398, 405"
            />
          </label>
        </div>
        <div className="flex gap-3">
          <Button onClick={save} disabled={loading}>
            <Save className="size-4" />
            Salvar amostras
          </Button>
          <Button
            className="border-slate-400/30 bg-white/5"
            onClick={() => load(weekId)}
            disabled={loading}
          >
            <RefreshCw className="size-4" />
            Atualizar
          </Button>
        </div>
        <p className="text-sm text-slate-300">{message}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Controles" value={String(checks.length)} />
        <StatCard
          label="Peso médio"
          value={`${average.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} g`}
        />
        <StatCard
          label="Amostras lançadas"
          value={String(
            checks.reduce((sum, check) => sum + check.sampleCount, 0),
          )}
        />
      </div>
      <DataTable
        title="Histórico de amostras"
        rows={checks.length ? checks.map((check) => ({
          Data: check.date.slice(0, 10),
          Setor: check.sectorCode ?? "-",
          Produto: check.product
            ? `${check.product.code} - ${check.product.name}`
            : "-",
          Equipamento: check.equipment
            ? `${check.equipment.code} - ${check.equipment.name}`
            : "-",
          Turno: check.shift
            ? `${check.shift.code} - ${check.shift.name}`
            : "-",
          Amostras: check.sampleCount,
          Média: `${Number(check.averageWeightG).toLocaleString("pt-BR")} g`,
          "Desvio padrão": `${Number(check.standardDeviationG).toLocaleString("pt-BR")} g`,
          Sobrepeso: `${Number(check.overweightG).toLocaleString("pt-BR")} g`,
          Fluxo: (
            <EntryWorkflowActions
              entry={check}
              resource="dosage"
              roles={session?.user.roles ?? []}
              actorId={session?.user.id}
              demo={DEMO_MODE}
              disabled={loading}
              onChanged={async (updated) => {
                if (DEMO_MODE) {
                  setChecks((current) => current.map((item) => item.id === updated.id ? updated : item));
                } else {
                  await load(weekId);
                }
              }}
              onReload={() => load(weekId)}
              onMessage={setMessage}
            />
          ),
        })) : [{
          Data: "-",
          Setor: "-",
          Produto: "Nenhum controle de dosagem carregado.",
          Equipamento: "-",
          Turno: "-",
          Amostras: 0,
          Média: "-",
          "Desvio padrão": "-",
          Sobrepeso: "-",
          Fluxo: <span>-</span>,
        }]}
      />
    </div>
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
        className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Selecione</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
function Input({
  label,
  value,
  onChange,
  type,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type: string;
}) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input
        type={type}
        className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
