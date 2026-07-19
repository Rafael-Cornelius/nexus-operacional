"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, RefreshCw, ShieldCheck, UploadCloud, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, apiPatchClient, apiPostClient, apiUploadClient, getSession } from "@/services/api";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type StagingDomain = "UNKNOWN" | "PRODUCT" | "PRODUCTION" | "LOSS" | "DOWNTIME" | "DOSAGE" | "HISTORY";
type StagingClassification = "VALID" | "WARNING" | "ERROR" | "DUPLICATE" | "REQUIRES_REVIEW";
type ReviewDecision = "PENDING" | "APPROVED" | "CORRECTED" | "IGNORED" | "REJECTED";
type ReviewAction = "APPROVE" | "IGNORE" | "REJECT";

interface ImportPreview {
  source: string;
  batchId?: string;
  status?: string;
  fileHash?: string | null;
  sheetCount: number;
  formulaCount: number;
  errors: Record<string, number>;
  productCount?: number;
  importErrorCount?: number;
  productionEntryCount?: number;
  lossEntryCount?: number;
  downtimeEntryCount?: number;
  dosageSampleCount?: number;
  historicalEntryCount?: number;
  importErrors?: Array<{ sheetName?: string | null; cell?: string | null; message: string; status?: string }>;
}

interface ImportBatch {
  id: string;
  status: string;
  originalFileName?: string | null;
  fileHash?: string | null;
  stagedRecords?: number;
  importerVersion?: string;
}

interface StagingRecord {
  id: string;
  batchId: string;
  domain: StagingDomain;
  sheetName: string | null;
  cell: string | null;
  rowNumber: number | null;
  rawOriginal: JsonValue;
  interpretedValue: JsonValue;
  correctedValue: JsonValue | null;
  validationIssues: JsonValue;
  classification: StagingClassification;
  decision: ReviewDecision;
  resolutionReason: string | null;
  resolvedBy: string | null;
  version: number;
  promotedEntityId: string | null;
}

interface StagingList {
  batch: { id: string; status: string; originalFileName: string | null; sourceFile: string };
  pagination: { total: number; take: number; skip: number; hasMore: boolean };
  records: StagingRecord[];
}

interface StagingSummary {
  batch: {
    id: string;
    status: string;
    originalFileName: string | null;
    fileHash: string | null;
    importerVersion: string;
    promotedAt: string | null;
  };
  totals: {
    records: number;
    promotionBlockers: number;
    byDomain: Partial<Record<StagingDomain, number>>;
    byClassification: Partial<Record<StagingClassification, number>>;
    byDecision: Partial<Record<ReviewDecision, number>>;
  };
}

interface RecordDraft {
  reason: string;
  value: string;
  version: number;
}

interface ReconciliationMetric {
  key: string;
  metric: string;
  unit: "rows" | "kg" | "min" | "batches" | "boxes";
  excel: number | null;
  excelKnownSubtotal: number;
  excelUnknownValues: number;
  staging: number | null;
  stagingKnownSubtotal: number;
  stagingUnknownValues: number;
  database: number;
  difference: number | null;
  stagingDifference: number | null;
  databaseDifference: number | null;
  tolerance: number;
  stagingStatus: "MATCH" | "DIVERGENT" | "INCOMPLETE";
  status: "MATCH" | "DIVERGENT" | "INCOMPLETE";
}

interface ReconciliationReport {
  batchId: string;
  sourceFile: string;
  fileHash: string | null;
  batchStatus: string;
  status: string;
  excelToStagingStatus?: string;
  stagingToDatabaseStatus?: string;
  certified: boolean;
  datasetHash: string | null;
  certificationIntegrity: string;
  eligibleForCertification: boolean;
  pendingErrors: number;
  pendingStagingReviews: number;
  pendingOperationalApprovals: number | null;
  sourceIntegrity: {
    independentDerivedMetrics: boolean;
    completeReconciliationScope: boolean;
    reason?: string;
    [key: string]: JsonValue | undefined;
  };
  metrics: ReconciliationMetric[];
  generatedAt?: string;
  message?: string;
}

