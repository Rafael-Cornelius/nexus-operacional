"use client";

import { useEffect, useMemo, useState } from "react";
import { FileDown, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, apiPostClient, getSession } from "@/services/api";

type ReportPeriod = "daily" | "weekly" | "monthly";
type ReportFormat = "csv" | "xlsx" | "pdf";

interface WeekOption {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  status: string;
}

interface OperationalExport {
  exportId: string;
  format: ReportFormat;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  dataBase64: string;
  summary: {
    producedKg: number;
    lossKg: number;
    stoppedMinutes: number;
    averageYield: number;
    productionRecords: number;
    lossRecords: number;
    downtimeRecords: number;
  };
}

const fieldClass = "rounded-xl border border-slate-400/30 bg-slate-950/60 px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/60";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function downloadBase64(report: OperationalExport) {
  const binary = window.atob(report.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: report.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = report.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [weeks, setWeeks] = useState<WeekOption[]>([]);
  const [period, setPeriod] = useState<ReportPeriod>("weekly");
  const [format, setFormat] = useState<ReportFormat>("xlsx");
  const [selectedWeek, setSelectedWeek] = useState("");
  const [selectedDate, setSelectedDate] = useState(today());
  const [selectedMonth, setSelectedMonth] = useState(currentMonth());
  const [lastExport, setLastExport] = useState<OperationalExport | null>(null);
  const [message, setMessage] = useState("Escolha período e formato. Dados vêm somente da API operacional.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadWeeks() {
    if (!session) return;
    try {
      const data = await apiGetClient<WeekOption[]>("/weeks");
      setWeeks(data);
      setSelectedWeek((current) => current || data[0]?.id || "");
    } catch (error) {
      setWeeks([]);
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar semanas.");
    }
  }

  useEffect(() => {
    loadWeeks();
  }, []);

  async function generateReport() {
    if (!session) {
      setMessage("Entre no sistema para gerar relatórios reais.");
      return;
    }
    const request: Record<string, string> = { period, format };
    if (period === "daily") request.date = selectedDate;
    if (period === "weekly") {
      if (!selectedWeek) {
        setMessage("Selecione uma semana para gerar relatório semanal.");
        return;
      }
      request.weekId = selectedWeek;
    }
    if (period === "monthly") {
      const [year, month] = selectedMonth.split("-");
      request.year = year;
      request.month = String(Number(month));
    }
    setLoading(true);
    try {
      const report = await apiPostClient<OperationalExport>("/reports/operational-export", request);
      setLastExport(report);
      downloadBase64(report);
      setMessage(`Relatório ${report.fileName} gerado, auditado e baixado. SHA-256: ${report.sha256}`);
    } catch (error) {
      setLastExport(null);
      setMessage(error instanceof Error ? error.message : "Não foi possível gerar relatório pela API.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Relatórios" description="Relatórios diários, semanais e mensais derivados de registros aprovados no PostgreSQL." />

      <Card>
        <div className="grid gap-4 md:grid-cols-4">
          <label className="grid gap-2 text-sm text-slate-300">
            Período
            <select className={fieldClass} value={period} onChange={(event) => setPeriod(event.target.value as ReportPeriod)}>
              <option value="daily">Diário</option>
              <option value="weekly">Semanal</option>
              <option value="monthly">Mensal</option>
            </select>
          </label>
          {period === "daily" ? (
            <label className="grid gap-2 text-sm text-slate-300">
              Data
              <input className={fieldClass} type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </label>
          ) : null}
          {period === "weekly" ? (
            <label className="grid gap-2 text-sm text-slate-300">
              Semana
              <select className={fieldClass} value={selectedWeek} onChange={(event) => setSelectedWeek(event.target.value)}>
                <option value="">Selecione</option>
                {weeks.map((week) => (
                  <option key={week.id} value={week.id}>{week.label} - {week.startsOn.slice(0, 10)} a {week.endsOn.slice(0, 10)}</option>
                ))}
              </select>
            </label>
          ) : null}
          {period === "monthly" ? (
            <label className="grid gap-2 text-sm text-slate-300">
              Mês
              <input className={fieldClass} type="month" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} />
            </label>
          ) : null}
          <label className="grid gap-2 text-sm text-slate-300">
            Formato
            <select className={fieldClass} value={format} onChange={(event) => setFormat(event.target.value as ReportFormat)}>
              <option value="xlsx">Excel XLSX</option>
              <option value="pdf">PDF</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <div className="flex items-end gap-2">
            <Button type="button" onClick={generateReport} disabled={loading}>
              <FileDown className="size-4" />
              {loading ? "Gerando..." : "Gerar e baixar"}
            </Button>
            <Button type="button" className="border-slate-400/30 bg-white/5" onClick={loadWeeks} disabled={loading} aria-label="Atualizar semanas">
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <p className="break-words text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Formato" value={lastExport?.format.toUpperCase() ?? format.toUpperCase()} status={lastExport ? "OK" : undefined} />
        <StatCard label="Produção" value={`${(lastExport?.summary.producedKg ?? 0).toLocaleString("pt-BR")} kg`} />
        <StatCard label="Perdas" value={`${(lastExport?.summary.lossKg ?? 0).toLocaleString("pt-BR")} kg`} status={lastExport ? "ATTENTION" : undefined} />
        <StatCard label="Tempo parado" value={`${(lastExport?.summary.stoppedMinutes ?? 0).toLocaleString("pt-BR")} min`} />
      </div>

      <DataTable
        title="Última exportação"
        rows={lastExport ? [{
          ID: lastExport.exportId,
          Arquivo: lastExport.fileName,
          Tamanho: `${lastExport.sizeBytes.toLocaleString("pt-BR")} bytes`,
          Produção: lastExport.summary.productionRecords,
          Perdas: lastExport.summary.lossRecords,
          Paradas: lastExport.summary.downtimeRecords
        }] : []}
      />
    </div>
  );
}
