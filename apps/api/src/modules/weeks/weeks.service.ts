import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
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
    const existing = await this.prisma.weeklyPeriod.findUnique({
      where: { year_month_weekNumber: { year: input.year, month: input.month, weekNumber: input.weekNumber } }
    });
    if (existing?.deletedAt) {
      throw new BadRequestException("Ja existe uma semana removida com este ano, mes e numero. Restaure-a antes de reutilizar a chave.");
    }
    if (existing) assertWeekWritable(existing, "Semana fechada ou arquivada nao pode ter seu periodo alterado.");
    const overlapping = await this.prisma.weeklyPeriod.findFirst({
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
    const week = await this.prisma.weeklyPeriod.upsert({
      where: { year_month_weekNumber: { year: input.year, month: input.month, weekNumber: input.weekNumber } },
      create: {
        year: input.year,
        month: input.month,
        weekNumber: input.weekNumber,
        label: `Semana ${input.weekNumber}`,
        startsOn: input.startsOn,
        endsOn: input.endsOn
      },
      update: {
        startsOn: input.startsOn,
        endsOn: input.endsOn
      }
    });
    await this.audit.record({ userId: this.safeUserId(user), module: "weeks", action: existing ? "update" : "create", entity: "WeeklyPeriod", entityId: week.id, before: existing, after: week });
    return week;
  }

  async close(id: string, user?: CurrentUser) {
    const current = await this.prisma.weeklyPeriod.findUnique({ where: { id } });
    if (!current) throw new NotFoundException("Semana nao encontrada.");
    assertWeekWritable(current, "Somente semanas abertas ou em revisao podem ser fechadas.");
    const snapshot = await this.captureSnapshot(id, "closed");
    const week = await this.prisma.weeklyPeriod.update({
      where: { id },
      data: { status: "CLOSED", closedAt: new Date(), snapshotData: snapshot }
    });
    await this.audit.record({ userId: this.safeUserId(user), module: "weeks", action: "close", entity: "WeeklyPeriod", entityId: id, before: current, after: week });
    return week;
  }

  async reopen(id: string, reason?: string, user?: CurrentUser) {
    if (!reason?.trim()) {
      throw new BadRequestException("Reabertura de semana exige justificativa.");
    }
    const week = await this.prisma.weeklyPeriod.findUnique({ where: { id } });
    if (!week) throw new NotFoundException("Semana nao encontrada.");
    if (week.status !== "CLOSED") throw new BadRequestException("Somente uma semana fechada pode ser reaberta.");
    const reopened = await this.prisma.weeklyPeriod.update({
      where: { id },
      data: { status: "OPEN", closedAt: null }
    });
    await this.audit.record({ userId: this.safeUserId(user), module: "weeks", action: "reopen", entity: "WeeklyPeriod", entityId: id, before: week, after: reopened, reason });
    return reopened;
  }

  async archive(id: string, user?: CurrentUser) {
    const current = await this.prisma.weeklyPeriod.findUnique({ where: { id } });
    if (!current) throw new NotFoundException("Semana nao encontrada.");
    if (current.status !== "CLOSED") throw new BadRequestException("Somente uma semana fechada pode ser arquivada.");
    const snapshot = await this.captureSnapshot(id, "archived");
    const archived = await this.prisma.weeklyPeriod.update({
      where: { id },
      data: { status: "ARCHIVED", archivedAt: new Date(), snapshotData: snapshot }
    });
    await this.audit.record({ userId: this.safeUserId(user), module: "weeks", action: "archive", entity: "WeeklyPeriod", entityId: id, before: current, after: archived });
    return archived;
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

  private async captureSnapshot(weekId: string, reason: "closed" | "archived") {
    const [productionEntries, losses, downtimes] = await Promise.all([
      this.prisma.productionEntry.findMany({
        where: { weekId, deletedAt: null },
        include: { product: { select: { code: true, name: true } }, sector: { select: { code: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      }),
      this.prisma.lossEntry.findMany({
        where: { weekId, deletedAt: null },
        include: { lossType: { select: { code: true, name: true } }, product: { select: { code: true, name: true } }, sector: { select: { code: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      }),
      this.prisma.downtimeEntry.findMany({
        where: { weekId, deletedAt: null },
        include: { reason: { select: { name: true } }, sector: { select: { code: true } }, line: { select: { code: true, name: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      })
    ]);
    const productionTotalKg = productionEntries.reduce((sum, row) => sum + Number(row.producedKg), 0);
    const lossTotalKg = productionEntries.reduce((sum, row) => sum + Number(row.weighingLossKg), 0) + losses.reduce((sum, row) => sum + Number(row.quantityKg), 0);
    const snapshot = JSON.parse(JSON.stringify({
      version: 1,
      capturedAt: new Date().toISOString(),
      reason,
      summary: {
        productionTotalKg,
        lossTotalKg,
        overweightTotalKg: productionEntries.reduce((sum, row) => sum + Number(row.overweightTotalKg), 0),
        stoppedMinutes: downtimes.reduce((sum, row) => sum + Number(row.stoppedMinutes), 0),
        records: productionEntries.length
      },
      productionEntries,
      losses,
      downtimes
    }));
    await this.prisma.dashboardSnapshot.create({ data: { weekId, filter: { reason }, payload: snapshot } });
    return snapshot;
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
