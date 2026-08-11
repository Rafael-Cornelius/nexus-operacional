"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Eye, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard, StatusBadge } from "@/components/ui/card";
import { apiGetClient, apiPostClient, DEMO_MODE, getSession } from "@/services/api";

type RegistryStatus = "ACTIVE" | "REVIEW_REQUIRED";
type GovernanceStatus = "NOT_REQUIRED" | "PENDING_REVIEW" | "APPROVED" | "RETIRED";

interface RuleDecision {
  id: string;
  status: "APPROVED" | "RETIRED";
  approvedAt: string;
  approvalReason: string;
  retiredAt?: string | null;
  retirementReason?: string | null;
  approver: { id: string; name: string; email: string };
  retirer?: { id: string; name: string; email: string } | null;
}

interface CalculationRuleRow {
  id: string;
  name: string;
  version: number;
  formula: string;
  description: string;
  unit: string;
  inputs: Array<{ name: string; unit: string; required: boolean; description: string }>;
  missingValueTreatment: string;
  evidence: string[];
  status: RegistryStatus;
  ambiguity?: string;
  governanceStatus: GovernanceStatus;
  approval: RuleDecision | null;
}

function governanceLabel(status: GovernanceStatus) {
  if (status === "NOT_REQUIRED") return "Ativa no registry";
  if (status === "PENDING_REVIEW") return "Revisão pendente";
  if (status === "APPROVED") return "Aprovada";
  return "Retirada";
}

function badgeStatus(status: GovernanceStatus) {
  if (status === "NOT_REQUIRED" || status === "APPROVED") return "OK";
  if (status === "RETIRED") return "CRITICAL";
  return "ATTENTION";
}

