import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { z } from "zod";

export const recordVersionSchema = z.coerce.number().int().positive();
export const workflowReasonSchema = z.string().trim().min(5, "Informe um motivo com pelo menos 5 caracteres.").max(1000);

export const versionedCommandSchema = z
  .object({
    version: recordVersionSchema
  })
  .strict();

export const versionedOptionalReasonCommandSchema = z
  .object({
    version: recordVersionSchema,
    reason: workflowReasonSchema.optional()
  })
  .strict();

export const versionedReasonCommandSchema = z
  .object({
    version: recordVersionSchema,
    reason: workflowReasonSchema
  })
  .strict();

export function assertCurrentVersion(currentVersion: number, expectedVersion: number) {
  if (currentVersion !== expectedVersion) {
    throw new ConflictException("Registro foi alterado por outro usuario. Recarregue os dados e tente novamente.");
  }
}

export function assertWorkflowState(current: string, allowed: string[], action: string) {
  if (!allowed.includes(current)) {
    throw new BadRequestException(`Registro em estado ${current} nao permite ${action}.`);
  }
}

export function assertCanAmendApproved(current: string, roles: string[] = []) {
  if (current !== "APPROVED") return;
  if (!roles.some((role) => ["ADMIN", "MANAGER", "SUPERVISOR"].includes(role))) {
    throw new ForbiddenException("Somente supervisao ou administracao pode emendar um lancamento aprovado.");
  }
}

export function assertIndependentApprover(submittedBy: string | null | undefined, approverId: string) {
  if (submittedBy && submittedBy === approverId) {
    throw new ForbiddenException("O usuario que submeteu o lancamento nao pode aprovar o proprio registro.");
  }
}

export function isPrismaOptimisticConflict(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2025");
}

export function throwOptimisticConflict(error: unknown): never {
  if (isPrismaOptimisticConflict(error)) {
    throw new ConflictException("Registro foi alterado por outro usuario. Recarregue os dados e tente novamente.");
  }
  throw error;
}
