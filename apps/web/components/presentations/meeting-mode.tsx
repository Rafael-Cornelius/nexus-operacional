"use client";

import { Maximize2, RefreshCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { createDemoExecutiveDeck, demoDashboardAlerts } from "@/lib/demo/operational-preview";
import { formatKg, formatPercent } from "@/lib/format";
import { goalVisualState, type OperationalGoalAlert } from "@/lib/operational-goals";
import { resolveExplicitWeekId } from "@/lib/week-selection";
import { apiGetClient, DEMO_MODE, getSession } from "@/services/api";

interface ExecutiveDeck {
  generatedAt: string;
  source: "database" | "demo-preview";
  week: { id: string; label: string; startsOn: string; endsOn: string; status: string } | null;
  slides: Array<{ title: string; kind: string; data: unknown }>;
}

interface WeekRow {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  status: string;
}

interface KpiPayload {
  productionTotalKg: number;
  lossesTotalKg: number;
  overweightTotalKg: number;
  overweightPercent: number;
  averageYield: number;
  stoppedMinutes: number;
  records: number;
}

interface DowntimePayload {
  reason: string;
  stoppedMinutes: number;
}

interface GoalAlert extends OperationalGoalAlert {
  goalId: string;
  name: string;
  value: number;
  action: string;
}

function asKpis(data: unknown): KpiPayload | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Partial<KpiPayload>;
  const fields = [
    "productionTotalKg", "lossesTotalKg", "overweightTotalKg", "overweightPercent",
    "averageYield", "stoppedMinutes", "records"
  ] as const;
  if (fields.some((field) => typeof record[field] !== "number" || !Number.isFinite(record[field]))) {
    return null;
  }
  return {
    productionTotalKg: record.productionTotalKg,
    lossesTotalKg: record.lossesTotalKg,
    overweightTotalKg: record.overweightTotalKg,
    overweightPercent: record.overweightPercent,
    averageYield: record.averageYield,
    stoppedMinutes: record.stoppedMinutes,
    records: record.records
  } as KpiPayload;
}

function asDowntime(data: unknown): DowntimePayload[] | null {
  if (!Array.isArray(data)) return null;
  const parsed = data.map((item) => {
    const row = item as Partial<DowntimePayload>;
    if (typeof row.reason !== "string" || !row.reason.trim() || typeof row.stoppedMinutes !== "number" || !Number.isFinite(row.stoppedMinutes)) {
      return null;
    }
    return { reason: row.reason, stoppedMinutes: row.stoppedMinutes };
  });
  return parsed.some((item) => item === null) ? null : parsed as DowntimePayload[];
}

