"use client";

import { useState } from "react";
import { Check, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/format";
import {
  applyLocalWorkflowTransition,
  availableWorkflowActions,
  workflowEndpoint,
  workflowReasonError,
  workflowStatusLabels,
  workflowSuccessMessage,
  type WorkflowAction,
  type WorkflowEntry,
  type WorkflowResource,
  type WorkflowStatus
} from "@/lib/operational-workflow";
import { apiPostClient, isApiConflict } from "@/services/api";

interface EntryWorkflowActionsProps<T extends WorkflowEntry> {
  entry: T;
  resource: WorkflowResource;
  roles: string[];
  demo: boolean;
  actorId?: string;
  disabled?: boolean;
  onChanged: (entry: T) => void | Promise<void>;
  onReload: () => void | Promise<void>;
  onMessage: (message: string) => void;
}

const statusColors: Record<WorkflowStatus, string> = {
  DRAFT: "border-slate-300/30 bg-slate-300/10 text-slate-200",
  SUBMITTED: "border-cyan-300/30 bg-cyan-300/10 text-cyan-100",
  UNDER_REVIEW: "border-violet-300/30 bg-violet-300/10 text-violet-100",
  APPROVED: "border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
  REJECTED: "border-rose-300/30 bg-rose-300/10 text-rose-100",
  CANCELLED: "border-slate-500/30 bg-slate-500/10 text-slate-300"
};

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  return <span className={cn("inline-flex rounded-md border px-2 py-1 text-xs font-medium", statusColors[status])}>{workflowStatusLabels[status]}</span>;
}

export function EntryWorkflowActions<T extends WorkflowEntry>({
  entry,
  resource,
  roles,
  demo,
  actorId,
  disabled,
  onChanged,
  onReload,
  onMessage
}: EntryWorkflowActionsProps<T>) {
  const [reason, setReason] = useState("");
  const [pendingAction, setPendingAction] = useState<WorkflowAction | null>(null);
  const actions = availableWorkflowActions(entry.workflowStatus, roles);
  const needsReviewReason = actions.includes("approve") || actions.includes("reject");

  async function execute(action: WorkflowAction) {
    const reasonError = workflowReasonError(action, reason);
    if (reasonError) {
      onMessage(reasonError);
      return;
    }

    setPendingAction(action);
    try {
      const updated = demo
        ? applyLocalWorkflowTransition(entry, action, reason, actorId)
        : await apiPostClient<T>(workflowEndpoint(resource, entry.id, action), {
            version: entry.version,
            ...(reason.trim() ? { reason: reason.trim() } : {})
          });
      await onChanged(updated);
      setReason("");
      onMessage(`${workflowSuccessMessage(action)}${demo ? " Alteração aplicada somente neste preview." : ""}`);
    } catch (error) {
      if (isApiConflict(error)) {
        try {
          await onReload();
          onMessage(`${error.message} Os dados foram recarregados; revise a versão antes de tentar novamente.`);
        } catch {
          onMessage(`${error.message} Atualize a tabela antes de tentar novamente.`);
        }
      } else {
        onMessage(error instanceof Error ? error.message : "Não foi possível atualizar o fluxo do registro.");
      }
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="min-w-64 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <WorkflowStatusBadge status={entry.workflowStatus} />
        <span className="text-xs text-slate-400">versão {entry.version}</span>
      </div>
      {actions.length ? (
        <>
          <input
            aria-label={needsReviewReason ? "Motivo da decisão" : "Motivo do envio"}
            className="w-full rounded-md border border-[var(--line)] bg-white/5 px-2 py-1.5 text-xs outline-none focus:border-cyan-300/60"
            placeholder={needsReviewReason ? "Motivo obrigatório da decisão" : "Motivo do envio (opcional)"}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={disabled || Boolean(pendingAction)}
          />
          <div className="flex flex-wrap gap-2">
            {actions.includes("submit") ? (
              <Button type="button" className="px-2.5 py-1.5 text-xs" onClick={() => execute("submit")} disabled={disabled || Boolean(pendingAction)}>
                <Send className="size-3.5" />
                {pendingAction === "submit" ? "Enviando..." : "Enviar"}
              </Button>
            ) : null}
            {actions.includes("approve") ? (
              <Button type="button" className="border-emerald-300/30 bg-emerald-300/10 px-2.5 py-1.5 text-xs hover:bg-emerald-300/20" onClick={() => execute("approve")} disabled={disabled || Boolean(pendingAction)}>
                <Check className="size-3.5" />
                {pendingAction === "approve" ? "Aprovando..." : "Aprovar"}
              </Button>
            ) : null}
            {actions.includes("reject") ? (
              <Button type="button" variant="danger" className="px-2.5 py-1.5 text-xs" onClick={() => execute("reject")} disabled={disabled || Boolean(pendingAction)}>
                <X className="size-3.5" />
                {pendingAction === "reject" ? "Rejeitando..." : "Rejeitar"}
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-xs text-slate-500">
          {entry.workflowStatus === "APPROVED"
            ? "Liberado nos indicadores."
            : entry.workflowStatus === "CANCELLED"
              ? "Registro cancelado."
              : "Seu perfil não possui ação disponível neste estado."}
        </p>
      )}
      {entry.workflowStatus === "REJECTED" && entry.rejectionReason ? <p className="text-xs text-rose-200">Última rejeição: {entry.rejectionReason}</p> : null}
    </div>
  );
}
