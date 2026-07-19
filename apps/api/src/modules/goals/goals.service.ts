import { Injectable } from "@nestjs/common";
import type { Goal } from "@prisma/client";
import { z } from "zod";
import {
  evaluateOperationalGoal,
  type CanonicalGoalMetric,
  type GoalComparator,
  normalizeGoalMetric
} from "../../domain/goals/goal-evaluation";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const goalSchema = z.object({
  name: z.string().min(2),
  metric: z.enum(["yield", "overweight", "losses_kg", "downtime_minutes", "produced_kg"]),
  sectorCode: z.enum(["P1", "P2"]).optional(),
  targetValue: z.coerce.number().nonnegative(),
  comparator: z.enum(["<=", ">=", "<", ">", "="]).default("<="),
  cadence: z.enum(["DAILY", "WEEKLY"]).default("WEEKLY"),
  dueDate: z.coerce.date().optional(),
  active: z.boolean().default(true)
});

function n(value: unknown): number {
  return Number(value ?? 0);
}

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(weekId?: string) {
    const goals = await this.prisma.goal.findMany({ where: { deletedAt: null }, orderBy: { metric: "asc" } });
    return Promise.all(goals.map((goal) => this.evaluate(goal, weekId)));
  }

  async activeAlerts(weekId?: string) {
    const goals = await this.prisma.goal.findMany({
      where: { deletedAt: null, active: true },
      orderBy: [{ metric: "asc" }, { sectorCode: "asc" }, { name: "asc" }]
    });
    return Promise.all(goals.map((goal) => this.evaluate(goal, weekId)));
  }

  async create(payload: unknown, user?: CurrentUser) {
    const goal = await this.prisma.goal.create({ data: goalSchema.parse(payload) });
    await this.audit.record({
      userId: this.safeUserId(user),
      module: "goals",
      action: "create",
      entity: "Goal",
      entityId: goal.id,
      after: goal
    });
    return goal;
  }

  private async evaluate(goal: Goal, weekId?: string) {
    const metric = normalizeGoalMetric(goal.metric);
    const targetValue = n(goal.targetValue);
    if (!metric) {
      return {
        ...goal,
        goalId: goal.id,
        targetValue,
        target: targetValue,
        value: 0,
        currentValue: 0,
        progress: 0,
        achieved: false,
        status: "CRITICAL" as const,
        action: `Metrica nao suportada: ${goal.metric}. Normalize o cadastro antes de usar este indicador.`
      };
    }

    const currentValue = await this.metricValue(metric, weekId, goal.sectorCode ?? undefined);
    const evaluation = evaluateOperationalGoal({
      metric,
      value: currentValue,
      target: targetValue,
      comparator: goal.comparator as GoalComparator
    });
    return {
      ...goal,
      goalId: goal.id,
      metric,
      targetValue,
      target: targetValue,
      value: currentValue,
      currentValue,
      ...evaluation
    };
  }

  private async metricValue(metric: CanonicalGoalMetric, weekId?: string, sectorCode?: "P1" | "P2") {
    const productionWhere = { deletedAt: null, workflowStatus: "APPROVED" as const, weekId, sector: sectorCode ? { code: sectorCode } : undefined };
    if (metric === "downtime_minutes") {
      const result = await this.prisma.downtimeEntry.aggregate({
        where: { deletedAt: null, workflowStatus: "APPROVED", weekId, sector: sectorCode ? { code: sectorCode } : undefined },
        _sum: { stoppedMinutes: true }
      });
      return n(result._sum.stoppedMinutes);
    }
    const result = await this.prisma.productionEntry.aggregate({
      where: productionWhere,
      _sum: { producedKg: true, weighingLossKg: true, overweightTotalKg: true },
      _avg: { realYieldPercent: true, overweightPercent: true }
    });
    if (metric === "produced_kg") return n(result._sum.producedKg);
    if (metric === "losses_kg") {
      const losses = await this.prisma.lossEntry.aggregate({
        where: { deletedAt: null, workflowStatus: "APPROVED", weekId, sector: sectorCode ? { code: sectorCode } : undefined },
        _sum: { quantityKg: true }
      });
      return n(result._sum.weighingLossKg) + n(losses._sum.quantityKg);
    }
    if (metric === "overweight") return n(result._avg.overweightPercent);
    return n(result._avg.realYieldPercent);
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
