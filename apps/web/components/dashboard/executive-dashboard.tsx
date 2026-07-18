"use client";

import { useEffect, useState } from "react";
import { NexusChart } from "@/components/charts/nexus-chart";
import { StatCard } from "@/components/ui/card";
import { DataTable } from "@/components/tables/data-table";
import {
  demoDashboardAlerts,
  demoDashboardCharts,
  demoDashboardComparison,
  demoDashboardKpis
} from "@/lib/demo/operational-preview";
import { formatCurrency, formatKg, formatPercent } from "@/lib/format";
import { apiGetClient, DEMO_MODE, getSession } from "@/services/api";

interface DashboardKpis {
  productionTotalKg: number;
  lossesTotalKg: number;
  overweightTotalKg: number;
  overweightPercent: number;
  averageYield: number;
  stoppedMinutes: number;
  averageRealKgHour: number;
  averagePingandoKgHour: number;
  records: number;
  financial: {
    productionCost: number;
    lossesCost: number;
    overweightCost: number;
    totalImpactCost: number;
    costPerKg: number;
    lossPercent: number;
    packaging: { lostKg: number; lossCost: number; filmUsedKg: number; filmUsedValue: number; financialResult: number };
  };
  financialBySector: Array<{ sector: string; producedKg: number; lossesKg: number; overweightKg: number; productionCost: number; lossesCost: number; overweightCost: number }>;
}

interface DashboardCharts {
  productionBySector: Array<{ sector: string; producedKg: number; lossesKg: number; overweightKg: number }>;
  downtimeByReason: Array<{ reason: string; stoppedMinutes: number }>;
  lossesByType: Array<{ type: string; quantityKg: number; lossCost: number }>;
}

interface Comparison {
  currentWeek: { id: string; label: string };
  previousWeek: { id: string; label: string } | null;
  metrics: Array<{ label: string; key: string; currentValue: number; previousValue: number; variationPercent: number | null; trend: "up" | "down" | "stable"; improvesWhen: "up" | "down" }>;
}

interface Alert {
  goalId: string;
  name: string;
  value: number;
  target: number;
  status: string;
  action: string;
}

interface WeekRow {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  status: string;
}

