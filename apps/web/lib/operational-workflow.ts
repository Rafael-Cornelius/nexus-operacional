export type WorkflowStatus = "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "CANCELLED";
export type WorkflowAction = "submit" | "approve" | "reject";
export type WorkflowResource = "production" | "losses" | "downtime" | "dosage" | "productivity";

export interface WorkflowEntry {
  id: string;
  version: number;
  workflowStatus: WorkflowStatus;
  submittedAt?: string | null;
  submittedBy?: string | null;
  submissionReason?: string | null;
  approvedAt?: string | null;
  approvedBy?: string | null;
  approvalReason?: string | null;
  rejectedAt?: string | null;
  rejectedBy?: string | null;
  rejectionReason?: string | null;
}

const submitRoles = new Set(["ADMIN", "SUPERVISOR", "OPERATOR"]);
const reviewRoles = new Set(["ADMIN", "MANAGER", "SUPERVISOR"]);

export const workflowStatusLabels: Record<WorkflowStatus, string> = {
  DRAFT: "Rascunho",
  SUBMITTED: "Enviado",
  UNDER_REVIEW: "Em revisão",
  APPROVED: "Aprovado",
  REJECTED: "Rejeitado",
  CANCELLED: "Cancelado"
};

export function availableWorkflowActions(status: WorkflowStatus, roles: string[]): WorkflowAction[] {
  const canSubmit = roles.some((role) => submitRoles.has(role));
  const canReview = roles.some((role) => reviewRoles.has(role));
  if ((status === "DRAFT" || status === "REJECTED") && canSubmit) return ["submit"];
  if ((status === "SUBMITTED" || status === "UNDER_REVIEW") && canReview) return ["approve", "reject"];
  return [];
}

export function workflowEndpoint(resource: WorkflowResource, id: string, action: WorkflowAction) {
  return `/${resource}/${encodeURIComponent(id)}/${action}`;
}

export function workflowReasonError(action: WorkflowAction, reason: string) {
  const normalized = reason.trim();
  if ((action === "approve" || action === "reject") && normalized.length < 5) {
    return "Informe um motivo com pelo menos 5 caracteres.";
  }
  if (normalized.length > 0 && normalized.length < 5) {
    return "O motivo informado precisa ter pelo menos 5 caracteres.";
  }
  return null;
}

export function workflowSuccessMessage(action: WorkflowAction) {
  if (action === "submit") return "Registro enviado para aprovação.";
  if (action === "approve") return "Registro aprovado e liberado para os indicadores.";
  return "Registro rejeitado e devolvido para correção.";
}

export function applyLocalWorkflowTransition<T extends WorkflowEntry>(entry: T, action: WorkflowAction, reason: string, actorId = "demo-user"): T {
  const normalizedReason = reason.trim();
  const reasonError = workflowReasonError(action, normalizedReason);
  if (reasonError) throw new Error(reasonError);

  const allowed =
    (action === "submit" && (entry.workflowStatus === "DRAFT" || entry.workflowStatus === "REJECTED")) ||
    ((action === "approve" || action === "reject") && (entry.workflowStatus === "SUBMITTED" || entry.workflowStatus === "UNDER_REVIEW"));
  if (!allowed) throw new Error(`O estado ${workflowStatusLabels[entry.workflowStatus]} não permite esta ação.`);

  const now = new Date().toISOString();
  const common = { version: entry.version + 1 };
  if (action === "submit") {
    return {
      ...entry,
      ...common,
      workflowStatus: "SUBMITTED",
      submittedAt: now,
      submittedBy: actorId,
      submissionReason: normalizedReason || null,
      approvedAt: null,
      approvedBy: null,
      approvalReason: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null
    };
  }
  if (action === "approve") {
    return {
      ...entry,
      ...common,
      workflowStatus: "APPROVED",
      approvedAt: now,
      approvedBy: actorId,
      approvalReason: normalizedReason,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null
    };
  }
  return {
    ...entry,
    ...common,
    workflowStatus: "REJECTED",
    rejectedAt: now,
    rejectedBy: actorId,
    rejectionReason: normalizedReason,
    approvedAt: null,
    approvedBy: null,
    approvalReason: null
  };
}
