"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { TraceabilityFields } from "@/components/forms/traceability-fields";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { EntryWorkflowActions } from "@/components/workflow/entry-workflow-actions";
import { createDemoEquipmentRows, createDemoShiftRows } from "@/lib/demo/admin-reference-preview";
import { demoDashboardAlerts } from "@/lib/demo/operational-preview";
import { createDemoProductionEntries, demoWorkflowWeek } from "@/lib/demo/workflow-preview";
import { formatKg, formatPercent } from "@/lib/format";
import { operationalDateInputValue } from "@/lib/operational-date";
import { goalVisualState, type OperationalGoalAlert } from "@/lib/operational-goals";
import type { WorkflowEntry } from "@/lib/operational-workflow";
import {
  traceabilityPayload,
  type EquipmentReference,
  type ShiftReference,
} from "@/lib/operational-traceability";
import { resolveExplicitWeekId } from "@/lib/week-selection";
import { apiGetClient, apiPostClient, DEMO_MODE, getSession } from "@/services/api";

interface WeekRow {
  id: string;
  label: string;
  status: string;
}

interface DailyProductivityRow {
  date: string;
  producedKg: number;
  averageYield: number;
}

interface ProductivitySummary {
  source: "CALCULATED_FROM_APPROVED_PRODUCTION";
  sourceDescription: string;
  producedKg: number;
  averageYield: number;
  workedDays: number;
  averageKgPerDay: number;
  records: number;
  daily: DailyProductivityRow[];
}

interface ProductivityEntryRow extends WorkflowEntry {
  id: string;
  date: string;
  sectorCode: "P1" | "P2";
  producedKg: string | number;
  productiveHours: string | number;
  kgPerHour: string | number;
  dataSource: "INFORMED_MANUALLY" | "LEGACY_UNVERIFIED";
  equipment?: { code: string; name: string } | null;
  shift?: { code: string; name: string } | null;
  notes?: string | null;
}

const emptySummary: ProductivitySummary = {
  source: "CALCULATED_FROM_APPROVED_PRODUCTION",
  sourceDescription: "Calculado somente a partir de lançamentos de produção aprovados; apontamentos informados não substituem estes indicadores.",
  producedKg: 0,
  averageYield: 0,
  workedDays: 0,
  averageKgPerDay: 0,
  records: 0,
  daily: [],
};

function demoSummary(): ProductivitySummary {
  const approved = ([...createDemoProductionEntries("P1"), ...createDemoProductionEntries("P2")] as Array<{
    date: string;
    producedKg: number;
    realYieldPercent: number;
    workflowStatus: string;
  }>).filter((entry) => entry.workflowStatus === "APPROVED");
  const producedKg = approved.reduce((sum, row) => sum + row.producedKg, 0);
  const grouped = new Map<string, { date: string; producedKg: number; yieldTotal: number; records: number }>();
  for (const row of approved) {
    const key = row.date.slice(0, 10);
    const current = grouped.get(key) ?? { date: row.date, producedKg: 0, yieldTotal: 0, records: 0 };
    current.producedKg += row.producedKg;
    current.yieldTotal += row.realYieldPercent;
    current.records += 1;
    grouped.set(key, current);
  }
  const daily = Array.from(grouped.values()).map((row) => ({
    date: row.date,
    producedKg: row.producedKg,
    averageYield: row.yieldTotal / row.records,
  }));
  return {
    ...emptySummary,
    producedKg,
    averageYield: approved.length ? approved.reduce((sum, row) => sum + row.realYieldPercent, 0) / approved.length : 0,
    workedDays: daily.length,
    averageKgPerDay: daily.length ? producedKg / daily.length : 0,
    records: approved.length,
    daily,
  };
}

