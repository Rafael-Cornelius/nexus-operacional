import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { recommendedAction } from "../../domain/alerts/alert-engine";
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

function satisfies(value: number, target: number, comparator: string) {
  if (comparator === ">=") return value >= target;
  if (comparator === "<") return value < target;
  if (comparator === ">") return value > target;
  if (comparator === "=") return value === target;
  return value <= target;
}

function progress(value: number, target: number, comparator: string) {
  if (target === 0) return value === 0 ? 1 : 0;
  if (comparator === ">=" || comparator === ">") return Math.min(Math.max(value / target, 0), 1);
  if (comparator === "=") return value === target ? 1 : Math.max(0, 1 - Math.abs(value - target) / target);
  return value <= target ? 1 : Math.max(0, Math.min(target / value, 1));
}

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(weekId?: string) {
    const goals = await this.prisma.goal.findMany({ where: { deletedAt: null }, orderBy: { metric: "asc" } });
    const scoped = await Promise.all(goals.map(async (goal) => ({
      ...goal,
      currentValue: await this.metricValue(goal.metric, weekId, goal.sectorCode ?? undefined)
    })));
    return scoped.map((goal) => {
      const currentValue = goal.currentValue;
      const targetValue = n(goal.targetValue);
      const achieved = satisfies(currentValue, targetValue, goal.comparator);
      const metric = goal.metric === "yield" ? "yield" : goal.metric === "overweight" ? "overweight" : goal.metric === "downtime_minutes" ? "downtime" : "loss";
      return {
        ...goal,
        targetValue,
        currentValue,
        progress: progress(currentValue, targetValue, goal.comparator),
        status: achieved ? "OK" : "ATTENTION",
        action: recommendedAction(metric, achieved ? "OK" : "ATTENTION")
      };
    });
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

  private async metricValue(metric: string, weekId?: string, sectorCode?: "P1" | "P2") {
    const productionWhere = { deletedAt: null, weekId, sector: sectorCode ? { code: sectorCode } : undefined };
    if (metric === "downtime_minutes") {
      const result = await this.prisma.downtimeEntry.aggregate({
        where: { deletedAt: null, weekId, sector: sectorCode ? { code: sectorCode } : undefined },
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
        where: { deletedAt: null, weekId, sector: sectorCode ? { code: sectorCode } : undefined },
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
