import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLocalWorkflowTransition,
  availableWorkflowActions,
  workflowEndpoint,
  workflowReasonError,
  type WorkflowEntry
} from "../../apps/web/lib/operational-workflow";
import { createDemoDowntimeEntries, createDemoLossEntries, createDemoProductionEntries } from "../../apps/web/lib/demo/workflow-preview";
import { apiPostClient, isApiConflict } from "../../apps/web/services/api";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("frontend operational workflow", () => {
  it("exposes actions only for the roles and states accepted by the API", () => {
    expect(availableWorkflowActions("DRAFT", ["OPERATOR"])).toEqual(["submit"]);
    expect(availableWorkflowActions("REJECTED", ["SUPERVISOR"])).toEqual(["submit"]);
    expect(availableWorkflowActions("SUBMITTED", ["MANAGER"])).toEqual(["approve", "reject"]);
    expect(availableWorkflowActions("UNDER_REVIEW", ["SUPERVISOR"])).toEqual(["approve", "reject"]);
    expect(availableWorkflowActions("SUBMITTED", ["OPERATOR"])).toEqual([]);
    expect(availableWorkflowActions("APPROVED", ["ADMIN"])).toEqual([]);
  });

  it("builds the versioned transition endpoints and requires a review reason", () => {
    expect(workflowEndpoint("production", "entry/1", "submit")).toBe("/production/entry%2F1/submit");
    expect(workflowEndpoint("losses", "loss-1", "approve")).toBe("/losses/loss-1/approve");
    expect(workflowEndpoint("dosage", "dosage-1", "reject")).toBe("/dosage/dosage-1/reject");
    expect(workflowEndpoint("productivity", "productivity-1", "submit")).toBe("/productivity/productivity-1/submit");
    expect(workflowReasonError("submit", "")).toBeNull();
    expect(workflowReasonError("approve", "curto")).toBeNull();
    expect(workflowReasonError("reject", "não")).toContain("5 caracteres");
  });

  it("applies demo transitions locally and increments the optimistic version", () => {
    const draft: WorkflowEntry = { id: "demo-1", workflowStatus: "DRAFT", version: 1 };
    const submitted = applyLocalWorkflowTransition(draft, "submit", "Conferência concluída");
    expect(submitted).toMatchObject({ workflowStatus: "SUBMITTED", version: 2, submissionReason: "Conferência concluída" });

    const approved = applyLocalWorkflowTransition(submitted, "approve", "Valores validados");
    expect(approved).toMatchObject({ workflowStatus: "APPROVED", version: 3, approvalReason: "Valores validados" });

    const rejected = applyLocalWorkflowTransition({ ...submitted, version: 4 }, "reject", "Horário inconsistente");
    expect(rejected).toMatchObject({ workflowStatus: "REJECTED", version: 5, rejectionReason: "Horário inconsistente" });
    expect(() => applyLocalWorkflowTransition(approved, "reject", "Tentativa inválida")).toThrow("não permite");
  });

  it("keeps representative workflow states in every local demo dataset", () => {
    for (const entries of [createDemoProductionEntries("P1"), createDemoLossEntries(), createDemoDowntimeEntries()]) {
      expect(entries.map((entry) => entry.workflowStatus)).toEqual(expect.arrayContaining(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"]));
      expect(entries.every((entry) => Number.isInteger(entry.version) && entry.version > 0)).toBe(true);
    }
  });

  it("preserves HTTP 409 so the UI can reload a stale record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: vi.fn().mockResolvedValue({ message: "Registro foi alterado por outro usuário." })
      })
    );

    const error = await apiPostClient("/production/id/submit", { version: 1 }).catch((caught) => caught);
    expect(isApiConflict(error)).toBe(true);
    expect(error).toMatchObject({ status: 409, message: "Registro foi alterado por outro usuário." });
  });

  it("integrates the shared actions and demo mode into production, losses and downtime", () => {
    const paths = [
      "apps/web/components/forms/production-form.tsx",
      "apps/web/app/perdas/page.tsx",
      "apps/web/app/paradas/page.tsx",
      "apps/web/app/dosagem/page.tsx",
      "apps/web/app/produtividade/page.tsx"
    ];
    for (const relativePath of paths) {
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      expect(source, relativePath).toContain("EntryWorkflowActions");
      expect(source, relativePath).toContain("DEMO_MODE");
      expect(source, relativePath).toContain('workflowStatus: "DRAFT"');
      expect(source, relativePath).toContain("version: 1");
    }
  });
});