export default function ProductivityPage() {
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [equipment, setEquipment] = useState<EquipmentReference[]>([]);
  const [shifts, setShifts] = useState<ShiftReference[]>([]);
  const [weekId, setWeekId] = useState("");
  const [summary, setSummary] = useState<ProductivitySummary>(emptySummary);
  const [entries, setEntries] = useState<ProductivityEntryRow[]>([]);
  const [alerts, setAlerts] = useState<OperationalGoalAlert[]>([]);
  const [sector, setSector] = useState<"P1" | "P2">("P1");
  const [date, setDate] = useState(operationalDateInputValue());
  const [equipmentId, setEquipmentId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [producedKg, setProducedKg] = useState(0);
  const [productiveHours, setProductiveHours] = useState(8);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("Carregando produtividade.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadData(nextWeekId = weekId) {
    if (!session) return;
    setLoading(true);
    try {
      if (DEMO_MODE) {
        setWeeks([demoWorkflowWeek]);
        setWeekId(demoWorkflowWeek.id);
        setEquipment(createDemoEquipmentRows());
        setShifts(createDemoShiftRows());
        setSummary(demoSummary());
        setAlerts(demoDashboardAlerts);
        setMessage("Indicadores automáticos demonstrativos carregados. Apontamentos manuais ficam separados.");
        return;
      }
      const [weekRows, equipmentRows, shiftRows] = await Promise.all([
        apiGetClient<WeekRow[]>("/weeks"),
        apiGetClient<EquipmentReference[]>("/equipment?active=true"),
        apiGetClient<ShiftReference[]>("/shifts?active=true"),
      ]);
      const selectedWeek = resolveExplicitWeekId(weekRows, nextWeekId);
      setWeeks(weekRows);
      setEquipment(equipmentRows);
      setShifts(shiftRows);
      setWeekId(selectedWeek);
      if (!selectedWeek) {
        setSummary(emptySummary);
        setEntries([]);
        setAlerts([]);
        setMessage(weekRows.length ? "Selecione uma semana." : "Nenhuma semana operacional cadastrada.");
        return;
      }
      const query = `?weekId=${encodeURIComponent(selectedWeek)}`;
      const [data, informedEntries, nextAlerts] = await Promise.all([
        apiGetClient<ProductivitySummary>(`/productivity/summary${query}`),
        apiGetClient<ProductivityEntryRow[]>(`/productivity${query}`),
        apiGetClient<OperationalGoalAlert[]>(`/dashboard/alerts${query}`),
      ]);
      setSummary(data);
      setEntries(informedEntries);
      setAlerts(nextAlerts);
      setMessage("Indicadores automáticos e apontamentos informados carregados separadamente.");
    } catch (error) {
      setSummary(emptySummary);
      setEntries([]);
      setAlerts([]);
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar produtividade.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData("");
  }, []);

  async function saveEntry() {
    if (!session || !weekId || producedKg < 0 || productiveHours <= 0) {
      setMessage("Informe semana, produção não negativa e horas produtivas maiores que zero.");
      return;
    }
    setLoading(true);
    try {
      if (DEMO_MODE) {
        const selectedEquipment = equipment.find((item) => item.id === equipmentId);
        const selectedShift = shifts.find((item) => item.id === shiftId);
        const entry: ProductivityEntryRow = {
          id: `demo-productivity-${Date.now()}`,
          date: `${date}T00:00:00.000Z`,
          sectorCode: sector,
          producedKg,
          productiveHours,
          kgPerHour: producedKg / productiveHours,
          dataSource: "INFORMED_MANUALLY",
          equipment: selectedEquipment ? { code: selectedEquipment.code, name: selectedEquipment.name } : null,
          shift: selectedShift ? { code: selectedShift.code, name: selectedShift.name } : null,
          notes: notes || null,
          workflowStatus: "DRAFT",
          version: 1,
        };
        setEntries((current) => [entry, ...current]);
        setMessage("Apontamento informado criado só neste preview. Indicadores automáticos não foram alterados.");
        return;
      }
      await apiPostClient("/productivity", {
        weekId,
        sector,
        ...traceabilityPayload({ equipmentId, shiftId }),
        date,
        producedKg,
        productiveHours,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setNotes("");
      await loadData(weekId);
      setMessage("Apontamento informado salvo como rascunho; indicadores automáticos permanecem separados.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar produtividade.");
    } finally {
      setLoading(false);
    }
  }

  const productionGoal = goalVisualState(alerts, ["produced_kg"], formatKg);
  const yieldGoal = goalVisualState(alerts, ["yield"], formatPercent);

  return (
    <div className="space-y-6">
      <PageHeader title="Produtividade" description="Indicadores calculados da produção aprovada e apontamentos informados, sempre separados por origem." />

      <Card className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Select label="Semana" value={weekId} onChange={(value) => { setWeekId(value); void loadData(value); }} options={weeks.map((week) => ({ value: week.id, label: `${week.label} - ${week.status}` }))} />
          <Select label="Setor" value={sector} onChange={(value) => { setSector(value as "P1" | "P2"); setEquipmentId(""); }} options={[{ value: "P1", label: "P1" }, { value: "P2", label: "P2" }]} />
          <Input label="Data" value={date} onChange={setDate} type="date" />
          <TraceabilityFields sector={sector} equipment={equipment} shifts={shifts} equipmentId={equipmentId} shiftId={shiftId} onEquipmentChange={setEquipmentId} onShiftChange={setShiftId} />
          <Input label="Produção informada (kg)" value={String(producedKg)} onChange={(value) => setProducedKg(Number(value))} type="number" />
          <Input label="Horas produtivas informadas" value={String(productiveHours)} onChange={(value) => setProductiveHours(Number(value))} type="number" />
          <Input label="Observação" value={notes} onChange={setNotes} type="text" />
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="button" onClick={saveEntry} disabled={loading}>
            <Save className="size-4" />
            Salvar apontamento informado
          </Button>
          <Button type="button" className="border-slate-400/30 bg-white/5" onClick={() => loadData(weekId)} disabled={loading}>
            <RefreshCw className="size-4" />
            Atualizar
          </Button>
        </div>
        <p className="text-sm text-slate-300">{message}</p>
      </Card>

      <Card className="border-cyan-300/20 bg-cyan-300/[0.04]">
        <p className="text-xs font-medium uppercase tracking-wide text-cyan-200">Fonte dos indicadores</p>
        <p className="mt-2 text-sm text-slate-200">{summary.sourceDescription}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Produção aprovada" value={formatKg(summary.producedKg)} hint={productionGoal.hint} status={productionGoal.status} />
        <StatCard label="Média kg/dia" value={formatKg(summary.averageKgPerDay)} />
        <StatCard label="Rendimento médio" value={formatPercent(summary.averageYield)} hint={yieldGoal.hint} status={yieldGoal.status} />
        <StatCard label="Dias trabalhados" value={String(summary.workedDays)} />
      </div>

      <DataTable
        title="Produtividade diária calculada da produção aprovada"
        rows={summary.daily.length
          ? summary.daily.map((row) => ({ Data: row.date.slice(0, 10), Produção: formatKg(row.producedKg), Rendimento: formatPercent(row.averageYield), Fonte: "Produção aprovada" }))
          : [{ Data: "-", Produção: "-", Rendimento: "-", Fonte: "Nenhuma produção aprovada no período." }]}
      />

      <DataTable
        title="Apontamentos informados — fluxo independente"
        rows={entries.length ? entries.map((entry) => ({
          Data: entry.date.slice(0, 10),
          Setor: entry.sectorCode,
          Equipamento: entry.equipment ? `${entry.equipment.code} - ${entry.equipment.name}` : "-",
          Turno: entry.shift ? `${entry.shift.code} - ${entry.shift.name}` : "-",
          Produção: formatKg(Number(entry.producedKg)),
          Horas: Number(entry.productiveHours).toLocaleString("pt-BR"),
          "kg/h": formatKg(Number(entry.kgPerHour)),
          Fonte: entry.dataSource === "INFORMED_MANUALLY" ? "Informado manualmente" : "Legado sem origem verificada",
          Fluxo: (
            <EntryWorkflowActions
              entry={entry}
              resource="productivity"
              roles={session?.user.roles ?? []}
              actorId={session?.user.id}
              demo={DEMO_MODE}
              disabled={loading}
              onChanged={async (updated) => {
                if (DEMO_MODE) setEntries((current) => current.map((item) => item.id === updated.id ? updated : item));
                else await loadData(weekId);
              }}
              onReload={() => loadData(weekId)}
              onMessage={setMessage}
            />
          ),
        })) : [{
          Data: "-",
          Setor: "-",
          Equipamento: "-",
          Turno: "-",
          Produção: "-",
          Horas: "-",
          "kg/h": "-",
          Fonte: "Nenhum apontamento informado.",
          Fluxo: <span>-</span>,
        }]}
      />
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <select className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Selecione</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function Input({ label, value, onChange, type }: { label: string; value: string; onChange: (value: string) => void; type: string }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type={type} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
