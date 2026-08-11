import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateOperationalGoal,
  normalizeGoalMetric
} from "../../apps/api/src/domain/goals/goal-evaluation";
import { DashboardService } from "../../apps/api/src/modules/dashboard/dashboard.service";
import { GoalsService } from "../../apps/api/src/modules/goals/goals.service";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

describe("goal metric normalization and evaluation", () => {
  it("normalizes every legacy metric used by the seed", () => {
    expect(normalizeGoalMetric("yield_percent")).toBe("yield");
    expect(normalizeGoalMetric("overweight_percent")).toBe("overweight");
    expect(normalizeGoalMetric("production_kg")).toBe("produced_kg");
    expect(normalizeGoalMetric("loss")).toBe("losses_kg");
    expect(normalizeGoalMetric("downtime")).toBe("downtime_minutes");
  });

  it("normalizes existing rows in migration 0010 and keeps the seed canonical", () => {
    const migration = readFileSync(
      join(repoRoot, "prisma/migrations/0010_normalize_goal_metrics/migration.sql"),
      "utf8"
    );
    const seed = readFileSync(join(repoRoot, "prisma/seed.ts"), "utf8");

    for (const alias of ["yield_percent", "overweight_percent", "production_kg", "loss", "downtime"]) {
      expect(migration).toContain(`'${alias}'`);
    }
    expect(seed).not.toMatch(/metric:\s*"(?:yield_percent|overweight_percent|production_kg)"/);
  });

  it("respects higher-is-better and lower-is-better comparators", () => {
    expect(evaluateOperationalGoal({ metric: "produced_kg", value: 21_000, target: 20_000, comparator: ">=" }))
      .toMatchObject({ achieved: true, status: "OK", progress: 1 });
    expect(evaluateOperationalGoal({ metric: "produced_kg", value: 18_500, target: 20_000, comparator: ">=" }))
      .toMatchObject({ achieved: false, status: "ATTENTION" });
    expect(evaluateOperationalGoal({ metric: "losses_kg", value: 45, target: 50, comparator: "<=" }))
      .toMatchObject({ achieved: true, status: "OK", progress: 1 });
    expect(evaluateOperationalGoal({ metric: "losses_kg", value: 70, target: 50, comparator: "<=" }))
      .toMatchObject({ achieved: false, status: "CRITICAL" });
  });

  it("evaluates active goals with their own sector scope", async () => {
    const aggregate = vi.fn()
      .mockResolvedValueOnce({ _sum: { producedKg: 100 }, _avg: { realYieldPercent: 0.96, overweightPercent: 0.01 } })
      .mockResolvedValueOnce({ _sum: { producedKg: 80 }, _avg: { realYieldPercent: 0.8, overweightPercent: 0.03 } });
    const prisma = {
      goal: {
        findMany: vi.fn().mockResolvedValue([
          { id: "goal-p1", name: "P1", metric: "yield_percent", sectorCode: "P1", targetValue: 0.95, comparator: ">=", active: true, deletedAt: null },
          { id: "goal-p2", name: "P2", metric: "yield", sectorCode: "P2", targetValue: 0.95, comparator: ">=", active: true, deletedAt: null }
        ])
      },
      productionEntry: { aggregate }
    };
    const service = new GoalsService(prisma as never, { record: vi.fn() } as never);

    const alerts = await service.activeAlerts("week-1");

    expect(aggregate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ weekId: "week-1", sector: { code: "P1" }, workflowStatus: "APPROVED" })
    }));
    expect(aggregate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ weekId: "week-1", sector: { code: "P2" }, workflowStatus: "APPROVED" })
    }));
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: "goal-p1", metric: "yield", value: 0.96, status: "OK", sectorCode: "P1" }),
      expect.objectContaining({ goalId: "goal-p2", metric: "yield", value: 0.8, status: "CRITICAL", sectorCode: "P2" })
    ]));
  });

  it("keeps dashboard alerts on the centralized goal evaluator", async () => {
    const activeAlerts = vi.fn().mockResolvedValue([{ goalId: "goal-1", status: "OK" }]);
    const dashboard = new DashboardService({} as never, { activeAlerts } as never);

    await expect(dashboard.alerts("week-1")).resolves.toEqual([{ goalId: "goal-1", status: "OK" }]);
    expect(activeAlerts).toHaveBeenCalledWith("week-1");
  });
});
