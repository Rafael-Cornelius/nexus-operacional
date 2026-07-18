"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, apiPostClient, getSession } from "@/services/api";

interface BackupRow {
  id: string;
  fileName: string;
  filePath: string;
  status: "COMPLETED" | "FAILED" | "RUNNING" | string;
  sizeBytes: string | null;
  checksum?: string | null;
  createdAt: string;
}

interface BackupListResponse {
  items: BackupRow[];
  summary: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    storageBytes: string;
    latestCreatedAt: string | null;
  };
}

function formatBytes(value: string | null) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function shortChecksum(value?: string | null) {
  if (!value) return "-";
  return value.length > 16 ? `${value.slice(0, 16)}...` : value;
}

export default function BackupsPage() {
  const session = useMemo(() => getSession(), []);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [summary, setSummary] = useState<BackupListResponse["summary"]>({
    total: 0,
    completed: 0,
    failed: 0,
    running: 0,
    storageBytes: "0",
    latestCreatedAt: null
  });
  const [message, setMessage] = useState("Aguardando login para carregar backups reais.");
  const [loading, setLoading] = useState(false);

  async function loadBackups() {
    if (!session) return;
    setLoading(true);
    try {
      const data = await apiGetClient<BackupListResponse>("/backups?take=50");
      setBackups(data.items);
      setSummary(data.summary);
      setMessage(`${data.summary.total} backup(s) registrado(s) no banco.`);
    } catch (error) {
      setBackups([]);
      setSummary({ total: 0, completed: 0, failed: 0, running: 0, storageBytes: "0", latestCreatedAt: null });
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar backups da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBackups();
  }, []);

  async function createBackup() {
    if (!session) {
      setMessage("Entre no sistema para gerar um backup real.");
      return;
    }

    setLoading(true);
    setMessage("Gerando snapshot JSON do banco...");
    try {
      const backup = await apiPostClient<BackupRow>("/backups", {});
      setMessage(`Backup gerado: ${backup.fileName}`);
      await loadBackups();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao gerar backup.");
    } finally {
      setLoading(false);
    }
  }

  const latest = summary.latestCreatedAt ? new Date(summary.latestCreatedAt).toLocaleString("pt-BR") : "-";

  return (
    <div className="space-y-6">
      <PageHeader title="Backups" description="Snapshots auditaveis do banco com checksum, tamanho e historico de geracao." />

      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={createBackup} disabled={loading}>
          <Download className="size-4" />
          {loading ? "Processando..." : "Gerar backup"}
        </Button>
        <Button type="button" className="border-slate-400/30 bg-white/5" onClick={loadBackups} disabled={loading}>
          <RefreshCw className="size-4" />
          Atualizar
        </Button>
      </div>

      <Card>
        <p className="text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Backups" value={String(summary.total)} status="OK" />
        <StatCard label="Concluidos" value={String(summary.completed)} status={summary.failed ? "ATTENTION" : "OK"} />
        <StatCard label="Armazenamento" value={formatBytes(summary.storageBytes)} />
        <StatCard label="Ultimo backup" value={latest} />
      </div>

      <DataTable
        title="Historico de backups"
        rows={backups.map((backup) => ({
          Arquivo: backup.fileName,
          Status: (
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="size-4 text-emerald-200" />
              {backup.status}
            </span>
          ),
          Tamanho: formatBytes(backup.sizeBytes),
          Checksum: shortChecksum(backup.checksum),
          Criado: new Date(backup.createdAt).toLocaleString("pt-BR"),
          Destino: backup.filePath
        }))}
      />
    </div>
  );
}
