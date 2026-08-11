import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
const uuid = z.string().uuid();
const canonicalMetric = z.enum(["yield", "overweight", "losses_kg", "downtime_minutes", "produced_kg"]);
const comparator = z.enum(["<=", ">=", "<", ">", "="]);
const dateText = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve usar AAAA-MM-DD.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "Data de calendário inválida.");
const targetText = z.preprocess(
  (value) => typeof value === "number" ? String(value) : value,
  z.string().trim().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/, "Valor deve ser decimal não negativo, com até 6 casas.")
);
const reason = z.string().trim().min(10).max(500);

const goalDefinitionFields = {
  name: z.string().trim().min(2).max(160),
  metric: canonicalMetric,
  sectorCode: z.enum(["P1", "P2"]).nullish(),
  lineId: uuid.nullish(),
  equipmentId: uuid.nullish(),
  shiftId: uuid.nullish(),
  productId: uuid.nullish(),
  targetValue: targetText,
  comparator: comparator.default("<="),
  measurementUnit: z.string().trim().min(1).max(30),
  cadence: z.enum(["DAILY", "WEEKLY"]).default("WEEKLY"),
  startsOn: dateText,
  endsOn: dateText.nullish(),
  responsibleId: uuid
};

const createGoalSchema = z.object({ ...goalDefinitionFields, reason }).strict();
const createVersionSchema = z.object({
  name: goalDefinitionFields.name.optional(),
  targetValue: targetText.optional(),
  comparator: comparator.optional(),
  measurementUnit: goalDefinitionFields.measurementUnit.optional(),
  cadence: goalDefinitionFields.cadence.optional(),
  startsOn: dateText.optional(),
  endsOn: dateText.nullish().optional(),
  responsibleId: uuid.optional(),
  reason
}).strict();
const workflowReasonSchema = z.object({ reason }).strict();
const listSchema = z.object({
  weekId: uuid.optional(),
  status: z.enum(["DRAFT", "APPROVED", "RETIRED"]).optional(),
  metric: canonicalMetric.optional(),
  seriesId: uuid.optional()
}).strict();

const goalInclude = {
  sector: { select: { code: true, name: true } },
  line: { select: { id: true, code: true, name: true, sectorId: true } },
  equipment: { select: { id: true, code: true, name: true, productionLineId: true } },
  shift: { select: { id: true, code: true, name: true } },
  product: { select: { id: true, code: true, name: true } },
  responsible: { select: { id: true, name: true, email: true } },
  approver: { select: { id: true, name: true, email: true } }
} satisfies Prisma.GoalInclude;

type GoalRecord = Prisma.GoalGetPayload<{ include: typeof goalInclude }>;
type GoalDefinition = z.infer<typeof createGoalSchema>;
type GoalDatabase = Pick<
  Prisma.TransactionClient,
  "sector" | "productionLine" | "equipment" | "shift" | "product" | "user" | "goal"
>;

interface GoalScope {
  metric: CanonicalGoalMetric;
  sectorCode?: "P1" | "P2" | null;
  lineId?: string | null;
  equipmentId?: string | null;
  shiftId?: string | null;
  productId?: string | null;
}

