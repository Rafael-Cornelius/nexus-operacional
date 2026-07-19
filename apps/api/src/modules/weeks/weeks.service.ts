import { createHash } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { CALCULATION_RULES } from "../../domain/calculations/rule-registry";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { assertWeekWritable } from "../../domain/weeks/week-rules";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const weekSchema = z.object({
  year: z.coerce.number().int(),
  month: z.coerce.number().int().min(1).max(12),
  weekNumber: z.coerce.number().int().min(1).max(6),
  startsOn: z.coerce.date(),
  endsOn: z.coerce.date()
});

@Injectable()
export class WeeksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  list() {
    return this.prisma.weeklyPeriod.findMany({ where: { deletedAt: null }, orderBy: [{ year: "desc" }, { month: "desc" }, { weekNumber: "desc" }] });
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = weekSchema.parse(payload);
    if (input.endsOn < input.startsOn) {
      throw new BadRequestException("Data final da semana nao pode ser menor que a inicial.");
    }
    const userId = this.safeUserId(user);
    return this.prisma.$transaction(
      async (tx) => {
        const key = { year: input.year, month: input.month, weekNumber: input.weekNumber };
        let existing = await tx.weeklyPeriod.findUnique({ where: { year_month_weekNumber: key } });

        if (existing) {
          await this.lockWeek(tx, existing.id);
          existing = await tx.weeklyPeriod.findUnique({ where: { year_month_weekNumber: key } });
        }
        if (existing?.deletedAt) {
          throw new BadRequestException("Ja existe uma semana removida com este ano, mes e numero. Restaure-a antes de reutilizar a chave.");
        }
        if (existing) {
          assertWeekWritable(existing, "Semana fechada ou arquivada nao pode ter seu periodo alterado.");
          const periodChanged =
            existing.startsOn.getTime() !== input.startsOn.getTime() || existing.endsOn.getTime() !== input.endsOn.getTime();
          if (periodChanged) await this.assertPeriodHasNoDependents(tx, existing);
        }

        const overlapping = await tx.weeklyPeriod.findFirst({
          where: {
            deletedAt: null,
            id: existing ? { not: existing.id } : undefined,
            startsOn: { lte: input.endsOn },
            endsOn: { gte: input.startsOn }
          }
        });
        if (overlapping) {
          throw new BadRequestException("Periodo semanal sobrepoe outra semana operacional.");
        }

        const week = existing
          ? await tx.weeklyPeriod.update({
              where: { id: existing.id },
              data: { startsOn: input.startsOn, endsOn: input.endsOn }
            })
          : await tx.weeklyPeriod.create({
              data: {
                year: input.year,
                month: input.month,
                weekNumber: input.weekNumber,
                label: `Semana ${input.weekNumber}`,
                startsOn: input.startsOn,
                endsOn: input.endsOn
              }
            });
        await this.audit.record(
          {
            userId,
            module: "weeks",
            action: existing ? "update" : "create",
            entity: "WeeklyPeriod",
            entityId: week.id,
            before: existing,
            after: week
          },
          tx
        );
        return week;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async close(id: string, user?: CurrentUser) {
    this.assertUuid(id);
    const userId = this.safeUserId(user);
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockWeek(tx, id);
        const current = await tx.weeklyPeriod.findUnique({ where: { id } });
        if (!current) throw new NotFoundException("Semana nao encontrada.");
        if (current.status !== "REVIEW") {
          throw new BadRequestException("Semana deve estar em revisao antes do fechamento.");
        }
        const [pendingProduction, pendingLosses, pendingDowntimes] = await Promise.all([
          tx.productionEntry.count({ where: { weekId: id, deletedAt: null, workflowStatus: { not: "APPROVED" } } }),
          tx.lossEntry.count({ where: { weekId: id, deletedAt: null, workflowStatus: { not: "APPROVED" } } }),
          tx.downtimeEntry.count({ where: { weekId: id, deletedAt: null, workflowStatus: { not: "APPROVED" } } })
        ]);
        const pending = pendingProduction + pendingLosses + pendingDowntimes;
        if (pending > 0) {
          throw new BadRequestException(
            `Semana possui ${pending} lancamento(s) sem aprovacao: producao ${pendingProduction}, perdas ${pendingLosses}, paradas ${pendingDowntimes}.`
          );
        }
        const snapshot = await this.captureSnapshot(tx, current, "closed", userId);
        const week = await tx.weeklyPeriod.update({
          where: { id },
          data: { status: "CLOSED", closedAt: new Date(), snapshotData: snapshot }
        });
        await this.audit.record(
          { userId, module: "weeks", action: "close", entity: "WeeklyPeriod", entityId: id, before: current, after: week },
          tx
        );
        return week;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 }
    );
  }

