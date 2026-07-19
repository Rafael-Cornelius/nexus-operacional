"use client";

import { useEffect, useMemo, useState } from "react";
import { Save, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { EntryWorkflowActions } from "@/components/workflow/entry-workflow-actions";
import { demoDashboardAlerts } from "@/lib/demo/operational-preview";
import { createDemoLossEntries, demoWorkflowLossTypes, demoWorkflowProducts, demoWorkflowWeek } from "@/lib/demo/workflow-preview";
import { formatCurrency, formatKg } from "@/lib/format";
import { goalVisualState, type OperationalGoalAlert, uniqueOperationalGoal } from "@/lib/operational-goals";
import type { WorkflowEntry } from "@/lib/operational-workflow";
import { resolveExplicitWeekId } from "@/lib/week-selection";
import { apiGetClient, apiPostClient, DEMO_MODE, getSession } from "@/services/api";

interface WeekRow {
  id: string;
  label: string;
  status: string;
}

interface LossTypeRow {
  id: string;
  name: string;
}

interface LossEntryRow extends WorkflowEntry {
  id: string;
  date: string;
  quantityKg: string | number;
  filmShift1Kg?: string | number | null;
  filmShift2Kg?: string | number | null;
  boxLossUnits?: string | number | null;
  boxLossShift1Units?: string | number | null;
  boxLossShift2Units?: string | number | null;
  reason?: string | null;
  sector?: { code: string } | null;
  lossType?: { name: string };
  product?: { code: string; name: string } | null;
  lossCost?: string | number;
  filmUsedKg?: string | number;
  financialResult?: string | number;
}

interface ProductRow { id: string; code: string; name: string; defaultSector?: { code: string } }

export default function LossesPage() {
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [types, setTypes] = useState<LossTypeRow[]>([]);
  const [entries, setEntries] = useState<LossEntryRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [alerts, setAlerts] = useState<OperationalGoalAlert[]>([]);
  const [weekId, setWeekId] = useState("");
  const [lossTypeId, setLossTypeId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [sector, setSector] = useState<"P1" | "P2">("P1");
  const [filmShift1Kg, setFilmShift1Kg] = useState(10);
  const [filmShift2Kg, setFilmShift2Kg] = useState(0);
  const [boxLossShift1Units, setBoxLossShift1Units] = useState(0);
  const [boxLossShift2Units, setBoxLossShift2Units] = useState(0);
  const [productId, setProductId] = useState("");
  const [packedBoxes, setPackedBoxes] = useState(0);
  const [reason, setReason] = useState("Lancamento operacional");
  const [message, setMessage] = useState("Carregando perdas da API.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);
  const quantityKg = filmShift1Kg + filmShift2Kg;
  const boxLossUnits = boxLossShift1Units + boxLossShift2Units;

  async function loadData(nextWeekId = weekId) {
    const requestedWeek = nextWeekId || weekId;
    if (!session) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      if (DEMO_MODE) {
        setWeeks([demoWorkflowWeek]);
        setTypes(demoWorkflowLossTypes);
        setProducts(demoWorkflowProducts);
        setWeekId(demoWorkflowWeek.id);
        setLossTypeId((current) => current || demoWorkflowLossTypes[0]?.id || "");
        setEntries((current) => current.length ? current : createDemoLossEntries());
        setAlerts(demoDashboardAlerts);
        setMessage("Perdas demonstrativas carregadas; o workflow funciona localmente.");
        return;
      }
      const [weekRows, typeRows, productRows] = await Promise.all([
        apiGetClient<WeekRow[]>("/weeks"),
        apiGetClient<LossTypeRow[]>("/losses/types"),
        apiGetClient<ProductRow[]>("/products?active=true")
      ]);
      const selectedWeek = resolveExplicitWeekId(weekRows, requestedWeek);
      setWeeks(weekRows);
      setTypes(typeRows);
      setProducts(productRows);
      setWeekId(selectedWeek);
      setLossTypeId((current) => current || typeRows[0]?.id || "");
      if (selectedWeek) {
        const [lossRows, nextAlerts] = await Promise.all([
          apiGetClient<LossEntryRow[]>(`/losses?weekId=${encodeURIComponent(selectedWeek)}`),
          apiGetClient<OperationalGoalAlert[]>(`/dashboard/alerts?weekId=${encodeURIComponent(selectedWeek)}`)
        ]);
        setEntries(lossRows);
        setAlerts(nextAlerts);
        setMessage("Perdas carregadas da API.");
      } else {
        setEntries([]);
        setAlerts([]);
        setMessage(weekRows.length ? "Selecione uma semana para carregar as perdas." : "Nenhuma semana operacional cadastrada.");
      }
    } catch (error) {
      setWeeks([]);
      setTypes([]);
      setEntries([]);
      setAlerts([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar perdas da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData("");
  }, []);

  async function saveLoss() {
    if (!session || !weekId || !lossTypeId || !productId) {
      setMessage("Entre no sistema e selecione semana, tipo e produto com preco aprovado.");
      return;
    }
    if (DEMO_MODE) {
      const selectedType = types.find((type) => type.id === lossTypeId);
      const selectedProduct = products.find((product) => product.id === productId);
      const demoEntry: LossEntryRow = {
        id: `demo-loss-${Date.now()}`,
        date: `${date}T00:00:00.000Z`,
        quantityKg,
        filmShift1Kg,
        filmShift2Kg,
        boxLossUnits,
        boxLossShift1Units,
        boxLossShift2Units,
        reason,
        sector: { code: sector },
        lossType: selectedType,
        product: selectedProduct ? { code: selectedProduct.code, name: selectedProduct.name } : null,
        lossCost: quantityKg * 5.6,
        filmUsedKg: 0,
        financialResult: -(quantityKg * 5.6),
        workflowStatus: "DRAFT",
        version: 1
      };
      setEntries((current) => [demoEntry, ...current]);
      setMessage("Rascunho de perda criado localmente. Use Enviar para iniciar a aprovação demonstrativa.");
      return;
    }
    setLoading(true);
    try {
      await apiPostClient("/losses", {
        weekId,
        date,
        sector,
        productId: productId || undefined,
        lossTypeId,
        quantityKg,
        filmShift1Kg,
        filmShift2Kg,
        boxLossUnits,
        boxLossShift1Units,
        boxLossShift2Units,
        packedBoxes,
        reason
      });
      await loadData(weekId);
      setMessage("Perda registrada e auditada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar perda.");
    } finally {
      setLoading(false);
    }
  }

  const approvedEntries = entries.filter((entry) => entry.workflowStatus === "APPROVED");
  const total = approvedEntries.reduce((sum, entry) => sum + Number(entry.quantityKg), 0);
  const lossGoal = goalVisualState(alerts, ["losses_kg", "loss"], formatKg);
  const uniqueLossGoal = uniqueOperationalGoal(alerts, ["losses_kg", "loss"]);
  const optionalKg = (value: string | number | null | undefined) => value === null || value === undefined ? "-" : formatKg(Number(value));
  const optionalUnits = (value: string | number | null | undefined) => value === null || value === undefined ? "-" : Number(value).toLocaleString("pt-BR");
  const rows = entries.length
    ? entries.map((entry) => ({
        Data: entry.date.slice(0, 10),
        Setor: entry.sector?.code ?? "-",
        Tipo: entry.lossType?.name ?? "-",
        Produto: entry.product ? `${entry.product.code} - ${entry.product.name}` : "-",
        "Filme total": formatKg(Number(entry.quantityKg)),
        "Filme T1/T2": `${optionalKg(entry.filmShift1Kg)} / ${optionalKg(entry.filmShift2Kg)}`,
        "Caixas perdidas": optionalUnits(entry.boxLossUnits),
        "Caixa T1/T2": `${optionalUnits(entry.boxLossShift1Units)} / ${optionalUnits(entry.boxLossShift2Units)}`,
        Custo: formatCurrency(Number(entry.lossCost ?? 0)),
        "Filme aproveitado": formatKg(Number(entry.filmUsedKg ?? 0)),
        Resultado: formatCurrency(Number(entry.financialResult ?? 0)),
        Motivo: entry.reason ?? "-",
        Fluxo: (
          <EntryWorkflowActions
            entry={entry}
            resource="losses"
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
        )
      }))
    : [{ Data: "-", Setor: "-", Tipo: "Nenhuma perda carregada.", Produto: "-", "Filme total": "-", "Filme T1/T2": "-", "Caixas perdidas": "-", "Caixa T1/T2": "-", Custo: "-", "Filme aproveitado": "-", Resultado: "-", Motivo: "-", Fluxo: <span>-</span> }];

  return (
    <div className="space-y-6">
      <PageHeader title="Controle de perdas" description="Registre perdas e calcule custo, filme aproveitado e resultado financeiro da embalagem." />
      <Card>
        <div className="grid gap-4 md:grid-cols-5">
          <Select label="Semana" value={weekId} onChange={(value) => { setWeekId(value); void loadData(value); }} options={weeks.map((week) => ({ value: week.id, label: `${week.label} - ${week.status}` }))} />
          <Select label="Tipo" value={lossTypeId} onChange={setLossTypeId} options={types.map((type) => ({ value: type.id, label: type.name }))} />
          <Select label="Setor" value={sector} onChange={(value) => setSector(value as "P1" | "P2")} options={[{ value: "P1", label: "P1" }, { value: "P2", label: "P2" }]} />
          <Select label="Produto (preco aprovado)" value={productId} onChange={setProductId} options={products.filter((product) => !product.defaultSector || product.defaultSector.code === sector).map((product) => ({ value: product.id, label: `${product.code} - ${product.name}` }))} />
          <Input label="Data" type="date" value={date} onChange={setDate} />
          <NumberInput label="Filme total (kg)" value={quantityKg} onChange={() => undefined} disabled />
          <NumberInput label="Filme T1 (kg)" value={filmShift1Kg} onChange={setFilmShift1Kg} />
          <NumberInput label="Filme T2 (kg)" value={filmShift2Kg} onChange={setFilmShift2Kg} />
          <NumberInput label="Caixas perdidas (un)" value={boxLossUnits} onChange={() => undefined} disabled />
          <NumberInput label="Caixas T1 (un)" value={boxLossShift1Units} onChange={setBoxLossShift1Units} />
          <NumberInput label="Caixas T2 (un)" value={boxLossShift2Units} onChange={setBoxLossShift2Units} />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Input label="Motivo" value={reason} onChange={setReason} />
          <NumberInput label="Caixas produzidas (filme)" value={packedBoxes} onChange={setPackedBoxes} />
          <Button type="button" onClick={saveLoss} disabled={loading}>
            <Save className="size-4" />
            Salvar perda
          </Button>
          <Button type="button" className="border-slate-400/30 bg-white/5" onClick={() => loadData(weekId)} disabled={loading}>
            <RefreshCw className="size-4" />
            Atualizar
          </Button>
        </div>
        <p className="mt-4 text-sm text-slate-300">{message}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Perdas da semana" value={formatKg(total)} hint={lossGoal.hint} status={lossGoal.status} />
        <StatCard label="Registros aprovados" value={`${approvedEntries.length} de ${entries.length}`} />
        <StatCard label="Meta semanal" value={uniqueLossGoal ? formatKg(uniqueLossGoal.target) : "Não definida"} hint={lossGoal.hint} status={lossGoal.status} />
      </div>
      <DataTable title="Perdas" rows={rows} />
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

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="min-w-48 flex-1 space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type={type} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberInput({ label, value, onChange, disabled = false }: { label: string; value: number; onChange: (value: number) => void; disabled?: boolean }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type="number" min="0" disabled={disabled} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60 disabled:opacity-60" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