export function ExecutiveDashboard() {
  const [kpis, setKpis] = useState<DashboardKpis | null>(null);
  const [charts, setCharts] = useState<DashboardCharts | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState("");
  const [source, setSource] = useState("Carregando dados operacionais.");

  useEffect(() => {
    if (DEMO_MODE) {
      setKpis(demoDashboardKpis);
      setCharts(demoDashboardCharts);
      setComparison(demoDashboardComparison);
      setAlerts(demoDashboardAlerts);
      setSource("Preview demonstrativo baseado na estrutura operacional da planilha.");
      return;
    }

    if (!getSession()) {
      setSource("Entre no sistema para consultar os dados operacionais.");
      return;
    }

    let cancelled = false;
    async function loadDashboard() {
      try {
        const weekRows = await apiGetClient<WeekRow[]>("/weeks");
        const weekId = selectedWeekId || weekRows[0]?.id || "";
        if (cancelled) return;
        setWeeks(weekRows);
        if (!weekId) {
          setKpis(null);
          setCharts(null);
          setComparison(null);
          setAlerts([]);
          setSource("Nenhuma semana operacional cadastrada.");
          return;
        }
        if (!selectedWeekId) setSelectedWeekId(weekId);
        const query = `?weekId=${encodeURIComponent(weekId)}`;
        const [nextKpis, nextCharts, nextComparison, nextAlerts] = await Promise.all([
          apiGetClient<DashboardKpis>(`/dashboard/kpis${query}`),
          apiGetClient<DashboardCharts>(`/dashboard/charts${query}`),
          apiGetClient<Comparison>(`/dashboard/comparison${query}`),
          apiGetClient<Alert[]>(`/dashboard/alerts${query}`)
        ]);
        if (cancelled) return;
        setKpis(nextKpis);
        setCharts(nextCharts);
        setComparison(nextComparison);
        setAlerts(nextAlerts);
        const selectedWeek = weekRows.find((week) => week.id === weekId);
        setSource(`Dados reais da API — ${selectedWeek?.label ?? "semana selecionada"} (${selectedWeek?.status ?? "status indisponível"}).`);
      } catch (error) {
        if (!cancelled) setSource(error instanceof Error ? error.message : "Não foi possível carregar o dashboard.");
      }
    }

    void loadDashboard();
    return () => {
      cancelled = true;
    };
  }, [selectedWeekId]);

  const dashboardKpis = kpis ? [
    { label: "Produção total", value: formatKg(kpis.productionTotalKg), status: "OK" },
    { label: "Perdas totais", value: formatKg(kpis.lossesTotalKg), status: kpis.lossesTotalKg > 50 ? "ATTENTION" : "OK" },
    { label: "Sobrepeso", value: formatKg(kpis.overweightTotalKg), status: kpis.overweightPercent > 0.02 ? "ATTENTION" : "OK" },
    { label: "Rendimento", value: formatPercent(kpis.averageYield), status: kpis.averageYield < 0.95 ? "ATTENTION" : "OK" },
    { label: "kg/h real", value: formatKg(kpis.averageRealKgHour), status: "OK" },
    { label: "kg/h pingando", value: formatKg(kpis.averagePingandoKgHour), status: "OK" }
  ] : [];
  const sectors = charts?.productionBySector ?? [];
  const reasons = charts?.downtimeByReason ?? [];
  const lossTypes = charts?.lossesByType ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm text-slate-300">
        <span>{source}</span>
        {!DEMO_MODE && weeks.length ? (
          <label className="flex items-center gap-2">
            <span>Semana</span>
            <select className="rounded-md border border-[var(--line)] bg-[#111827] px-3 py-2 text-slate-100" value={selectedWeekId} onChange={(event) => setSelectedWeekId(event.target.value)}>
              {weeks.map((week) => <option key={week.id} value={week.id}>{week.label} — {week.status}</option>)}
            </select>
          </label>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        {dashboardKpis.map((kpi) => <StatCard key={kpi.label} label={kpi.label} value={kpi.value} status={kpi.status} />)}
      </div>

      {kpis ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Custo de produção" value={formatCurrency(kpis.financial.productionCost)} status="OK" />
        <StatCard label="Custo das perdas" value={formatCurrency(kpis.financial.lossesCost)} status={kpis.financial.lossesCost > 0 ? "ATTENTION" : "OK"} />
        <StatCard label="Custo do sobrepeso" value={formatCurrency(kpis.financial.overweightCost)} status={kpis.financial.overweightCost > 0 ? "MEDIUM" : "OK"} />
        <StatCard label="Resultado do filme" value={formatCurrency(kpis.financial.packaging.financialResult)} status={kpis.financial.packaging.financialResult < 0 ? "ATTENTION" : "OK"} />
      </div> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <NexusChart title="Produção por setor" option={{ tooltip: { trigger: "axis" }, legend: { textStyle: { color: "#cbd5e1" } }, xAxis: { type: "category", data: sectors.map((item) => item.sector) }, yAxis: { type: "value" }, series: [
          { name: "Produzido", type: "bar", data: sectors.map((item) => item.producedKg), itemStyle: { color: "#22d3ee" } },
          { name: "Sobrepeso", type: "bar", data: sectors.map((item) => item.overweightKg), itemStyle: { color: "#f59e0b" } }
        ] }} />
        <NexusChart title="Paradas por motivo" option={{ tooltip: { trigger: "axis" }, grid: { left: 20, right: 20, bottom: 30, containLabel: true }, xAxis: { type: "value" }, yAxis: { type: "category", data: reasons.map((item) => item.reason) }, series: [{ name: "Minutos", type: "bar", data: reasons.map((item) => item.stoppedMinutes), itemStyle: { color: "#a78bfa" } }] }} />
        <NexusChart title="Perdas por tipo" option={{ tooltip: { trigger: "item" }, series: [{ type: "pie", radius: ["48%", "72%"], label: { color: "#cbd5e1" }, data: lossTypes.map((item) => ({ name: item.type, value: item.quantityKg })) }] }} />
        <NexusChart title="Custo por setor" option={{ tooltip: { trigger: "axis" }, legend: { textStyle: { color: "#cbd5e1" } }, xAxis: { type: "category", data: kpis?.financialBySector.map((item) => item.sector) ?? [] }, yAxis: { type: "value" }, series: [
          { name: "Produção", type: "bar", data: kpis?.financialBySector.map((item) => item.productionCost) ?? [], itemStyle: { color: "#34d399" } },
          { name: "Perdas + sobrepeso", type: "bar", data: kpis?.financialBySector.map((item) => item.lossesCost + item.overweightCost) ?? [], itemStyle: { color: "#fb7185" } }
        ] }} />
      </div>

      <DataTable title={`Comparativo semanal${comparison?.previousWeek ? `: ${comparison.currentWeek.label} x ${comparison.previousWeek.label}` : ""}`} rows={(comparison?.metrics ?? []).map((metric) => ({
        Indicador: metric.label,
        Atual: metric.key.includes("Yield") ? formatPercent(metric.currentValue) : metric.key.includes("Minutes") ? `${metric.currentValue.toFixed(0)} min` : formatKg(metric.currentValue),
        Anterior: metric.key.includes("Yield") ? formatPercent(metric.previousValue) : metric.key.includes("Minutes") ? `${metric.previousValue.toFixed(0)} min` : formatKg(metric.previousValue),
        Variação: metric.variationPercent === null ? "Sem base anterior" : formatPercent(metric.variationPercent),
        Tendência: metric.trend === "up" ? "Melhora ↑" : metric.trend === "down" ? "Piora ↓" : "Estável"
      }))} />

      <DataTable title="Alertas e ações recomendadas" rows={alerts.map((alert) => ({
        Meta: alert.name,
        Atual: alert.value.toLocaleString("pt-BR", { maximumFractionDigits: 3 }),
        Alvo: alert.target.toLocaleString("pt-BR", { maximumFractionDigits: 3 }),
        Status: alert.status,
        "Ação recomendada": alert.action
      }))} />

      <DataTable title="Financeiro por setor" rows={(kpis?.financialBySector ?? []).map((item) => ({
        Setor: item.sector,
        Produção: formatKg(item.producedKg),
        "Custo produção": formatCurrency(item.productionCost),
        "Custo perdas": formatCurrency(item.lossesCost),
        "Custo sobrepeso": formatCurrency(item.overweightCost)
      }))} />
    </div>
  );
}
