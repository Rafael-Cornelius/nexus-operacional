"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, apiPostClient, getSession } from "@/services/api";

interface GoalRow {
  id: string;
  name: string;
  metric: string;
  sectorCode?: "P1" | "P2" | null;
  targetValue: string | number;
  comparator: string;
  active: boolean;
  updatedAt?: string;
  cadence?: "DAILY" | "WEEKLY";
  dueDate?: string | null;
  currentValue?: number;
  progress?: number;
  status?: string;
  action?: string;
}

interface WeekRow { id: string; label: string; status: string }

export default function GoalsPage() {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [weekId, setWeekId] = useState("");
  const [name, setName] = useState("");
  const [metric, setMetric] = useState("yield");
  const [sectorCode, setSectorCode] = useState("");
  const [targetValue, setTargetValue] = useState(0.95);
  const [comparator, setComparator] = useState(">=");
  const [cadence, setCadence] = useState<"DAILY" | "WEEKLY">("WEEKLY");
  const [dueDate, setDueDate] = useState("");
  const [message, setMessage] = useState("Aguardando login para carregar metas reais.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadGoals(nextWeekId = weekId) {
    if (!session) return;
    setLoading(true);
    try {
      const [data, weekRows] = await Promise.all([
        apiGetClient<GoalRow[]>(`/goals${nextWeekId ? `?weekId=${nextWeekId}` : ""}`),
        apiGetClient<WeekRow[]>("/weeks")
      ]);
      setGoals(data);
      setWeeks(weekRows);
      setWeekId((current) => current || weekRows.find((week) => week.status === "OPEN" || week.status === "REVIEW")?.id || weekRows[0]?.id || "");
      setMessage(data.length ? `${data.length} meta(s) carregada(s) da API.` : "Nenhuma meta cadastrada.");
    } catch (error) {
      setGoals([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar metas da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadGoals();
  }, []);

  async function saveGoal() {
    if (!session) {
      setMessage("Entre no sistema com perfil gestor ou administrador para salvar metas.");
      return;
    }
    setLoading(true);
    try {
      await apiPostClient("/goals", { name, metric, sectorCode: sectorCode || undefined, targetValue, comparator, cadence, dueDate: dueDate || undefined, active: true });
      await loadGoals();
      setMessage("Meta salva e disponivel para acompanhamento.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar meta.");
    } finally {
      setLoading(false);
    }
  }

  const activeGoals = goals.filter((goal) => goal.active).length;
  const sectorGoals = goals.filter((goal) => goal.sectorCode).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Metas e limites" description="Parametros configuraveis para perdas, sobrepeso, rendimento, producao e paradas." />

      <Card>
        <div className="grid gap-4 md:grid-cols-5">
          <Select label="Semana de acompanhamento" value={weekId} onChange={(value) => { setWeekId(value); void loadGoals(value); }} options={[{ value: "", label: "Todas as semanas" }, ...weeks.map((week) => ({ value: week.id, label: `${week.label} - ${week.status}` }))]} />
          <Input label="Nome" value={name} onChange={setName} />
          <Select label="Metrica" value={metric} onChange={setMetric} options={[{ value: "yield", label: "Rendimento" }, { value: "overweight", label: "Sobrepeso" }, { value: "losses_kg", label: "Perdas kg" }, { value: "downtime_minutes", label: "Paradas min" }, { value: "produced_kg", label: "Producao kg" }]} />
          <Select label="Setor" value={sectorCode} onChange={setSectorCode} options={[{ value: "", label: "Global" }, { value: "P1", label: "P1" }, { value: "P2", label: "P2" }]} />
          <Select label="Comparador" value={comparator} onChange={setComparator} options={[{ value: "<=", label: "<=" }, { value: ">=", label: ">=" }, { value: "<", label: "<" }, { value: ">", label: ">" }, { value: "=", label: "=" }]} />
          <NumberInput label="Valor alvo" value={targetValue} onChange={setTargetValue} />
          <Select label="Periodicidade" value={cadence} onChange={(value) => setCadence(value as "DAILY" | "WEEKLY")} options={[{ value: "DAILY", label: "Diária" }, { value: "WEEKLY", label: "Semanal" }]} />
          <Input label="Prazo" type="date" value={dueDate} onChange={setDueDate} />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button type="button" onClick={saveGoal} disabled={loading}>
            <Save className="size-4" />
            Salvar meta
          </Button>
          <Button type="button" className="border-slate-400/30 bg-white/5" onClick={() => void loadGoals()} disabled={loading}>
            <RefreshCw className="size-4" />
            Atualizar
          </Button>
        </div>
        <p className="mt-4 text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Metas ativas" value={String(activeGoals)} status="OK" />
        <StatCard label="Metas por setor" value={String(sectorGoals)} />
        <StatCard label="Metas globais" value={String(goals.length - sectorGoals)} />
      </div>

      <DataTable
        title="Metas"
        rows={goals.map((goal) => ({
          Meta: goal.name,
          Metrica: goal.metric,
          Setor: goal.sectorCode ?? "Global",
          Comparador: goal.comparator,
          Valor: Number(goal.targetValue).toLocaleString("pt-BR", { maximumFractionDigits: 4 }),
          Atual: Number(goal.currentValue ?? 0).toLocaleString("pt-BR", { maximumFractionDigits: 4 }),
          Progresso: `${Math.round(Number(goal.progress ?? 0) * 100)}%`,
          Periodicidade: goal.cadence === "DAILY" ? "Diária" : "Semanal",
          Prazo: goal.dueDate?.slice(0, 10) ?? "-",
          Status: goal.active ? goal.status ?? "Ativa" : "Inativa",
          "Ação recomendada": goal.action ?? "-"
        }))}
      />
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <select className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type={type} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type="number" step="0.001" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