const fallbackPreview: ImportPreview = {
  source: "API nao carregada",
  sheetCount: 0,
  formulaCount: 0,
  errors: {},
  productCount: 0,
  importErrorCount: 0,
  importErrors: []
};

const domains: Array<{ value: "" | StagingDomain; label: string }> = [
  { value: "", label: "Todos os dominios" },
  { value: "PRODUCT", label: "Produtos" },
  { value: "PRODUCTION", label: "Producao" },
  { value: "LOSS", label: "Perdas" },
  { value: "DOWNTIME", label: "Paradas" },
  { value: "DOSAGE", label: "Dosagem em quarentena" },
  { value: "HISTORY", label: "Arquivo morto" },
  { value: "UNKNOWN", label: "Nao reconhecido" }
];

const classifications: Array<{ value: "" | StagingClassification; label: string }> = [
  { value: "", label: "Todas as classificacoes" },
  { value: "REQUIRES_REVIEW", label: "Exige revisao" },
  { value: "ERROR", label: "Erro" },
  { value: "DUPLICATE", label: "Duplicidade" },
  { value: "WARNING", label: "Aviso" },
  { value: "VALID", label: "Valido" }
];

const decisions: Array<{ value: "" | ReviewDecision; label: string }> = [
  { value: "PENDING", label: "Pendentes" },
  { value: "", label: "Todas as decisoes" },
  { value: "APPROVED", label: "Aprovados" },
  { value: "CORRECTED", label: "Corrigidos" },
  { value: "IGNORED", label: "Ignorados" },
  { value: "REJECTED", label: "Rejeitados" }
];

function formattedJson(value: JsonValue | undefined) {
  return JSON.stringify(value ?? null, null, 2);
}

function classificationStyle(classification: StagingClassification) {
  if (classification === "VALID") return "border-emerald-300/30 bg-emerald-300/10 text-emerald-200";
  if (classification === "WARNING" || classification === "REQUIRES_REVIEW") {
    return "border-amber-300/30 bg-amber-300/10 text-amber-100";
  }
  return "border-rose-300/30 bg-rose-300/10 text-rose-100";
}

function decisionStyle(decision: ReviewDecision) {
  if (decision === "APPROVED" || decision === "CORRECTED") {
    return "border-emerald-300/30 bg-emerald-300/10 text-emerald-200";
  }
  if (decision === "PENDING") return "border-amber-300/30 bg-amber-300/10 text-amber-100";
  return "border-slate-400/30 bg-slate-400/10 text-slate-200";
}

function reconciliationStatusStyle(status: string) {
  if (status === "MATCH" || status === "CERTIFIED") {
    return "border-emerald-300/30 bg-emerald-300/10 text-emerald-200";
  }
  if (status === "NOT_CERTIFIED" || status === "SOURCE_TOTALS_UNAVAILABLE" || status === "LEGACY_CONTRACT") {
    return "border-amber-300/30 bg-amber-300/10 text-amber-100";
  }
  return "border-rose-300/30 bg-rose-300/10 text-rose-100";
}

function formattedMetric(value: number | null, unit: ReconciliationMetric["unit"]) {
  if (value === null) return "não informado";
  const maximumFractionDigits = unit === "rows" || unit === "batches" || unit === "boxes" ? 0 : 3;
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits }).format(value);
}

