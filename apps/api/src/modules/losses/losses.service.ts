import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { lossEntrySchema } from "../../domain/validators/schemas";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { calculatePackagingLoss } from "../../domain/calculations/financial-calculations";
import { assertDateWithinWeek, assertWeekWritable } from "../../domain/weeks/week-rules";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dateOnly(value: Date) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

@Injectable()
export class LossesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  list(query: { weekId?: string; typeId?: string }) {
    return this.prisma.lossEntry.findMany({
      where: { deletedAt: null, weekId: query.weekId, lossTypeId: query.typeId },
      include: { lossType: true, product: true, sector: true, week: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  types() {
    return this.prisma.lossType.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = lossEntrySchema.parse(payload);
    const week = await this.prisma.weeklyPeriod.findUnique({ where: { id: input.weekId } });
    if (!week) throw new NotFoundException("Semana nao encontrada.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita perdas.");
    assertDateWithinWeek(input.date, week, "Data da perda precisa pertencer ao periodo da semana selecionada.");
    const userId = this.safeUserId(user);
    const [lossType, product] = await Promise.all([
      this.prisma.lossType.findUniqueOrThrow({ where: { id: input.lossTypeId } }),
      input.productId
        ? this.prisma.product.findUnique({ where: { id: input.productId }, include: { weightConfig: true } })
        : Promise.resolve(null)
    ]);
    if (input.productId && (!product || product.deletedAt)) throw new NotFoundException("Produto nao encontrado.");
    const pricePeriod = product
      ? await this.prisma.productPricePeriod.findFirst({
          where: {
            productId: product.id,
            startsOn: { lte: dateOnly(input.date) },
            OR: [{ endsOn: null }, { endsOn: { gte: dateOnly(input.date) } }]
          },
          orderBy: { startsOn: "desc" }
        })
      : null;
    const isPackaging = lossType.code === "PACKAGING";
    const unitCost = isPackaging
      ? Number(pricePeriod?.filmCostPerKg ?? product?.filmCostPerKg ?? 0)
      : Number(pricePeriod?.pricePerKg ?? product?.pricePerKg ?? 0);
    const packageFilmWeightG = Number(product?.packageFilmWeightG ?? 0);
    const filmCostPerKg = Number(pricePeriod?.filmCostPerKg ?? product?.filmCostPerKg ?? 0);
    const financial = calculatePackagingLoss({
      quantityKg: input.quantityKg,
      unitCost,
      packedBoxes: input.packedBoxes,
      packagesPerBox: product?.weightConfig?.packagesPerBox ?? 0,
      packageFilmWeightG,
      filmCostPerKg
    });

    const loss = await this.prisma.lossEntry.create({
      data: {
        weekId: input.weekId,
        date: input.date,
        sectorId: input.sector ? (await this.prisma.sector.findUniqueOrThrow({ where: { code: input.sector } })).id : undefined,
        productId: input.productId,
        productionOrderId: input.productionOrderId,
        lossTypeId: input.lossTypeId,
        quantityKg: input.quantityKg,
        unitCost,
        lossCost: financial.lossCost,
        packedBoxes: input.packedBoxes,
        packageFilmWeightG,
        filmCostPerKg,
        filmUsedKg: isPackaging ? financial.filmUsedKg : 0,
        filmUsedValue: isPackaging ? financial.filmUsedValue : 0,
        financialResult: isPackaging ? financial.financialResult : -financial.lossCost,
        reason: input.reason,
        notes: input.notes,
        createdBy: userId,
        updatedBy: userId
      },
      include: { lossType: true, product: true, sector: true }
    });
    await this.audit.record({ userId, module: "losses", action: "create", entity: "LossEntry", entityId: loss.id, after: loss });
    return loss;
  }

  async summary(weekId?: string) {
    const rows = await this.prisma.lossEntry.groupBy({
      by: ["lossTypeId"],
      where: { deletedAt: null, weekId },
      _sum: { quantityKg: true }
    });
    const types = await this.prisma.lossType.findMany();
    return rows.map((row) => {
      const type = types.find((item) => item.id === row.lossTypeId);
      return { type: type?.name ?? row.lossTypeId, quantityKg: Number(row._sum.quantityKg ?? 0) };
    });
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
