"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, CheckCircle2, FolderPlus, RefreshCw, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, apiPatchClient, apiPostClient, getSession } from "@/services/api";

interface WeekRow {
  id: string;
  year: number;
  month: number;
  weekNumber: number;
  label: string;
  startsOn: string;
  endsOn: string;
  status: "OPEN" | "REVIEW" | "CLOSED" | "ARCHIVED";
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function currentWeekPayload() {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    weekNumber: Math.ceil(now.getDate() / 7),
    startsOn: toIsoDate(monday),
    endsOn: toIsoDate(friday)
  };
}

export default function WeeksPage() {
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [message, setMessage] = useState("Carregando semanas da API.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadWeeks() {
    if (!session) return;
    setLoading(true);
    try {
      const data = await apiGetClient<WeekRow[]>("/weeks");
      setWeeks(data);
      setMessage(`${data.length} semana(s) carregada(s) da API.`);
    } catch (error) {
      setWeeks([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar semanas da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWeeks();
  }, []);

  async function createCurrentWeek() {
    if (!session) {
      setMessage("Entre no sistema para criar semanas reais.");
      return;
    }
    setLoading(true);
    try {
      await apiPostClient("/weeks", currentWeekPayload());
      await loadWeeks();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao criar semana.");
    } finally {
      setLoading(false);
    }
  }

  async function changeStatus(id: string, action: "close" | "reopen" | "archive") {
    if (!session) {
      setMessage("Entre no sistema para alterar status de semanas.");
      return;
    }
    setLoading(true);
    try {
      await apiPatchClient(`/weeks/${id}/${action}`, action === "reopen" ? { reason: "Reabertura operacional via NEXUS." } : {});
      await loadWeeks();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao alterar semana.");
    } finally {
      setLoading(false);
    }
  }

  const closed = weeks.filter((week) => week.status === "CLOSED").length;
  const open = weeks.filter((week) => week.status === "OPEN" || week.status === "REVIEW").length;

  return (
    <div className="space-y-6">
      <PageHeader title="Sistema de semanas" description="Navegue, crie, feche, reabra e arquive semanas sem perder historico." />

      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={createCurrentWeek} disabled={loading}>
          <FolderPlus className="size-4" />
          Criar semana atual
        </Button>
        <Button type="button" className="border-slate-400/30 bg-white/5" onClick={loadWeeks} disabled={loading}>
          <RefreshCw className="size-4" />
          Atualizar
        </Button>
      </div>

      <Card>
        <p className="text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Semanas listadas" value={String(weeks.length)} status="OK" />
        <StatCard label="Abertas" value={String(open)} status="OK" />
        <StatCard label="Fechadas" value={String(closed)} />
      </div>

      <DataTable
        title="Semanas"
        rows={weeks.map((week) => ({
          Semana: `${week.year}/${String(week.month).padStart(2, "0")} - ${week.weekNumber}`,
          Periodo: `${week.startsOn.slice(0, 10)} a ${week.endsOn.slice(0, 10)}`,
          Status: week.status,
          Acoes: (
            <div className="flex flex-wrap gap-2">
              <Button type="button" className="border-emerald-300/30 bg-emerald-300/10 text-emerald-100" onClick={() => changeStatus(week.id, "close")}>
                <CheckCircle2 className="size-4" />
                Fechar
              </Button>
              <Button type="button" className="border-amber-300/30 bg-amber-300/10 text-amber-100" onClick={() => changeStatus(week.id, "reopen")}>
                <RotateCcw className="size-4" />
                Reabrir
              </Button>
              <Button type="button" className="border-slate-400/30 bg-white/5" onClick={() => changeStatus(week.id, "archive")}>
                <Archive className="size-4" />
                Arquivar
              </Button>
            </div>
          )
        }))}
      />
    </div>
  );
}