  async review(id: string, user?: CurrentUser) {
    this.assertUuid(id);
    const userId = this.safeUserId(user);
    return this.prisma.$transaction(async (tx) => {
      await this.lockWeek(tx, id);
      const current = await tx.weeklyPeriod.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("Semana nao encontrada.");
      if (current.status !== "OPEN") {
        throw new BadRequestException("Somente uma semana aberta pode ser enviada para revisao.");
      }
      const reviewed = await tx.weeklyPeriod.update({ where: { id }, data: { status: "REVIEW" } });
      await this.audit.record(
        { userId, module: "weeks", action: "review", entity: "WeeklyPeriod", entityId: id, before: current, after: reviewed },
        tx
      );
      return reviewed;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async reopen(id: string, reason?: string, user?: CurrentUser) {
    if (!reason?.trim()) {
      throw new BadRequestException("Reabertura de semana exige justificativa.");
    }
    this.assertUuid(id);
    const userId = this.safeUserId(user);
    return this.prisma.$transaction(async (tx) => {
      await this.lockWeek(tx, id);
      const week = await tx.weeklyPeriod.findUnique({ where: { id } });
      if (!week) throw new NotFoundException("Semana nao encontrada.");
      if (week.status !== "CLOSED") throw new BadRequestException("Somente uma semana fechada pode ser reaberta.");
      const reopened = await tx.weeklyPeriod.update({ where: { id }, data: { status: "OPEN", closedAt: null } });
      await this.audit.record(
        { userId, module: "weeks", action: "reopen", entity: "WeeklyPeriod", entityId: id, before: week, after: reopened, reason },
        tx
      );
      return reopened;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async archive(id: string, user?: CurrentUser) {
    this.assertUuid(id);
    const userId = this.safeUserId(user);
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockWeek(tx, id);
        const current = await tx.weeklyPeriod.findUnique({ where: { id } });
        if (!current) throw new NotFoundException("Semana nao encontrada.");
        if (current.status !== "CLOSED") throw new BadRequestException("Somente uma semana fechada pode ser arquivada.");
        const snapshot = await this.captureSnapshot(tx, current, "archived", userId);
        const archived = await tx.weeklyPeriod.update({
          where: { id },
          data: { status: "ARCHIVED", archivedAt: new Date(), snapshotData: snapshot }
        });
        await this.audit.record(
          { userId, module: "weeks", action: "archive", entity: "WeeklyPeriod", entityId: id, before: current, after: archived },
          tx
        );
        return archived;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 }
    );
  }

  async byId(id: string) {
    const week = await this.prisma.weeklyPeriod.findUnique({ where: { id } });
    if (!week) throw new NotFoundException("Semana nao encontrada.");
    return week;
  }

  async snapshot(id: string) {
    const week = await this.prisma.weeklyPeriod.findUnique({ where: { id }, select: { id: true, label: true, snapshotData: true } });
    if (!week) throw new NotFoundException("Semana nao encontrada.");
    return week;
  }

  private async captureSnapshot(
    tx: Prisma.TransactionClient,
    week: { id: string; year: number; month: number; weekNumber: number; label: string; startsOn: Date; endsOn: Date; snapshotData: Prisma.JsonValue | null },
    reason: "closed" | "archived",
    responsibleUserId?: string
  ) {
    const weekId = week.id;
    const [productionEntries, losses, downtimes, dosageChecks, productivityEntries, goals, pricePeriods] = await Promise.all([
      tx.productionEntry.findMany({
        where: { weekId, deletedAt: null, workflowStatus: "APPROVED" },
        include: { product: { select: { code: true, name: true } }, sector: { select: { code: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      }),
      tx.lossEntry.findMany({
        where: { weekId, deletedAt: null, workflowStatus: "APPROVED" },
        include: { lossType: { select: { code: true, name: true } }, product: { select: { code: true, name: true } }, sector: { select: { code: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      }),
      tx.downtimeEntry.findMany({
        where: { weekId, deletedAt: null, workflowStatus: "APPROVED" },
        include: { reason: { select: { name: true } }, sector: { select: { code: true } }, line: { select: { code: true, name: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      }),
      tx.dosageCheck.findMany({
        where: { weekId },
        include: { product: { select: { code: true, name: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      }),
      tx.productivityEntry.findMany({ where: { weekId }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] }),
      tx.goal.findMany({
        where: {
          status: "APPROVED",
          deletedAt: null,
          startsOn: { lte: week.endsOn },
          OR: [{ endsOn: null }, { endsOn: { gte: week.startsOn } }]
        },
        orderBy: [{ metric: "asc" }, { createdAt: "asc" }]
      }),
      tx.productPricePeriod.findMany({
        where: {
          status: "APPROVED",
          startsOn: { lte: week.endsOn },
          OR: [{ endsOn: null }, { endsOn: { gte: week.startsOn } }]
        },
        include: { product: { select: { code: true, name: true } } },
        orderBy: [{ productId: "asc" }, { startsOn: "asc" }]
      })
    ]);
    const productionTotalKg = productionEntries.reduce((sum, row) => sum + Number(row.producedKg), 0);
    const lossTotalKg = productionEntries.reduce((sum, row) => sum + Number(row.weighingLossKg), 0) + losses.reduce((sum, row) => sum + Number(row.quantityKg), 0);
    const priorVersion = this.snapshotVersion(week.snapshotData);
    const capturedAt = new Date().toISOString();
    const ruleCatalog = Object.values(CALCULATION_RULES).map((rule) => ({
      id: rule.id,
      version: rule.version,
      status: rule.status,
      formula: rule.formula,
      unit: rule.unit
    }));
    const body = JSON.parse(JSON.stringify({
      format: "nexus-week-snapshot-v2",
      version: priorVersion + 1,
      capturedAt: new Date().toISOString(),
      reason,
      responsibleUserId: responsibleUserId ?? null,
      week: {
        id: week.id,
        year: week.year,
        month: week.month,
        weekNumber: week.weekNumber,
        label: week.label,
        startsOn: week.startsOn,
        endsOn: week.endsOn
      },
      summary: {
        productionTotalKg,
        lossTotalKg,
        overweightTotalKg: productionEntries.reduce((sum, row) => sum + Number(row.overweightTotalKg), 0),
        stoppedMinutes: downtimes.reduce((sum, row) => sum + Number(row.stoppedMinutes), 0),
        productionCost: productionEntries.reduce((sum, row) => sum + Number(row.productionCost), 0),
        lossesCost: productionEntries.reduce((sum, row) => sum + Number(row.lossesCost), 0) + losses.reduce((sum, row) => sum + Number(row.lossCost), 0),
        overweightCost: productionEntries.reduce((sum, row) => sum + Number(row.overweightCost), 0),
        records: productionEntries.length + losses.length + downtimes.length + dosageChecks.length + productivityEntries.length,
        counts: {
          production: productionEntries.length,
          losses: losses.length,
          downtimes: downtimes.length,
          dosage: dosageChecks.length,
          productivity: productivityEntries.length
        }
      },
      goalsUsed: goals,
      pricesUsed: pricePeriods,
      calculationRulesUsed: ruleCatalog,
      productionEntries,
      losses,
      downtimes,
      dosageChecks,
      productivityEntries
    }));
    body.capturedAt = capturedAt;
    const contentHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const snapshot = { ...body, contentHash } as Prisma.InputJsonObject;
    await tx.dashboardSnapshot.create({
      data: {
        weekId,
        filter: { reason, version: priorVersion + 1, contentHash },
        payload: snapshot
      }
    });
    return snapshot;
  }

  private async lockWeek(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "weekly_periods" WHERE "id" = CAST(${id} AS uuid) FOR UPDATE`);
  }

  private async assertPeriodHasNoDependents(
    tx: Prisma.TransactionClient,
    week: { id: string; snapshotData: Prisma.JsonValue | null }
  ) {
    const [orders, production, losses, downtimes, dosage, productivity, snapshots] = await Promise.all([
      tx.productionOrder.count({ where: { weekId: week.id } }),
      tx.productionEntry.count({ where: { weekId: week.id } }),
      tx.lossEntry.count({ where: { weekId: week.id } }),
      tx.downtimeEntry.count({ where: { weekId: week.id } }),
      tx.dosageCheck.count({ where: { weekId: week.id } }),
      tx.productivityEntry.count({ where: { weekId: week.id } }),
      tx.dashboardSnapshot.count({ where: { weekId: week.id } })
    ]);
    const embeddedSnapshot = week.snapshotData === null ? 0 : 1;
    const total = orders + production + losses + downtimes + dosage + productivity + snapshots + embeddedSnapshot;
    if (total > 0) {
      throw new BadRequestException(
        `Periodo da semana nao pode ser alterado apos existir dado operacional ou snapshot (${total} vinculo(s)).`
      );
    }
  }

  private snapshotVersion(value: Prisma.JsonValue | null) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    const version = (value as Prisma.JsonObject).version;
    return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : 0;
  }

  private assertUuid(value: string) {
    if (!uuidPattern.test(value)) throw new BadRequestException("Identificador de semana invalido.");
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