export default function SettingsPage() {
  const session = useMemo(() => getSession(), []);
  const isAdmin = session?.user.roles.includes("ADMIN") ?? false;
  const [rules, setRules] = useState<CalculationRuleRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("Aguardando administrador para carregar regras reais.");
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");

  const selected = rules.find((rule) => rule.id === selectedId) ?? null;
  const reviewRequired = rules.filter((rule) => rule.status === "REVIEW_REQUIRED");
  const approved = reviewRequired.filter((rule) => rule.governanceStatus === "APPROVED").length;
  const pending = reviewRequired.filter((rule) => rule.governanceStatus === "PENDING_REVIEW").length;

  async function loadRules() {
    if (DEMO_MODE) {
      setRules([]);
      setMessage("Preview isolado não governa regras. Conecte API operacional autenticada.");
      return;
    }
    if (!isAdmin) {
      setRules([]);
      setMessage("Somente ADMIN pode revisar decisões de regras de cálculo.");
      return;
    }
    setLoading(true);
    try {
      const rows = await apiGetClient<CalculationRuleRow[]>("/calculation-rules");
      setRules(rows);
      setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? "");
      setMessage(`${rows.length} regra(s) carregada(s) do registry; nenhuma decisão é automática.`);
    } catch (error) {
      setRules([]);
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar regras da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRules();
  }, []);

  async function decide(rule: CalculationRuleRow, action: "approve" | "retire") {
    if (!isAdmin) return setMessage("Somente ADMIN pode decidir regras.");
    if (reason.trim().length < 10) {
      setMessage("Informe motivo com ao menos 10 caracteres.");
      return;
    }
    const verb = action === "approve" ? "aprovar" : "retirar";
    if (!window.confirm(`Confirma ${verb} ${rule.id}, versão ${rule.version}?`)) return;

    const key = `${rule.id}:${rule.version}`;
    setBusyKey(key);
    try {
      await apiPostClient(
        `/calculation-rules/${encodeURIComponent(rule.id)}/versions/${rule.version}/${action}`,
        { reason }
      );
      setReason("");
      await loadRules();
      setSelectedId(rule.id);
      setMessage(action === "approve"
        ? "Regra aprovada por decisão humana auditada."
        : "Regra retirada; decisão histórica preservada e reativação bloqueada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao registrar decisão.");
    } finally {
      setBusyKey("");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Configurações"
        description="Revisão humana versionada das regras de cálculo. Fórmulas ambíguas nunca recebem aprovação automática."
      />

      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={loadRules} disabled={loading}>
          <RefreshCw className="size-4" />
          {loading ? "Carregando..." : "Atualizar registry"}
        </Button>
      </div>

      <Card>
        <p className="text-sm text-slate-200">{message}</p>
        <label className="mt-4 block space-y-2">
          <span className="text-xs uppercase text-slate-400">Motivo obrigatório da decisão</span>
          <textarea
            className="min-h-24 w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="Registre evidência revisada, responsável pela validação e justificativa operacional."
            disabled={!isAdmin || Boolean(busyKey)}
          />
        </label>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Regras no registry" value={String(rules.length)} />
        <StatCard label="Exigem revisão" value={String(reviewRequired.length)} status={reviewRequired.length ? "ATTENTION" : "OK"} />
        <StatCard label="Aprovadas" value={String(approved)} status="OK" />
        <StatCard label="Pendentes" value={String(pending)} status={pending ? "CRITICAL" : "OK"} />
      </div>

      {selected ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase text-slate-400">{selected.id} · versão {selected.version}</p>
              <h2 className="mt-1 text-lg font-semibold">{selected.name}</h2>
            </div>
            <StatusBadge status={badgeStatus(selected.governanceStatus)} />
          </div>
          <p className="mt-4 text-sm text-slate-300">{selected.description}</p>
          <div className="mt-4 rounded-md border border-[var(--line)] bg-black/20 p-4">
            <p className="text-xs uppercase text-slate-400">Fórmula preservada no registry</p>
            <code className="mt-2 block overflow-x-auto text-sm text-cyan-100">{selected.formula}</code>
          </div>
          {selected.ambiguity ? (
            <div className="mt-4 rounded-md border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100">
              <strong className="flex items-center gap-2"><ShieldAlert className="size-4" /> Ambiguidade registrada</strong>
              <p className="mt-2">{selected.ambiguity}</p>
            </div>
          ) : null}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold">Entradas e tratamento</h3>
              <ul className="mt-2 space-y-2 text-sm text-slate-300">
                {selected.inputs.map((input) => (
                  <li key={input.name}><code>{input.name}</code> ({input.unit}) · {input.required ? "obrigatória" : "opcional"} — {input.description}</li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-slate-400">Ausências: {selected.missingValueTreatment}</p>
            </div>
            <div>
              <h3 className="text-sm font-semibold">Evidências registradas</h3>
              <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-slate-300">
                {selected.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}
              </ul>
            </div>
          </div>
          {selected.approval ? (
            <div className="mt-4 rounded-md border border-[var(--line)] p-4 text-sm text-slate-300">
              <p>Aprovada por {selected.approval.approver.name} em {new Date(selected.approval.approvedAt).toLocaleString("pt-BR")}.</p>
              <p className="mt-1">Motivo: {selected.approval.approvalReason}</p>
              {selected.approval.retiredAt ? (
                <p className="mt-2 text-rose-200">Retirada por {selected.approval.retirer?.name ?? "administrador"}: {selected.approval.retirementReason}</p>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <DataTable
        title="Registry e decisões humanas"
        rows={rules.map((rule) => ({
          Regra: rule.name,
          ID: <code>{rule.id}</code>,
          Versão: String(rule.version),
          Registry: rule.status,
          Governança: governanceLabel(rule.governanceStatus),
          Revisão: (
            <span className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => setSelectedId(rule.id)}>
                <Eye className="size-4" /> Revisar
              </Button>
              {rule.status === "REVIEW_REQUIRED" && rule.governanceStatus === "PENDING_REVIEW" ? (
                <Button type="button" onClick={() => decide(rule, "approve")} disabled={busyKey === `${rule.id}:${rule.version}`}>
                  <CheckCircle2 className="size-4" /> Aprovar
                </Button>
              ) : null}
              {rule.governanceStatus === "APPROVED" ? (
                <Button type="button" variant="danger" onClick={() => decide(rule, "retire")} disabled={busyKey === `${rule.id}:${rule.version}`}>
                  <XCircle className="size-4" /> Retirar
                </Button>
              ) : null}
            </span>
          )
        }))}
      />
    </div>
  );
}
