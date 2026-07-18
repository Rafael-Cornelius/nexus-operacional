import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { downtimeEntrySchema } from "../../domain/validators/schemas";
import { calculateDowntime } from "../../domain/calculations/downtime-calculations";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { assertDateWithinWeek, assertWeekWritable } from "../../domain/weeks/week-rules";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class DowntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  list(query: { weekId?: string; reasonId?: string }) {
    return this.prisma.downtimeEntry.findMany({
      where: { deletedAt: null, weekId: query.weekId, downtimeReasonId: query.reasonId },
      include: { week: true, sector: true, line: true, reason: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  reasons() {
    return this.prisma.downtimeReason.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = downtimeEntrySchema.parse(payload);
    const week = await this.prisma.weeklyPeriod.findUnique({ where: { id: input.weekId } });
    if (!week) throw new NotFoundException("Semana nao encontrada.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita paradas.");
    assertDateWithinWeek(input.date, week, "Data da parada precisa pertencer ao periodo da semana selecionada.");
    const userId = this.safeUserId(user);
    const sector = await this.prisma.sector.findUniqueOrThrow({ where: { code: input.sector } });
    const calculated = calculateDowntime({
      productionStart: input.productionStart,
      productionEnd: input.productionEnd,
      downtimeStart: input.downtimeStart,
      downtimeEnd: input.downtimeEnd,
      producedMassKg: input.producedMassKg
    });
    const entry = await this.prisma.downtimeEntry.create({
      data: {
        weekId: input.weekId,
        date: input.date,
        sectorId: sector.id,
        lineId: input.lineId,
        productionStart: input.productionStart,
        productionEnd: input.productionEnd,
        downtimeStart: input.downtimeStart,
        downtimeEnd: input.downtimeEnd,
        producedMassKg: input.producedMassKg,
        stoppedMinutes: calculated.stoppedMinutes,
        stoppedPercent: calculated.stoppedPercent,
        realKgHour: calculated.realKgHour,
        possibleKgHour: calculated.possibleKgHour,
        status: calculated.status,
        downtimeReasonId: input.downtimeReasonId,
        notes: [input.notes, ...calculated.inconsistencies].filter(Boolean).join("\n"),
        createdBy: userId,
        updatedBy: userId
      },
      include: { sector: true, reason: true, week: true }
    });
    await this.audit.record({ userId, module: "downtime", action: "create", entity: "DowntimeEntry", entityId: entry.id, after: entry });
    return { ...entry, calculations: calculated };
  }

  async summary(weekId?: string) {
    const rows = await this.prisma.downtimeEntry.groupBy({
      by: ["downtimeReasonId"],
      where: { deletedAt: null, weekId },
      _sum: { stoppedMinutes: true },
      _count: true
    });
    const reasons = await this.prisma.downtimeReason.findMany();
    return rows.map((row) => ({
      reason: reasons.find((reason) => reason.id === row.downtimeReasonId)?.name ?? row.downtimeReasonId,
      stoppedMinutes: Number(row._sum.stoppedMinutes ?? 0),
      count: row._count
    }));
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
