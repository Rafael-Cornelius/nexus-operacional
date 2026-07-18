"use client";

import { useEffect, useMemo, useState } from "react";
import { UploadCloud } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, apiPostClient, apiUploadClient, getSession } from "@/services/api";

interface ImportPreview {
  source: string;
  batchId?: string;
  status?: string;
  fileHash?: string | null;
  fileSizeBytes?: string | null;
  sheetCount: number;
  formulaCount: number;
  tableCount?: number;
  chartCount?: number;
  errors: Record<string, number>;
  productCount?: number;
  duplicateWeightCodes?: string[];
  importErrorCount?: number;
  productionEntryCount?: number;
  lossEntryCount?: number;
  downtimeEntryCount?: number;
  importErrors?: Array<{ sheetName?: string | null; cell?: string | null; message: string; status?: string }>;
}

interface ImportBatch {
  id: string;
  status: string;
  originalFileName?: string | null;
  fileHash?: string | null;
  fileSizeBytes?: string | null;
  summary?: {
    importedProducts?: number;
    productCount?: number;
    duplicateWeightCodes?: string[];
    importErrorCount?: number;
  };
  errors?: Array<{ sheetName?: string | null; cell?: string | null; message: string; status?: string }>;
}

const fallbackPreview: ImportPreview = {
  source: "API nao carregada",
  sheetCount: 0,
  formulaCount: 0,
  errors: {},
  productCount: 0,
  duplicateWeightCodes: [],
  importErrorCount: 0,
  importErrors: []
};

export default function ImportPage() {
  const [preview, setPreview] = useState<ImportPreview>(fallbackPreview);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>("Aguardando conexao autenticada com a API.");
  const session = useMemo(() => getSession(), []);

  async function loadPreview(batchId?: string) {
    if (!session) return;
    const query = batchId ? `?batchId=${encodeURIComponent(batchId)}` : "";
    const data = await apiGetClient<ImportPreview>(`/import/preview${query}`);
    setPreview(data);
    setActiveBatchId(data.batchId ?? batchId ?? "");
    setMessage(data.batchId ? "Preview carregado do lote enviado." : "Nenhuma planilha carregada para importacao.");
  }

  useEffect(() => {
    loadPreview().catch((error) => setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar preview da API."));
  }, [session]);

  async function uploadWorkbook() {
    if (!session) {
      setMessage("Entre no sistema para enviar a planilha.");
      return;
    }
    if (!selectedFile) {
      setMessage("Selecione um arquivo .xlsx antes de enviar.");
      return;
    }

    setLoading(true);
    setMessage("Enviando planilha para validacao segura...");
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      const result = await apiUploadClient<ImportBatch>("/import/upload", formData);
      setBatch(result);
      setActiveBatchId(result.id);
      await loadPreview(result.id);
      setMessage("Planilha recebida, validada e registrada como lote de importacao.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao enviar planilha.");
    } finally {
      setLoading(false);
    }
  }

  async function runImport() {
    if (!session) {
      setMessage("Entre no sistema para executar a importacao real.");
      return;
    }
    if (!activeBatchId) {
      setMessage("Envie uma planilha .xlsx antes de importar produtos.");
      return;
    }

    setLoading(true);
    setMessage("Importando produtos e configuracoes tecnicas...");
    try {
      const result = await apiPostClient<ImportBatch>("/import/products", { batchId: activeBatchId });
      setBatch(result);
      await loadPreview(result.id);
      setMessage("Importacao concluida e registrada no banco.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao importar produtos.");
    } finally {
      setLoading(false);
    }
  }

  async function runOperationalImport() {
    if (!session || !activeBatchId) {
      setMessage("Envie uma planilha .xlsx antes de importar os registros operacionais.");
      return;
    }
    setLoading(true);
    setMessage("Importando produção, perdas e paradas da planilha...");
    try {
      const result = await apiPostClient<ImportBatch>("/import/operational-data", { batchId: activeBatchId });
      setBatch(result);
      await loadPreview(result.id);
      setMessage("Dados operacionais importados com rastreabilidade por lote.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao importar os registros operacionais.");
    } finally {
      setLoading(false);
    }
  }

  const totalCachedErrors = Object.values(preview.errors ?? {}).reduce((sum, value) => sum + value, 0);
  const visibleErrors = batch?.errors?.length ? batch.errors : preview.importErrors ?? [];
  const errorRows = visibleErrors.length
    ? visibleErrors.map((error) => ({
        Aba: error.sheetName ?? "-",
        Celula: error.cell ?? "-",
        Status: error.status ?? "PENDING",
        Erro: error.message
      }))
    : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Importacao da planilha" description="Leitura segura, normalizacao de produtos e registro auditavel de inconsistencias." />

      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-72 max-w-full items-center rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm text-slate-200">
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-cyan-300/20 file:px-3 file:py-1.5 file:text-cyan-50"
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <Button type="button" className="border-slate-400/30 bg-white/5" onClick={uploadWorkbook} disabled={loading}>
          <UploadCloud className="size-4" />
          {loading ? "Processando..." : "Enviar XLSX"}
        </Button>
        <Button type="button" onClick={runImport} disabled={loading}>
          <UploadCloud className="size-4" />
          {loading ? "Importando..." : "Importar produtos"}
        </Button>
        <Button type="button" onClick={runOperationalImport} disabled={loading}>
          <UploadCloud className="size-4" />
          {loading ? "Importando..." : "Importar produção, perdas e paradas"}
        </Button>
        <Button type="button" className="border-slate-400/30 bg-white/5" onClick={() => loadPreview(activeBatchId)}>
          Atualizar preview
        </Button>
      </div>

      <Card>
        <p className="text-sm text-slate-300">{message}</p>
        <p className="mt-2 text-xs text-slate-500">Fonte: {preview.source}</p>
        {preview.fileHash ? <p className="mt-1 text-xs text-slate-500">SHA-256: {preview.fileHash}</p> : null}
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Abas detectadas" value={String(preview.sheetCount)} status="OK" />
        <StatCard label="Formulas legado" value={preview.formulaCount.toLocaleString("pt-BR")} />
        <StatCard label="Produtos normalizados" value={String(batch?.summary?.importedProducts ?? preview.productCount ?? batch?.summary?.productCount ?? 0)} status="OK" />
        <StatCard label="Inconsistencias" value={String(batch?.summary?.importErrorCount ?? preview.importErrorCount ?? totalCachedErrors)} status="ATTENTION" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Produções detectadas" value={String(preview.productionEntryCount ?? 0)} />
        <StatCard label="Perdas detectadas" value={String(preview.lossEntryCount ?? 0)} />
        <StatCard label="Paradas detectadas" value={String(preview.downtimeEntryCount ?? 0)} />
      </div>

      <DataTable title="Erros e pontos de auditoria da importacao" rows={errorRows} />
    </div>
  );
}
