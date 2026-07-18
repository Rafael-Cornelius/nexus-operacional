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

interface OverweightRow {
  productId: string;
  code: string;
  product: string;
  sector: string;
  overweightKg: number;
  producedKg: number;
  overweightPercent: number;
  tolerancePercent: number;
  status: string;
}

export default function OverweightPage() {
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [weekId, setWeekId] = useState("");
  const [ranking, setRanking] = useState<OverweightRow[]>([]);
  const [message, setMessage] = useState("Carregando ranking de sobrepeso da API.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadRanking(nextWeekId = weekId) {
    if (!session) return;
    setLoading(true);
    try {
      const weekRows = await apiGetClient<WeekRow[]>("/weeks");
      const selectedWeek = nextWeekId || weekRows.find((week) => week.status !== "CLOSED" && week.status !== "ARCHIVED")?.id || weekRows[0]?.id || "";
      setWeeks(weekRows);
      setWeekId(selectedWeek);
      const query = selectedWeek ? `?weekId=${selectedWeek}` : "";
      const data = await apiGetClient<OverweightRow[]>(`/overweight/ranking${query}`);
      setRanking(data);
      setMessage(data.length ? "Ranking de sobrepeso carregado da API." : "Sem producao na semana selecionada.");
    } catch (error) {
      setWeeks([]);
      setRanking([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar ranking da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRanking("");
  }, []);

  const totalOverweight = ranking.reduce((sum, row) => sum + row.overweightKg, 0);
  const totalProduced = ranking.reduce((sum, row) => sum + row.producedKg, 0);
  const totalPercent = totalProduced > 0 ? totalOverweight / totalProduced : 0;
  const criticalRows = ranking.filter((row) => row.status !== "OK").length;

  return (
    <div className="space-y-6">
      <PageHeader title="Controle de sobrepeso" description="Ranking de sobrepeso por produto, setor e semana com comparacao contra tolerancia tecnica." />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Semana" value={weekId} onChange={setWeekId} options={weeks.map((week) => ({ value: week.id, label: `${week.label} - ${week.status}` }))} />
          <Button type="button" onClick={() => loadRanking(weekId)} disabled={loading}>
            <RefreshCw className="size-4" />
            {loading ? "Carregando..." : "Atualizar"}
          </Button>
        </div>
        <p className="mt-4 text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Sobrepeso total" value={formatKg(totalOverweight)} status={criticalRows > 0 ? "ATTENTION" : "OK"} />
        <StatCard label="Percentual medio" value={formatPercent(totalPercent)} status={totalPercent > 0.02 ? "ATTENTION" : "OK"} />
        <StatCard label="Produtos em alerta" value={String(criticalRows)} status={criticalRows > 0 ? "ATTENTION" : "OK"} />
      </div>

      <DataTable
        title="Ranking de sobrepeso"
        rows={ranking.map((row) => ({
          Codigo: row.code,
          Produto: row.product,
          Setor: row.sector,
          Sobrepeso: formatKg(row.overweightKg),
          Produzido: formatKg(row.producedKg),
          Percentual: formatPercent(row.overweightPercent),
          Tolerancia: formatPercent(row.tolerancePercent),
          Status: row.status
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
