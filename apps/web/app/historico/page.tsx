"use client";

import { RefreshCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { DataTable } from "@/components/tables/data-table";
import { apiGetClient, getSession } from "@/services/api";

interface AuditRow {
  id: string;
  module: string;
  action: string;
  entity: string;
  entityId?: string | null;
  reason?: string | null;
  createdAt: string;
  user?: { email: string; name: string } | null;
}

export default function HistoryPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [moduleFilter, setModuleFilter] = useState("");
  const [message, setMessage] = useState("Aguardando sessao para carregar historico real.");

  async function load() {
    const session = getSession();
    if (!session) {
      setRows([]);
      setMessage("Entre no sistema para ver historico auditado do banco.");
      return;
    }

    try {
      const query = moduleFilter ? `?take=100&module=${encodeURIComponent(moduleFilter)}` : "?take=100";
      const data = await apiGetClient<AuditRow[]>(`/audit${query}`);
      setRows(data);
      setMessage(`${data.length} evento(s) historico(s) carregado(s).`);
    } catch (error) {
      setRows([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar o historico.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tableRows = useMemo(
    () =>
      rows.map((row) => ({
        Quando: new Date(row.createdAt).toLocaleString("pt-BR"),
        Modulo: row.module,
        Acao: row.action,
        Entidade: row.entity,
        Registro: row.entityId ?? "-",
        Usuario: row.user?.email ?? "system",
        Motivo: row.reason ?? "-"
      })),
    [rows]
  );

  const uniqueModules = new Set(rows.map((row) => row.module)).size;
  const restoreSignals = rows.filter((row) => row.action.includes("restore") || row.action.includes("reopen")).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Historico permanente" description="Arquivo vivo com soft delete, restauracao, filtros avancados e trilha de alteracoes." />
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Eventos auditados" value={String(rows.length)} status="OK" />
        <StatCard label="Modulos rastreados" value={String(uniqueModules)} status="OK" />
        <StatCard label="Reaberturas/restauros" value={String(restoreSignals)} status={restoreSignals ? "ATTENTION" : "OK"} />
      </div>
      <Card className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <input className="rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 outline-none focus:border-cyan-300/60" value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)} placeholder="Filtrar modulo: production, weeks, products" />
          <Button onClick={load}>
            <RefreshCcw className="size-4" />
            Atualizar
          </Button>
        </div>
        <p className="text-sm text-slate-400">{message}</p>
      </Card>
      <DataTable title="Linha do tempo operacional" rows={tableRows} />
    </div>
  );
}