export default function ImportPage() {
  const [preview, setPreview] = useState<ImportPreview>(fallbackPreview);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [activeBatchId, setActiveBatchId] = useState("");
  const [summary, setSummary] = useState<StagingSummary | null>(null);
  const [staging, setStaging] = useState<StagingList | null>(null);
  const [domain, setDomain] = useState<"" | StagingDomain>("");
  const [classification, setClassification] = useState<"" | StagingClassification>("");
  const [decision, setDecision] = useState<"" | ReviewDecision>("PENDING");
  const [skip, setSkip] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, RecordDraft>>({});
  const [reconciliation, setReconciliation] = useState<ReconciliationReport | null>(null);
  const [certificationReason, setCertificationReason] = useState("");
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [busyRecord, setBusyRecord] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Aguardando conexao autenticada com a API.");
  const session = useMemo(() => getSession(), []);
  const canPromote = session?.user.roles.some((role) => role === "ADMIN" || role === "MANAGER") ?? false;
  const canReconcile = session?.user.roles.some((role) => ["ADMIN", "MANAGER", "SUPERVISOR"].includes(role)) ?? false;
  const canCertify = session?.user.roles.includes("ADMIN") ?? false;

  const loadStaging = useCallback(
    async (batchId: string, nextSkip: number) => {
      if (!session || !batchId) return;
      const params = new URLSearchParams({ take: "100", skip: String(nextSkip) });
      if (domain) params.set("domain", domain);
      if (classification) params.set("classification", classification);
      if (decision) params.set("decision", decision);
      const [nextSummary, nextStaging] = await Promise.all([
        apiGetClient<StagingSummary>(`/import/${batchId}/staging/summary`),
        apiGetClient<StagingList>(`/import/${batchId}/staging?${params}`)
      ]);
      setSummary(nextSummary);
      setStaging(nextStaging);
      setSkip(nextSkip);
      setDrafts((current) => {
        const next = { ...current };
        for (const record of nextStaging.records) {
          next[record.id] = next[record.id]?.version === record.version ? next[record.id] : {
            reason: record.resolutionReason ?? "",
            value: formattedJson(record.correctedValue ?? record.interpretedValue),
            version: record.version
          };
        }
        return next;
      });
    },
    [classification, decision, domain, session]
  );

  const loadPreview = useCallback(
    async (batchId?: string) => {
      if (!session) return;
      const query = batchId ? `?batchId=${encodeURIComponent(batchId)}` : "";
      const data = await apiGetClient<ImportPreview>(`/import/preview${query}`);
      const nextBatchId = data.batchId ?? batchId ?? "";
      setPreview(data);
      setActiveBatchId(nextBatchId);
      setMessage(nextBatchId ? "Lote carregado. Revise pendencias antes da promocao." : "Nenhuma planilha carregada.");
    },
    [session]
  );

  useEffect(() => {
    loadPreview().catch((error) => setMessage(error instanceof Error ? error.message : "Falha ao carregar lote."));
  }, [loadPreview]);

  useEffect(() => {
    if (!activeBatchId) return;
    loadStaging(activeBatchId, 0).catch((error) => setMessage(error instanceof Error ? error.message : "Falha ao filtrar staging."));
  }, [activeBatchId, classification, decision, domain, loadStaging]);

  async function uploadWorkbook() {
    if (!session) return setMessage("Entre no sistema para enviar a planilha.");
    if (!selectedFile) return setMessage("Selecione um arquivo .xlsx.");
    setLoading(true);
    setMessage("Validando XLSX e criando staging imutavel...");
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      const result = await apiUploadClient<ImportBatch>("/import/upload", formData);
      setActiveBatchId(result.id);
      setReconciliation(null);
      setCertificationReason("");
      setDomain("");
      setClassification("");
      setDecision("PENDING");
      await loadPreview(result.id);
      setMessage(`${result.stagedRecords ?? 0} registros preparados. Nenhum dado oficial foi alterado.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao enviar planilha.");
    } finally {
      setLoading(false);
    }
  }

  function updateDraft(recordId: string, field: "reason" | "value", value: string) {
    setDrafts((current) => ({
      ...current,
      [recordId]: { ...(current[recordId] ?? { reason: "", value: "null", version: 0 }), [field]: value }
    }));
  }

  function assertReason(recordId: string) {
    const reason = drafts[recordId]?.reason.trim() ?? "";
    if (reason.length < 10) throw new Error("Justificativa obrigatoria: minimo de 10 caracteres.");
    return reason;
  }

  async function reviewRecord(record: StagingRecord, action: ReviewAction) {
    setBusyRecord(record.id);
    try {
      const reason = assertReason(record.id);
      await apiPostClient(`/import/${activeBatchId}/staging/${record.id}/review`, {
        action,
        reason,
        version: record.version
      });
      await loadStaging(activeBatchId, skip);
      setMessage("Decisao registrada com auditoria e controle de concorrencia.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao registrar revisao.");
    } finally {
      setBusyRecord(null);
    }
  }

  async function correctRecord(record: StagingRecord) {
    setBusyRecord(record.id);
    try {
      const reason = assertReason(record.id);
      let value: JsonValue;
      try {
        value = JSON.parse(drafts[record.id]?.value ?? "null") as JsonValue;
      } catch {
        throw new Error("JSON corrigido invalido.");
      }
      await apiPatchClient(`/import/${activeBatchId}/staging/${record.id}`, {
        value,
        reason,
        version: record.version
      });
      await loadStaging(activeBatchId, skip);
      setMessage("Correcao validada e salva separada do valor original.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao corrigir registro.");
    } finally {
      setBusyRecord(null);
    }
  }

  async function promoteBatch() {
    if (!activeBatchId || !canPromote) return setMessage("Somente ADMIN ou MANAGER pode promover o lote.");
    setLoading(true);
    setMessage("Promovendo lote em uma unica transacao...");
    try {
      const result = await apiPostClient<{ status: string }>(`/import/${activeBatchId}/promote`, {});
      await Promise.all([loadPreview(activeBatchId), loadStaging(activeBatchId, skip)]);
      setReconciliation(null);
      setMessage(`Promocao concluida. Estado final: ${result.status}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Promocao bloqueada ou revertida.");
    } finally {
      setLoading(false);
    }
  }

  async function loadReconciliation() {
    if (!activeBatchId) return setMessage("Carregue um lote antes da reconciliacao.");
    setReconciliationLoading(true);
    setMessage("Comparando Excel, staging e PostgreSQL...");
    try {
      const report = await apiGetClient<ReconciliationReport>(`/import/${activeBatchId}/reconciliation`);
      setReconciliation(report);
      setMessage(report.certified
        ? "Reconciliação certificada e hash do dataset confirmado."
        : report.eligibleForCertification
          ? "Reconciliação confere e está pronta para certificação ADMIN."
          : report.message ?? "Reconciliação carregada; certificação permanece bloqueada pela integridade ou por pendências.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao carregar reconciliação.");
    } finally {
      setReconciliationLoading(false);
    }
  }

  async function certifyReconciliation() {
    if (!activeBatchId || !canCertify) return setMessage("Somente ADMIN pode certificar a reconciliação.");
    const reason = certificationReason.trim();
    if (reason.length < 10) return setMessage("Motivo da certificação deve ter pelo menos 10 caracteres.");
    setReconciliationLoading(true);
    setMessage("Certificando dataset reconciliado...");
    try {
      const report = await apiPostClient<ReconciliationReport>(`/import/${activeBatchId}/reconciliation/certify`, { reason });
      setReconciliation(report);
      setMessage("Reconciliação certificada. Hash do dataset registrado na auditoria.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Certificação bloqueada pela API.");
    } finally {
      setReconciliationLoading(false);
    }
  }

  const visibleErrors = preview.importErrors ?? [];
  const errorRows = visibleErrors.map((error) => ({
    Aba: error.sheetName ?? "-",
    Celula: error.cell ?? "-",
    Status: error.status ?? "PENDING",
    Erro: error.message
  }));
  const pending = summary?.totals.byDecision.PENDING ?? 0;
  const hardErrors = (summary?.totals.byClassification.ERROR ?? 0) + (summary?.totals.byClassification.DUPLICATE ?? 0);
  const promotionBlockers = summary?.totals.promotionBlockers ?? 0;
  const certificationBlockers = reconciliation ? [
    reconciliation.message,
    reconciliation.stagingToDatabaseStatus && reconciliation.stagingToDatabaseStatus !== "MATCH" ? "PostgreSQL diverge do staging." : null,
    reconciliation.excelToStagingStatus && reconciliation.excelToStagingStatus !== "MATCH" ? "Staging diverge do Excel." : null,
    reconciliation.pendingErrors > 0 ? `${reconciliation.pendingErrors} erro(s) de importação pendente(s).` : null,
    reconciliation.pendingStagingReviews > 0 ? `${reconciliation.pendingStagingReviews} revisão(ões) de staging pendente(s).` : null,
    (reconciliation.pendingOperationalApprovals ?? 0) > 0 ? `${reconciliation.pendingOperationalApprovals} lançamento(s) operacional(is) aguardando aprovação.` : null,
    !reconciliation.sourceIntegrity.independentDerivedMetrics ? reconciliation.sourceIntegrity.reason ?? "Totais de origem não são independentes." : null,
    !reconciliation.sourceIntegrity.completeReconciliationScope ? "Escopo de reconciliação ainda não cobre todos os domínios obrigatórios." : null,
    reconciliation.certificationIntegrity === "STALE" ? "Hash certificado não corresponde ao dataset atual." : null,
    reconciliation.certificationIntegrity === "LEGACY_CONTRACT" ? "Certificado legado preservado; reenvie o XLSX em novo lote para usar o contrato atual." : null,
    !["IMPORTED", "IMPORTED_WITH_ERRORS", "CERTIFIED"].includes(reconciliation.batchStatus)
      ? `Lote no estado ${reconciliation.batchStatus}; promoção oficial necessária.`
      : null
  ].filter((item): item is string => Boolean(item)) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Importacao homologavel"
        description="XLSX entra primeiro no staging. Correcao humana preserva o original; promocao oficial ocorre somente depois da revisao."
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-72 max-w-full flex-1 items-center rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm text-slate-200">
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-cyan-300/20 file:px-3 file:py-1.5 file:text-cyan-50"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <Button type="button" onClick={uploadWorkbook} disabled={loading}>
            <UploadCloud className="size-4" />
            {loading ? "Processando..." : "Enviar para staging"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => Promise.all([loadPreview(activeBatchId), activeBatchId ? loadStaging(activeBatchId, skip) : Promise.resolve()])}
            disabled={loading}
          >
            <RefreshCw className="size-4" /> Atualizar
          </Button>
          <Button type="button" onClick={promoteBatch} disabled={loading || !canPromote || !activeBatchId || promotionBlockers > 0}>
            <ShieldCheck className="size-4" /> Promover lote revisado
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={loadReconciliation}
            disabled={reconciliationLoading || !activeBatchId || !canReconcile}
            title={!canReconcile ? "Disponível para ADMIN, MANAGER e SUPERVISOR" : undefined}
          >
            <RefreshCw className={`size-4 ${reconciliationLoading ? "animate-spin" : ""}`} />
            {reconciliationLoading ? "Reconciliando..." : "Carregar reconciliação"}
          </Button>
        </div>
        <div className="mt-4 rounded-md border border-cyan-300/20 bg-cyan-300/[0.06] p-3 text-sm text-slate-200">
          <p>{message}</p>
          <p className="mt-1 text-xs text-slate-400">
            Lote: {activeBatchId || "-"} · Estado: {summary?.batch.status ?? preview.status ?? "-"} · Importador: {summary?.batch.importerVersion ?? "-"}
          </p>
          {summary?.batch.fileHash ? <p className="mt-1 break-all text-xs text-slate-500">SHA-256: {summary.batch.fileHash}</p> : null}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-5">
        <StatCard label="Abas" value={String(preview.sheetCount)} />
        <StatCard label="Staging" value={String(summary?.totals.records ?? 0)} status="OK" />
        <StatCard label="Pendentes" value={String(pending)} status={pending ? "ATTENTION" : "OK"} />
        <StatCard label="Bloqueios de promocao" value={String(promotionBlockers)} status={promotionBlockers ? "ATTENTION" : "OK"} />
        <StatCard label="Erros/duplicidades" value={String(hardErrors)} status={hardErrors ? "CRITICAL" : "OK"} />
      </div>

      {reconciliation ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Reconciliação Excel · staging · PostgreSQL</h2>
              <p className="mt-1 text-sm text-slate-400">
                Fonte: {reconciliation.sourceFile} · lote {reconciliation.batchStatus}
                {reconciliation.generatedAt ? ` · gerado em ${new Date(reconciliation.generatedAt).toLocaleString("pt-BR")}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className={`rounded-md border px-2 py-1 text-xs ${reconciliationStatusStyle(reconciliation.excelToStagingStatus ?? "SOURCE_TOTALS_UNAVAILABLE")}`}>
                Excel / staging: {reconciliation.excelToStagingStatus ?? "INDISPONÍVEL"}
              </span>
              <span className={`rounded-md border px-2 py-1 text-xs ${reconciliationStatusStyle(reconciliation.stagingToDatabaseStatus ?? reconciliation.status)}`}>
                staging / PostgreSQL: {reconciliation.stagingToDatabaseStatus ?? reconciliation.status}
              </span>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-md border border-[var(--line)] bg-black/15 p-3">
              <p className="text-xs text-slate-500">Erros pendentes</p>
              <strong className={reconciliation.pendingErrors ? "text-rose-200" : "text-emerald-200"}>{reconciliation.pendingErrors}</strong>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-black/15 p-3">
              <p className="text-xs text-slate-500">Revisões pendentes</p>
              <strong className={reconciliation.pendingStagingReviews ? "text-rose-200" : "text-emerald-200"}>{reconciliation.pendingStagingReviews}</strong>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-black/15 p-3">
              <p className="text-xs text-slate-500">Aprovações operacionais</p>
              <strong className={(reconciliation.pendingOperationalApprovals ?? 0) ? "text-rose-200" : "text-emerald-200"}>
                {reconciliation.pendingOperationalApprovals ?? "-"}
              </strong>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-black/15 p-3">
              <p className="text-xs text-slate-500">Integridade da fonte</p>
              <strong className={reconciliation.sourceIntegrity.independentDerivedMetrics && reconciliation.sourceIntegrity.completeReconciliationScope ? "text-emerald-200" : "text-rose-200"}>
                {reconciliation.sourceIntegrity.independentDerivedMetrics && reconciliation.sourceIntegrity.completeReconciliationScope ? "COMPLETA" : "NÃO COMPROVADA"}
              </strong>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-black/15 p-3">
              <p className="text-xs text-slate-500">Certificação</p>
              <strong className={reconciliation.certified ? "text-emerald-200" : "text-amber-100"}>
                {reconciliation.certified ? "CERTIFICADA" : reconciliation.certificationIntegrity}
              </strong>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-md border border-[var(--line)]">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-white/5 text-slate-400">
                <tr>
                  <th className="px-3 py-2">Métrica</th>
                  <th className="px-3 py-2 text-right">Excel</th>
                  <th className="px-3 py-2 text-right">Dif. Excel/staging</th>
                  <th className="px-3 py-2 text-right">staging</th>
                  <th className="px-3 py-2 text-right">Dif. staging/DB</th>
                  <th className="px-3 py-2 text-right">PostgreSQL</th>
                  <th className="px-3 py-2 text-right">Dif. final</th>
                  <th className="px-3 py-2">Status do fluxo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {reconciliation.metrics.map((metric) => (
                  <tr key={metric.key} className="text-slate-200">
                    <td className="px-3 py-2">
                      {metric.metric} <span className="text-slate-500">({metric.unit})</span>
                      {metric.excelUnknownValues || metric.stagingUnknownValues ? (
                        <span className="mt-1 block text-[10px] text-rose-200">
                          ausentes: Excel {metric.excelUnknownValues} · staging {metric.stagingUnknownValues}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formattedMetric(metric.excel, metric.unit)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${metric.stagingStatus === "MATCH" ? "text-slate-400" : "text-rose-200"}`}>
                      {formattedMetric(metric.stagingDifference, metric.unit)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formattedMetric(metric.staging, metric.unit)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${metric.status === "MATCH" ? "text-slate-400" : "text-rose-200"}`}>
                      {formattedMetric(metric.databaseDifference, metric.unit)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formattedMetric(metric.database, metric.unit)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${metric.status === "MATCH" && metric.stagingStatus === "MATCH" ? "text-slate-400" : "text-rose-200"}`}>
                      {formattedMetric(metric.difference, metric.unit)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex min-w-40 flex-wrap gap-1">
                        <span className={`rounded-md border px-2 py-1 ${reconciliationStatusStyle(metric.stagingStatus)}`}>
                          Excel/staging: {metric.stagingStatus}
                        </span>
                        <span className={`rounded-md border px-2 py-1 ${reconciliationStatusStyle(metric.status)}`}>
                          staging/DB: {metric.status}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reconciliation.metrics.length === 0 ? (
              <p className="p-4 text-sm text-amber-100">{reconciliation.message ?? "Totais de origem indisponíveis."}</p>
            ) : null}
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <div className="rounded-md border border-[var(--line)] bg-black/15 p-3">
              <p className="text-xs font-medium text-slate-300">Integridade da fonte</p>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-slate-400">
                {formattedJson(reconciliation.sourceIntegrity as { [key: string]: JsonValue })}
              </pre>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-black/15 p-3">
              <p className="text-xs font-medium text-slate-300">Hash imutável do dataset</p>
              <p className="mt-2 break-all font-mono text-xs text-slate-400">{reconciliation.datasetHash ?? "Indisponível enquanto origem ou dataset não forem reconciliáveis."}</p>
              <p className="mt-3 break-all text-xs text-slate-500">SHA-256 do arquivo: {reconciliation.fileHash ?? "-"}</p>
            </div>
          </div>

          {!reconciliation.eligibleForCertification && certificationBlockers.length > 0 ? (
            <div className="mt-4 rounded-md border border-rose-300/25 bg-rose-300/[0.07] p-3 text-sm text-rose-100">
              <p className="font-medium">Certificação bloqueada pelo estado real do backend:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {certificationBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
              </ul>
            </div>
          ) : null}

          <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
            <label className="min-w-72 flex-1 text-xs text-slate-400">
              Motivo da certificação ADMIN (mínimo 10 caracteres)
              <input
                value={certificationReason}
                onChange={(event) => setCertificationReason(event.target.value)}
                disabled={!canCertify || reconciliation.certified}
                placeholder="Explique por que este dataset pode ser certificado"
                className="mt-1 w-full rounded-md border border-[var(--line)] bg-slate-950 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
              />
            </label>
            <Button
              type="button"
              onClick={certifyReconciliation}
              disabled={reconciliationLoading || !canCertify || !reconciliation.eligibleForCertification || reconciliation.certified || certificationReason.trim().length < 10}
              title={!canCertify ? "Somente ADMIN" : !reconciliation.eligibleForCertification ? "Backend bloqueou certificação" : undefined}
            >
              <ShieldCheck className="size-4" /> {reconciliation.certified ? "Dataset certificado" : "Certificar reconciliação"}
            </Button>
          </div>
          {!canCertify ? <p className="mt-2 text-xs text-amber-100">Somente ADMIN pode certificar. Consulta disponível para ADMIN, MANAGER e SUPERVISOR.</p> : null}
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-400">
            Dominio
            <select
              value={domain}
              onChange={(event) => setDomain(event.target.value as "" | StagingDomain)}
              className="mt-1 block rounded-md border border-[var(--line)] bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              {domains.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Classificacao
            <select
              value={classification}
              onChange={(event) => setClassification(event.target.value as "" | StagingClassification)}
              className="mt-1 block rounded-md border border-[var(--line)] bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              {classifications.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Decisao
            <select
              value={decision}
              onChange={(event) => setDecision(event.target.value as "" | ReviewDecision)}
              className="mt-1 block rounded-md border border-[var(--line)] bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              {decisions.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <p className="ml-auto text-xs text-slate-500">
            {staging ? `${staging.pagination.skip + 1}-${Math.min(staging.pagination.skip + staging.records.length, staging.pagination.total)} de ${staging.pagination.total}` : "0 registros"}
          </p>
        </div>
      </Card>

      <div className="space-y-4">
        {staging?.records.map((record) => {
          const draft = drafts[record.id] ?? {
            reason: "",
            value: formattedJson(record.correctedValue ?? record.interpretedValue),
            version: record.version
          };
          const busy = busyRecord === record.id;
          const quarantined = record.domain === "DOSAGE" || record.domain === "HISTORY";
          const cannotApprove = quarantined || record.classification === "ERROR" || record.classification === "DUPLICATE";
          return (
            <Card key={record.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-100">{record.sheetName ?? "Aba desconhecida"} · linha {record.rowNumber ?? "-"} · {record.cell ?? "-"}</p>
                  <p className="mt-1 text-xs text-slate-500">{record.domain} · versao {record.version} · ID {record.id}</p>
                </div>
                <div className="flex gap-2">
                  <span className={`rounded-md border px-2 py-1 text-xs ${classificationStyle(record.classification)}`}>{record.classification}</span>
                  <span className={`rounded-md border px-2 py-1 text-xs ${decisionStyle(record.decision)}`}>{record.decision}</span>
                </div>
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-3">
                <label className="text-xs text-slate-400">
                  Original imutavel
                  <textarea readOnly value={formattedJson(record.rawOriginal)} className="mt-1 h-44 w-full resize-y rounded-md border border-[var(--line)] bg-black/20 p-3 font-mono text-xs text-slate-400" />
                </label>
                <label className="text-xs text-slate-400">
                  Interpretado
                  <textarea readOnly value={formattedJson(record.interpretedValue)} className="mt-1 h-44 w-full resize-y rounded-md border border-[var(--line)] bg-black/20 p-3 font-mono text-xs text-slate-300" />
                </label>
                <label className="text-xs text-slate-400">
                  Correcao proposta (JSON)
                  <textarea
                    value={draft.value}
                    onChange={(event) => updateDraft(record.id, "value", event.target.value)}
                    disabled={record.domain === "UNKNOWN" || quarantined || Boolean(record.promotedEntityId)}
                    className="mt-1 h-44 w-full resize-y rounded-md border border-cyan-300/20 bg-slate-950 p-3 font-mono text-xs text-slate-100 disabled:opacity-50"
                  />
                </label>
              </div>

              <div className="mt-3 rounded-md border border-amber-300/15 bg-amber-300/[0.05] p-3 text-xs text-amber-100">
                <div className="flex gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" /><pre className="whitespace-pre-wrap font-sans">{formattedJson(record.validationIssues)}</pre></div>
              </div>

              <label className="mt-3 block text-xs text-slate-400">
                Justificativa humana (10 a 1000 caracteres)
                <input
                  value={draft.reason}
                  onChange={(event) => updateDraft(record.id, "reason", event.target.value)}
                  placeholder="Explique a decisao sem apagar o valor original"
                  className="mt-1 w-full rounded-md border border-[var(--line)] bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </label>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" onClick={() => correctRecord(record)} disabled={busy || record.domain === "UNKNOWN" || quarantined || Boolean(record.promotedEntityId)}>
                  Salvar correcao
                </Button>
                <Button type="button" variant="secondary" onClick={() => reviewRecord(record, "APPROVE")} disabled={busy || cannotApprove || Boolean(record.promotedEntityId)}>
                  <Check className="size-4" /> Aprovar
                </Button>
                <Button type="button" variant="secondary" onClick={() => reviewRecord(record, "IGNORE")} disabled={busy || Boolean(record.promotedEntityId)}>
                  Ignorar
                </Button>
                <Button type="button" variant="danger" onClick={() => reviewRecord(record, "REJECT")} disabled={busy || Boolean(record.promotedEntityId)}>
                  <X className="size-4" /> Rejeitar
                </Button>
              </div>
            </Card>
          );
        })}
        {staging && staging.records.length === 0 ? <Card><p className="text-sm text-slate-400">Nenhum registro para os filtros atuais.</p></Card> : null}
      </div>

      {staging && staging.pagination.total > staging.pagination.take ? (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => loadStaging(activeBatchId, Math.max(0, skip - staging.pagination.take))} disabled={skip === 0}>Anterior</Button>
          <Button variant="secondary" onClick={() => loadStaging(activeBatchId, skip + staging.pagination.take)} disabled={!staging.pagination.hasMore}>Proxima</Button>
        </div>
      ) : null}

      <DataTable title="Erros do parser legado" rows={errorRows} />
    </div>
  );
}
