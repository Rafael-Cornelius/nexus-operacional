"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, getSession } from "@/services/api";

interface AuditRow {
  id: string;
  module: string;
  action: string;
  entity: string;
  entityId?: string | null;
  reason?: string | null;
  createdAt: string;
  user?: { email: string } | null;
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [message, setMessage] = useState("Aguardando login para carregar auditoria real.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadAudit() {
    if (!session) return;
    setLoading(true);
    try {
      const data = await apiGetClient<AuditRow[]>("/audit?take=50");
      setRows(data);
      setMessage(`${data.length} evento(s) de auditoria carregado(s).`);
    } catch (error) {
      setRows([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar auditoria da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAudit();
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader title="Auditoria" description="Compare alteracoes, restaure registros e acompanhe a trilha de acoes criticas." />
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={loadAudit} disabled={loading}>
          <RefreshCw className="size-4" />
          Atualizar auditoria
        </Button>
      </div>
      <Card>
        <p className="text-sm text-slate-300">{message}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Eventos listados" value={String(rows.length)} status="OK" />
        <StatCard label="Retencao" value="Permanente" />
        <StatCard label="Soft delete" value="Ativo" status="OK" />
      </div>
      <DataTable
        title="Auditoria"
        rows={
          rows.length
            ? rows.map((row) => ({
                Quando: row.createdAt.slice(0, 19).replace("T", " "),
                Usuario: row.user?.email ?? "sistema",
                Modulo: row.module,
                Acao: row.action,
                Entidade: row.entity,
                Motivo: row.reason ?? "-"
              }))
            : [{ Quando: "-", Usuario: "-", Modulo: "-", Acao: "Nenhum evento carregado.", Entidade: "-", Motivo: "-" }]
        }
      />
    </div>
  );
}
