import { Injectable, NotFoundException } from "@nestjs/common";
import { dosageCheckSchema } from "../../domain/validators/schemas";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";
import { assertDateWithinWeek, assertWeekWritable } from "../../domain/weeks/week-rules";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function round(value: number, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

@Injectable()
export class DosageService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(weekId?: string, productId?: string) {
    return this.prisma.dosageCheck.findMany({
      where: { weekId, productId },
      include: { product: { select: { code: true, name: true } }, week: { select: { label: true } } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = dosageCheckSchema.parse(payload);
    const [week, product] = await Promise.all([
      this.prisma.weeklyPeriod.findUnique({ where: { id: input.weekId } }),
      this.prisma.product.findUnique({ where: { id: input.productId }, include: { weightConfig: true } })
    ]);
    if (!week) throw new NotFoundException("Semana nao encontrada.");
    if (!product || product.deletedAt || !product.weightConfig) throw new NotFoundException("Produto ou configuracao de peso nao encontrado.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita amostras.");
    assertDateWithinWeek(input.date, week, "Data da amostra precisa pertencer à semana selecionada.");
    const averageWeightG = input.sampleWeightsG.reduce((sum, value) => sum + value, 0) / input.sampleWeightsG.length;
    const variance = input.sampleWeightsG.reduce((sum, value) => sum + (value - averageWeightG) ** 2, 0) / input.sampleWeightsG.length;
    const targetWeightG = Number(product.weightConfig.targetPackageWeightG);
    const row = await this.prisma.dosageCheck.create({
      data: {
        weekId: input.weekId,
        productId: input.productId,
        sectorCode: input.sector,
        date: input.date,
        targetWeightG,
        sampleWeightsG: input.sampleWeightsG,
        sampleCount: input.sampleWeightsG.length,
        averageWeightG: round(averageWeightG),
        standardDeviationG: round(Math.sqrt(variance)),
        overweightG: round(Math.max(averageWeightG - targetWeightG, 0)),
        notes: input.notes
      },
      include: { product: { select: { code: true, name: true } }, week: { select: { label: true } } }
    });
    await this.audit.record({ userId: this.safeUserId(user), module: "dosage", action: "create", entity: "DosageCheck", entityId: row.id, after: row });
    return row;
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
