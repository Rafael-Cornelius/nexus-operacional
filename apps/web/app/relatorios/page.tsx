"use client";

import { useMemo, useState } from "react";
import { FileDown } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, getSession } from "@/services/api";

interface WeeklyReport {
  exportId: string;
  format: "csv";
  csv: string;
}

export default function ReportsPage() {
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [message, setMessage] = useState("CSV semanal pronto para ser gerado quando a API estiver autenticada.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function generateCsv() {
    if (!session) {
      setMessage("Entre no sistema para gerar relatorios reais.");
      return;
    }
    setLoading(true);
    try {
      const data = await apiGetClient<WeeklyReport>("/reports/weekly-production");
      setReport(data);
      setMessage(`Relatorio CSV gerado. Export ID: ${data.exportId}`);
    } catch (error) {
      setReport(null);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel gerar relatorio pela API.");
    } finally {
      setLoading(false);
    }
  }

  function downloadCsv() {
    if (!report) return;
    const blob = new Blob([report.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "nexus-producao-semanal.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const lines = report?.csv.split("\n").filter(Boolean) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Relatorios" description="Relatorios semanais, mensais, perdas, sobrepeso, paradas, produtividade, metas e auditoria." />
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={generateCsv} disabled={loading}>
          <FileDown className="size-4" />
          {loading ? "Gerando..." : "Gerar CSV semanal"}
        </Button>
        <Button type="button" className="border-slate-400/30 bg-white/5" onClick={downloadCsv} disabled={!report}>
          Baixar CSV
        </Button>
      </div>
      <Card>
        <p className="text-sm text-slate-300">{message}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Formato ativo" value="CSV" status="OK" />
        <StatCard label="Linhas geradas" value={String(Math.max(lines.length - 1, 0))} />
        <StatCard label="PDF/Excel" value="Proxima etapa" status="ATTENTION" />
      </div>
      <DataTable
        title="Exportacoes"
        rows={[
          { Relatorio: "Semanal de producao", Formato: "CSV", Status: report ? "Gerado" : "Aguardando" },
          { Relatorio: "Executivo para reuniao", Formato: "PDF", Status: "Preparado para proxima etapa" }
        ]}
      />
    </div>
  );
}