function atUtcStart(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function scopeKey(scope: GoalScope) {
  return [
    scope.metric,
    `sector=${scope.sectorCode ?? "*"}`,
    `line=${scope.lineId ?? "*"}`,
    `equipment=${scope.equipmentId ?? "*"}`,
    `shift=${scope.shiftId ?? "*"}`,
    `product=${scope.productId ?? "*"}`
  ].join("|");
}

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(query: { weekId?: string; status?: string; metric?: string; seriesId?: string } = {}) {
    const filters = listSchema.parse(query);
    const range = await this.evaluationRange(filters.weekId);
    const goals = await this.prisma.goal.findMany({
      where: {
        deletedAt: null,
        status: filters.status,
        metric: filters.metric,
        seriesId: filters.seriesId
      },
      include: goalInclude,
      orderBy: [{ metric: "asc" }, { seriesId: "asc" }, { version: "desc" }]
    });

    return Promise.all(goals.map((goal) => {
      const effective = goal.status === "APPROVED" && this.overlapsRange(goal, range);
      return effective ? this.evaluate(goal, filters.weekId) : this.withoutEvaluation(goal);
    }));
  }

  async history(seriesId: string) {
    const goals = await this.prisma.goal.findMany({
      where: { seriesId, deletedAt: null },
      include: goalInclude,
      orderBy: { version: "desc" }
    });
    if (!goals.length) throw new NotFoundException("Série de meta não encontrada.");
    return goals.map((goal) => this.withoutEvaluation(goal));
  }

  async references() {
    const [sectors, lines, equipment, shifts, products, users] = await Promise.all([
      this.prisma.sector.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true } }),
      this.prisma.productionLine.findMany({
        where: { active: true, deletedAt: null },
        orderBy: [{ sector: { code: "asc" } }, { code: "asc" }],
        select: { id: true, code: true, name: true, sectorId: true, sector: { select: { code: true } } }
      }),
      this.prisma.equipment.findMany({
        where: { active: true, deletedAt: null },
        orderBy: [{ productionLine: { code: "asc" } }, { code: "asc" }],
        select: {
          id: true,
          code: true,
          name: true,
          productionLineId: true,
          productionLine: { select: { sector: { select: { code: true } } } }
        }
      }),
      this.prisma.shift.findMany({
        where: { active: true, deletedAt: null },
        orderBy: { startsAt: "asc" },
        select: { id: true, code: true, name: true }
      }),
      this.prisma.product.findMany({
        where: { active: true, deletedAt: null },
        orderBy: { code: "asc" },
        select: { id: true, code: true, name: true, defaultSector: { select: { code: true } } }
      }),
      this.prisma.user.findMany({
        where: { active: true, deletedAt: null },
        orderBy: { name: "asc" },
        select: { id: true, name: true, email: true }
      })
    ]);
    return { sectors, lines, equipment, shifts, products, users };
  }

  async activeAlerts(weekId?: string) {
    const range = await this.evaluationRange(weekId);
    const goals = await this.prisma.goal.findMany({
      where: {
        deletedAt: null,
        status: "APPROVED",
        ...(range ? {
          startsOn: { lte: range.endsOn },
          OR: [{ endsOn: null }, { endsOn: { gte: range.startsOn } }]
        } : {})
      },
      include: goalInclude,
      orderBy: [{ metric: "asc" }, { sectorCode: "asc" }, { name: "asc" }]
    });
    return Promise.all(goals.map((goal) => this.evaluate(goal, weekId)));
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = createGoalSchema.parse(payload);
    this.assertPeriod(input.startsOn, input.endsOn);
    const actorId = this.actorId(user);
    const definition = this.persistenceDefinition(input);

    return this.prisma.$transaction(async (transaction) => {
      await this.assertReferences(transaction, definition);
      const goal = await transaction.goal.create({
        data: {
          ...definition,
          seriesId: randomUUID(),
          version: 1,
          status: "DRAFT",
          versionReason: input.reason,
          createdBy: actorId
        },
        include: goalInclude
      });
      await this.audit.record({
        userId: actorId,
        module: "goals",
        action: "create_draft",
        entity: "Goal",
        entityId: goal.id,
        after: goal,
        reason: input.reason
      }, transaction);
      return this.withoutEvaluation(goal);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async createVersion(id: string, payload: unknown, user?: CurrentUser) {
    const input = createVersionSchema.parse(payload);
    const actorId = this.actorId(user);

    return this.prisma.$transaction(async (transaction) => {
      const base = await transaction.goal.findUnique({ where: { id }, include: goalInclude });
      if (!base || base.deletedAt) throw new NotFoundException("Meta não encontrada.");
      const latest = await transaction.goal.findFirst({
        where: { seriesId: base.seriesId, deletedAt: null },
        orderBy: { version: "desc" },
        select: { id: true }
      });
      if (latest?.id !== base.id) {
        throw new ConflictException("Crie a nova versão a partir da versão mais recente da série.");
      }

      const startsOnText = input.startsOn ?? this.dateText(base.startsOn);
      if (!startsOnText) throw new BadRequestException("Versão legada sem vigência inicial. Informe a data inicial.");
      const endsOnText = input.endsOn === undefined ? this.dateText(base.endsOn) : input.endsOn ?? undefined;
      this.assertPeriod(startsOnText, endsOnText);
      if (!base.measurementUnit && !input.measurementUnit) {
        throw new BadRequestException("Versão legada sem unidade. Informe a unidade da meta.");
      }
      if (!base.responsibleId && !input.responsibleId) {
        throw new BadRequestException("Versão legada sem responsável. Selecione o responsável.");
      }

      const definition = {
        name: input.name ?? base.name,
        metric: base.metric as CanonicalGoalMetric,
        sectorCode: base.sectorCode,
        lineId: base.lineId,
        equipmentId: base.equipmentId,
        shiftId: base.shiftId,
        productId: base.productId,
        scopeKey: base.scopeKey ?? scopeKey({
          metric: base.metric as CanonicalGoalMetric,
          sectorCode: base.sectorCode,
          lineId: base.lineId,
          equipmentId: base.equipmentId,
          shiftId: base.shiftId,
          productId: base.productId
        }),
        targetValue: new Prisma.Decimal(input.targetValue ?? base.targetValue.toString()),
        comparator: input.comparator ?? base.comparator,
        measurementUnit: input.measurementUnit ?? base.measurementUnit!,
        cadence: input.cadence ?? base.cadence,
        startsOn: atUtcStart(startsOnText),
        endsOn: endsOnText ? atUtcStart(endsOnText) : null,
        responsibleId: input.responsibleId ?? base.responsibleId!
      };
      await this.assertReferences(transaction, definition);

      let retiredBase: GoalRecord | null = null;
      if (base.status === "DRAFT") {
        retiredBase = await transaction.goal.update({
          where: { id: base.id },
          data: {
            status: "RETIRED",
            retiredAt: new Date(),
            retiredBy: actorId,
            retirementReason: input.reason
          },
          include: goalInclude
        });
      }

      const goal = await transaction.goal.create({
        data: {
          ...definition,
          seriesId: base.seriesId,
          previousVersionId: base.id,
          version: base.version + 1,
          status: "DRAFT",
          versionReason: input.reason,
          createdBy: actorId
        },
        include: goalInclude
      });

      if (retiredBase) {
        await this.audit.record({
          userId: actorId,
          module: "goals",
          action: "retire_superseded_draft",
          entity: "Goal",
          entityId: retiredBase.id,
          before: base,
          after: retiredBase,
          reason: input.reason
        }, transaction);
      }
      await this.audit.record({
        userId: actorId,
        module: "goals",
        action: "create_version",
        entity: "Goal",
        entityId: goal.id,
        after: goal,
        reason: input.reason
      }, transaction);
      return this.withoutEvaluation(goal);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async approve(id: string, payload: unknown, user?: CurrentUser) {
    const { reason: approvalReason } = workflowReasonSchema.parse(payload);
    const actorId = this.actorId(user);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const current = await transaction.goal.findUnique({ where: { id }, include: goalInclude });
        if (!current || current.deletedAt) throw new NotFoundException("Meta não encontrada.");
        if (current.status !== "DRAFT") throw new ConflictException("Somente meta DRAFT pode ser aprovada.");
        if (!current.startsOn || !current.measurementUnit || !current.responsibleId || !current.scopeKey) {
          throw new BadRequestException("Meta incompleta. Crie nova versão com vigência, unidade, escopo e responsável.");
        }
        if (current.createdBy === actorId || current.responsibleId === actorId) {
          throw new ForbiddenException(
            "A meta deve ser aprovada por outro gestor, diferente de quem criou e de quem é responsável por ela."
          );
        }
        await this.assertReferences(transaction, current as GoalRecord & GoalScope);
        await this.assertNoApprovedOverlap(transaction, current);

        const previousApproved = await transaction.goal.findMany({
          where: { seriesId: current.seriesId, status: "APPROVED", deletedAt: null },
          include: goalInclude
        });
        const now = new Date();
        for (const previous of previousApproved) {
          const retirementReason = `Substituída pela versão ${current.version}. ${approvalReason}`;
          const retired = await transaction.goal.update({
            where: { id: previous.id },
            data: { status: "RETIRED", retiredAt: now, retiredBy: actorId, retirementReason },
            include: goalInclude
          });
          await this.audit.record({
            userId: actorId,
            module: "goals",
            action: "retire_superseded_version",
            entity: "Goal",
            entityId: retired.id,
            before: previous,
            after: retired,
            reason: retirementReason
          }, transaction);
        }

        const approved = await transaction.goal.update({
          where: { id: current.id },
          data: { status: "APPROVED", approvedAt: now, approvedBy: actorId, approvalReason },
          include: goalInclude
        });
        await this.audit.record({
          userId: actorId,
          module: "goals",
          action: "approve",
          entity: "Goal",
          entityId: approved.id,
          before: current,
          after: approved,
          reason: approvalReason
        }, transaction);
        return this.withoutEvaluation(approved);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.rethrowWriteConflict(error);
    }
  }

  async retire(id: string, payload: unknown, user?: CurrentUser) {
    const { reason: retirementReason } = workflowReasonSchema.parse(payload);
    const actorId = this.actorId(user);
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.goal.findUnique({ where: { id }, include: goalInclude });
      if (!current || current.deletedAt) throw new NotFoundException("Meta não encontrada.");
      if (current.status === "RETIRED") throw new ConflictException("Meta já está retirada.");
      const retired = await transaction.goal.update({
        where: { id },
        data: { status: "RETIRED", retiredAt: new Date(), retiredBy: actorId, retirementReason },
        include: goalInclude
      });
      await this.audit.record({
        userId: actorId,
        module: "goals",
        action: "retire",
        entity: "Goal",
        entityId: retired.id,
        before: current,
        after: retired,
        reason: retirementReason
      }, transaction);
      return this.withoutEvaluation(retired);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private persistenceDefinition(input: GoalDefinition) {
    return {
      name: input.name,
      metric: input.metric,
      sectorCode: input.sectorCode ?? null,
      lineId: input.lineId ?? null,
      equipmentId: input.equipmentId ?? null,
      shiftId: input.shiftId ?? null,
      productId: input.productId ?? null,
      scopeKey: scopeKey(input),
      targetValue: new Prisma.Decimal(input.targetValue),
      comparator: input.comparator,
      measurementUnit: input.measurementUnit,
      cadence: input.cadence,
      startsOn: atUtcStart(input.startsOn),
      endsOn: input.endsOn ? atUtcStart(input.endsOn) : null,
      responsibleId: input.responsibleId
    };
  }

  private async assertReferences(database: GoalDatabase, scope: GoalScope & { responsibleId?: string | null }) {
    const [sector, line, equipment, shift, product, responsible] = await Promise.all([
      scope.sectorCode ? database.sector.findUnique({ where: { code: scope.sectorCode } }) : Promise.resolve(null),
      scope.lineId ? database.productionLine.findUnique({ where: { id: scope.lineId } }) : Promise.resolve(null),
      scope.equipmentId ? database.equipment.findUnique({
        where: { id: scope.equipmentId },
        include: { productionLine: true }
      }) : Promise.resolve(null),
      scope.shiftId ? database.shift.findUnique({ where: { id: scope.shiftId } }) : Promise.resolve(null),
      scope.productId ? database.product.findUnique({ where: { id: scope.productId } }) : Promise.resolve(null),
      scope.responsibleId ? database.user.findUnique({ where: { id: scope.responsibleId } }) : Promise.resolve(null)
    ]);

    if (scope.sectorCode && !sector) throw new NotFoundException("Setor da meta não encontrado.");
    if (scope.lineId && (!line || line.deletedAt || !line.active)) throw new NotFoundException("Linha ativa da meta não encontrada.");
    if (scope.equipmentId && (!equipment || equipment.deletedAt || !equipment.active)) throw new NotFoundException("Equipamento ativo da meta não encontrado.");
    if (scope.shiftId && (!shift || shift.deletedAt || !shift.active)) throw new NotFoundException("Turno ativo da meta não encontrado.");
    if (scope.productId && (!product || product.deletedAt || !product.active)) throw new NotFoundException("Produto ativo da meta não encontrado.");
    if (scope.responsibleId && (!responsible || responsible.deletedAt || !responsible.active)) throw new NotFoundException("Responsável ativo não encontrado.");
    if ((scope.lineId || scope.equipmentId) && !scope.sectorCode) {
      throw new BadRequestException("Metas por linha ou equipamento também devem informar o setor.");
    }
    if (line && scope.sectorCode && line.sectorId !== sector?.id) {
      throw new BadRequestException("Linha não pertence ao setor selecionado.");
    }
    if (equipment && scope.lineId && equipment.productionLineId !== scope.lineId) {
      throw new BadRequestException("Equipamento não pertence à linha selecionada.");
    }
    if (equipment && scope.sectorCode && equipment.productionLine.sectorId !== sector?.id) {
      throw new BadRequestException("Equipamento não pertence ao setor selecionado.");
    }
    if (scope.metric === "downtime_minutes" && scope.productId) {
      throw new BadRequestException("Paradas não possuem vínculo de produto; remova produto do escopo.");
    }
  }

  private async assertNoApprovedOverlap(transaction: Prisma.TransactionClient, current: GoalRecord) {
    if (!current.startsOn || !current.scopeKey) throw new BadRequestException("Vigência ou escopo ausente.");
    const conflict = await transaction.goal.findFirst({
      where: {
        id: { not: current.id },
        seriesId: { not: current.seriesId },
        scopeKey: current.scopeKey,
        status: "APPROVED",
        deletedAt: null,
        startsOn: current.endsOn ? { lte: current.endsOn } : { not: null },
        OR: [{ endsOn: null }, { endsOn: { gte: current.startsOn } }]
      },
      select: { id: true, name: true, version: true }
    });
    if (conflict) {
      throw new ConflictException(`Vigência sobrepõe meta aprovada ${conflict.name}, versão ${conflict.version}.`);
    }
  }

  private async evaluate(goal: GoalRecord, weekId?: string) {
    const metric = normalizeGoalMetric(goal.metric);
    const target = asNumber(goal.targetValue);
    if (!metric) {
      return {
        ...this.baseDto(goal),
        target,
        value: 0,
        currentValue: 0,
        progress: 0,
        achieved: false,
        status: "CRITICAL" as const,
        action: `Métrica não suportada: ${goal.metric}. Crie nova versão antes de usar este indicador.`
      };
    }

    const currentValue = await this.metricValue(metric, weekId, {
      metric,
      sectorCode: goal.sectorCode,
      lineId: goal.lineId,
      equipmentId: goal.equipmentId,
      shiftId: goal.shiftId,
      productId: goal.productId
    });
    const evaluation = evaluateOperationalGoal({
      metric,
      value: currentValue,
      target,
      comparator: goal.comparator as GoalComparator
    });
    return {
      ...this.baseDto(goal),
      metric,
      target,
      value: currentValue,
      currentValue,
      ...evaluation
    };
  }

  private withoutEvaluation(goal: GoalRecord) {
    return {
      ...this.baseDto(goal),
      target: asNumber(goal.targetValue),
      value: null,
      currentValue: null,
      progress: null,
      achieved: null,
      status: null,
      action: goal.status === "DRAFT" ? "Aguardando aprovação humana." : "Meta fora da vigência consultada."
    };
  }

  private baseDto(goal: GoalRecord) {
    return {
      id: goal.id,
      goalId: goal.id,
      seriesId: goal.seriesId,
      previousVersionId: goal.previousVersionId,
      version: goal.version,
      name: goal.name,
      metric: goal.metric,
      sectorCode: goal.sectorCode,
      lineId: goal.lineId,
      equipmentId: goal.equipmentId,
      shiftId: goal.shiftId,
      productId: goal.productId,
      targetValue: goal.targetValue.toString(),
      comparator: goal.comparator,
      measurementUnit: goal.measurementUnit,
      cadence: goal.cadence,
      startsOn: goal.startsOn,
      endsOn: goal.endsOn,
      responsibleId: goal.responsibleId,
      approvedBy: goal.approvedBy,
      workflowStatus: goal.status,
      active: goal.status === "APPROVED",
      approvedAt: goal.approvedAt,
      approvalReason: goal.approvalReason,
      retiredAt: goal.retiredAt,
      retiredBy: goal.retiredBy,
      retirementReason: goal.retirementReason,
      versionReason: goal.versionReason,
      createdBy: goal.createdBy,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      sector: goal.sector,
      line: goal.line,
      equipment: goal.equipment,
      shift: goal.shift,
      product: goal.product,
      responsible: goal.responsible,
      approver: goal.approver
    };
  }

  private async metricValue(metric: CanonicalGoalMetric, weekId: string | undefined, scope: GoalScope) {
    const productionWhere = {
      deletedAt: null,
      workflowStatus: "APPROVED" as const,
      weekId,
      sector: scope.sectorCode ? { code: scope.sectorCode } : undefined,
      lineId: scope.lineId ?? undefined,
      equipmentId: scope.equipmentId ?? undefined,
      shiftId: scope.shiftId ?? undefined,
      productId: scope.productId ?? undefined
    };
    if (metric === "downtime_minutes") {
      const result = await this.prisma.downtimeEntry.aggregate({
        where: {
          deletedAt: null,
          workflowStatus: "APPROVED",
          weekId,
          sector: scope.sectorCode ? { code: scope.sectorCode } : undefined,
          lineId: scope.lineId ?? undefined,
          equipmentId: scope.equipmentId ?? undefined,
          shiftId: scope.shiftId ?? undefined
        },
        _sum: { stoppedMinutes: true }
      });
      return asNumber(result._sum.stoppedMinutes);
    }

    const result = await this.prisma.productionEntry.aggregate({
      where: productionWhere,
      _sum: { producedKg: true, weighingLossKg: true, overweightTotalKg: true },
      _avg: { realYieldPercent: true, overweightPercent: true }
    });
    if (metric === "produced_kg") return asNumber(result._sum.producedKg);
    if (metric === "losses_kg") {
      const losses = await this.prisma.lossEntry.aggregate({
        where: {
          deletedAt: null,
          workflowStatus: "APPROVED",
          weekId,
          sector: scope.sectorCode ? { code: scope.sectorCode } : undefined,
          equipmentId: scope.equipmentId ?? undefined,
          equipment: scope.lineId && !scope.equipmentId ? { productionLineId: scope.lineId } : undefined,
          shiftId: scope.shiftId ?? undefined,
          productId: scope.productId ?? undefined
        },
        _sum: { quantityKg: true }
      });
      return asNumber(result._sum.weighingLossKg) + asNumber(losses._sum.quantityKg);
    }
    if (metric === "overweight") return asNumber(result._avg.overweightPercent);
    return asNumber(result._avg.realYieldPercent);
  }

  private async evaluationRange(weekId?: string) {
    if (!weekId) {
      const today = new Date();
      const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      return { startsOn: date, endsOn: date };
    }
    if (!this.prisma.weeklyPeriod?.findUnique) return undefined;
    const week = await this.prisma.weeklyPeriod.findUnique({
      where: { id: weekId },
      select: { startsOn: true, endsOn: true, deletedAt: true }
    });
    if (!week || week.deletedAt) throw new NotFoundException("Semana de avaliação não encontrada.");
    return { startsOn: week.startsOn, endsOn: week.endsOn };
  }

  private overlapsRange(goal: Pick<GoalRecord, "startsOn" | "endsOn">, range?: { startsOn: Date; endsOn: Date }) {
    if (!range || !goal.startsOn) return false;
    return goal.startsOn <= range.endsOn && (!goal.endsOn || goal.endsOn >= range.startsOn);
  }

  private assertPeriod(startsOn: string, endsOn?: string | null) {
    if (endsOn && atUtcStart(endsOn) < atUtcStart(startsOn)) {
      throw new BadRequestException("Vigência final não pode ser anterior à inicial.");
    }
  }

  private dateText(value?: Date | null) {
    return value?.toISOString().slice(0, 10);
  }

  private actorId(user?: CurrentUser) {
    if (!user?.id || !uuidPattern.test(user.id)) {
      throw new ForbiddenException("Usuário autenticado válido é obrigatório para governar metas.");
    }
    return user.id;
  }

  private rethrowWriteConflict(error: unknown): never {
    if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException) {
      throw error;
    }
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    const message = error instanceof Error ? error.message : "";
    if (code === "P2034" || code === "P2002" || code === "P2004" || message.includes("goals_approved_scope_validity_no_overlap")) {
      throw new ConflictException("Outra meta aprovada ocupa esta vigência e escopo. Recarregue e revise o período.");
    }
    throw error;
  }
}
