"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { formatKg, formatPercent } from "@/lib/format";
import { apiGetClient, getSession } from "@/services/api";

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
  producedKg: number;
  averageYield: number;
  workedDays: number;
  averageKgPerDay: number;
  records: number;
  daily: DailyProductivityRow[];
}

const emptySummary: ProductivitySummary = {
  producedKg: 0,
  averageYield: 0,
  workedDays: 0,
  averageKgPerDay: 0,
  records: 0,
  daily: []
};

export default function ProductivityPage() {
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [weekId, setWeekId] = useState("");
  const [summary, setSummary] = useState<ProductivitySummary>(emptySummary);
  const [message, setMessage] = useState("Carregando produtividade da API.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadSummary(nextWeekId = weekId) {
    if (!session) return;
    setLoading(true);
    try {
      const weekRows = await apiGetClient<WeekRow[]>("/weeks");
      const selectedWeek = nextWeekId || weekRows.find((week) => week.status !== "CLOSED" && week.status !== "ARCHIVED")?.id || weekRows[0]?.id || "";
      setWeeks(weekRows);
      setWeekId(selectedWeek);
      const query = selectedWeek ? `?weekId=${selectedWeek}` : "";
      const data = await apiGetClient<ProductivitySummary>(`/productivity/summary${query}`);
      setSummary(data);
      setMessage(data.records ? "Produtividade carregada da API." : "Sem producao na semana selecionada.");
    } catch (error) {
      setWeeks([]);
      setSummary(emptySummary);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar produtividade da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSummary("");
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader title="Produtividade" description="Analise kg/dia, rendimento medio, dias trabalhados e tendencia de producao por semana." />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Semana" value={weekId} onChange={setWeekId} options={weeks.map((week) => ({ value: week.id, label: `${week.label} - ${week.status}` }))} />
          <Button type="button" onClick={() => loadSummary(weekId)} disabled={loading}>
            <RefreshCw className="size-4" />
            {loading ? "Carregando..." : "Atualizar"}
          </Button>
        </div>
        <p className="mt-4 text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Producao total" value={formatKg(summary.producedKg)} status="OK" />
        <StatCard label="Media kg/dia" value={formatKg(summary.averageKgPerDay)} status="OK" />
        <StatCard label="Rendimento medio" value={formatPercent(summary.averageYield)} status={summary.averageYield >= 0.95 ? "OK" : "ATTENTION"} />
        <StatCard label="Dias trabalhados" value={String(summary.workedDays)} />
      </div>

      <DataTable
        title="Produtividade diaria"
        rows={summary.daily.map((row) => ({
          Data: row.date.slice(0, 10),
          Producao: formatKg(row.producedKg),
          Rendimento: formatPercent(row.averageYield),
          Status: row.averageYield >= 0.95 ? "OK" : "ATTENTION"
        }))}
      />
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="min-w-64 space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <select className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Todas</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