export function MeetingMode() {
  const [deck, setDeck] = useState<ExecutiveDeck | null>(null);
  const [alerts, setAlerts] = useState<GoalAlert[]>([]);
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState("");
  const [message, setMessage] = useState("Aguardando API para gerar apresentacao executiva.");

  async function loadDeck(nextWeekId = selectedWeekId) {
    if (DEMO_MODE) {
      const demoDeck = createDemoExecutiveDeck();
      setDeck(demoDeck);
      setAlerts(demoDashboardAlerts);
      setMessage("Preview demonstrativo isolado; nenhum dado operacional real foi usado.");
      return;
    }

    if (!getSession()) {
      setDeck(null);
      setAlerts([]);
      setMessage("Entre no sistema para gerar apresentacao executiva com dados reais.");
      return;
    }

    try {
      const weekRows = await apiGetClient<WeekRow[]>("/weeks");
      const weekId = resolveExplicitWeekId(weekRows, nextWeekId);
      setWeeks(weekRows);
      setSelectedWeekId(weekId);
      if (!weekId) {
        setDeck(null);
        setAlerts([]);
        setMessage(weekRows.length ? "Selecione uma semana para gerar a apresentação." : "Cadastre uma semana operacional antes de gerar a apresentação.");
        return;
      }
      setDeck(null);
      setAlerts([]);
      setMessage("Gerando a apresentação da semana selecionada.");
      const [data, nextAlerts] = await Promise.all([
        apiGetClient<ExecutiveDeck>(`/presentations/executive?weekId=${encodeURIComponent(weekId)}`),
        apiGetClient<GoalAlert[]>(`/dashboard/alerts?weekId=${encodeURIComponent(weekId)}`)
      ]);
      setDeck(data);
      setAlerts(nextAlerts);
      setMessage(`Dados reais da API — ${data.week?.label ?? "semana selecionada"}; apresentação gerada em ${new Date(data.generatedAt).toLocaleString("pt-BR")}.`);
    } catch (error) {
      setDeck(null);
      setAlerts([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel gerar a apresentacao.");
    }
  }

  useEffect(() => {
    loadDeck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const executiveKpis = useMemo(() => {
    const slide = deck?.slides.find((item) => item.kind === "kpis");
    return asKpis(slide?.data);
  }, [deck]);

  const downtime = useMemo(() => {
    const slide = deck?.slides.find((item) => item.kind === "downtime");
    return asDowntime(slide?.data);
  }, [deck]);

  const stats = executiveKpis
    ? [
        { label: "Producao total", value: formatKg(executiveKpis.productionTotalKg), ...goalVisualState(alerts, ["produced_kg"], formatKg) },
        { label: "Perdas totais", value: formatKg(executiveKpis.lossesTotalKg), ...goalVisualState(alerts, ["losses_kg", "loss"], formatKg) },
        { label: "Rendimento medio", value: formatPercent(executiveKpis.averageYield), ...goalVisualState(alerts, ["yield"], formatPercent) }
      ]
    : [];

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-cyan-200/20 bg-[#08111f]/90 p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm uppercase text-cyan-200">Modo reuniao</p>
            <h2 className="mt-2 text-4xl font-semibold">Resumo executivo semanal</h2>
            <p className="mt-3 max-w-3xl text-slate-300">Producao, perdas, sobrepeso, paradas, eficiencia e plano de acao em uma narrativa unica para tomada de decisao.</p>
          </div>
          <div className="flex gap-2">
            {!DEMO_MODE && weeks.length ? (
              <select className="rounded-md border border-white/15 bg-[#111827] px-3 py-2 text-sm text-slate-100" value={selectedWeekId} onChange={(event) => void loadDeck(event.target.value)}>
                <option value="">Selecione uma semana</option>
                {weeks.map((week) => <option key={week.id} value={week.id}>{week.label} — {week.status}</option>)}
              </select>
            ) : null}
            <Button className="border-white/15 bg-white/10 text-white hover:bg-white/15" onClick={() => void loadDeck()}>
              <RefreshCcw className="size-4" />
              Gerar
            </Button>
            <Button onClick={() => document.documentElement.requestFullscreen?.()}>
              <Maximize2 className="size-4" />
              Tela cheia
            </Button>
          </div>
        </div>
        <p className="mt-5 text-sm text-slate-400">{message}</p>
      </section>
      <div className="grid gap-4 md:grid-cols-3">
        {stats.map((kpi) => (
          <StatCard key={kpi.label} label={kpi.label} value={kpi.value} hint={kpi.hint} status={kpi.status} />
        ))}
      </div>
      {deck && !executiveKpis ? <p className="rounded-md border border-rose-300/30 bg-rose-400/10 p-3 text-sm text-rose-100">A API retornou KPIs incompletos ou inválidos. Nenhum zero foi presumido.</p> : null}
      <Card>
        <h3 className="mb-4 text-lg font-semibold">Pontos criticos</h3>
        {downtime === null ? <p className="text-sm text-rose-200">A API retornou dados de parada incompletos ou inválidos.</p> : downtime.length ? <div className="grid gap-3 md:grid-cols-3">
          {downtime.slice(0, 3).map((item) => (
            <div key={item.reason} className="rounded-md border border-[var(--line)] bg-white/5 p-4">
              <p className="text-sm text-slate-400">{item.reason}</p>
              <strong className="mt-2 block text-2xl">{item.stoppedMinutes} min</strong>
            </div>
          ))}
        </div> : <p className="text-sm text-slate-400">Nenhuma parada registrada para a semana selecionada.</p>}
      </Card>
    </div>
  );
}
