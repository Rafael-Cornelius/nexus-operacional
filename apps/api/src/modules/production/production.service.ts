import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { productionEntrySchema, productionPreviewSchema } from "../../domain/validators/schemas";
import { calculateProductionEntry } from "../../domain/calculations/production-calculations";
import { ProductWeightConfig } from "../../domain/calculations/types";
import { classifyRule } from "../../domain/alerts/alert-engine";
import { calculateProductionCosts } from "../../domain/calculations/financial-calculations";
import { assertDateWithinWeek, assertWeekWritable } from "../../domain/weeks/week-rules";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";

const severity = { OK: 0, MEDIUM: 1, ATTENTION: 2, CRITICAL: 3 } as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function worstStatus(...statuses: Array<keyof typeof severity>) {
  return statuses.sort((a, b) => severity[b] - severity[a])[0] ?? "OK";
}

function dateOnly(value: Date) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  preview(payload: unknown) {
    const input = productionPreviewSchema.parse(payload);
    const calculations = calculateProductionEntry(input);
    const yieldStatus = classifyRule({ metric: "yield", value: calculations.realYieldPercent, target: 0.95 });
    const overweightStatus = classifyRule({
      metric: "overweight",
      value: calculations.overweightPercent,
      target: input.weightConfig.overweightTolerancePercent
    });

    const costs = calculateProductionCosts({
      producedKg: calculations.producedKg,
      weighingLossKg: input.weighingLossKg,
      overweightKg: calculations.overweightTotalKg,
      pricePerKg: input.pricePerKg
    });
    return {
      ...calculations,
      ...costs,
      status: worstStatus(yieldStatus, overweightStatus)
    };
  }

  async list(query: { weekId?: string; sector?: "P1" | "P2"; productId?: string; op?: string }) {
    return this.prisma.productionEntry.findMany({
      where: {
        deletedAt: null,
        weekId: query.weekId,
        sector: query.sector ? { code: query.sector } : undefined,
        productId: query.productId,
        productionOrder: query.op
      },
      include: { week: true, product: true, sector: true, line: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = productionEntrySchema.parse(payload);
    const week = await this.prisma.weeklyPeriod.findUnique({ where: { id: input.weekId } });
    if (!week) throw new NotFoundException("Semana nao encontrada.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita novos lancamentos.");
    assertDateWithinWeek(input.date, week, "Data do lancamento precisa pertencer ao periodo da semana selecionada.");

    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
      include: { weightConfig: true }
    });
    if (!product || product.deletedAt) throw new NotFoundException("Produto nao encontrado.");
    if (!product.active) throw new BadRequestException("Produto inativo nao pode ser usado em novo lancamento.");
    if (!product.weightConfig) throw new BadRequestException("Produto sem configuracao de peso.");

    const sector = await this.prisma.sector.findUniqueOrThrow({ where: { code: input.sector } });
    const weightConfig: ProductWeightConfig = {
      formula: product.weightConfig.formula,
      packageWeightKg: Number(product.weightConfig.packageWeightKg),
      boxWeightKg: Number(product.weightConfig.boxWeightKg),
      packagesPerBox: product.weightConfig.packagesPerBox,
      massWeightKg: Number(product.weightConfig.massWeightKg),
      targetPackageWeightG: Number(product.weightConfig.targetPackageWeightG),
      overweightTolerancePercent: Number(product.weightConfig.overweightTolerancePercent)
    };
    const pricePeriod = await this.prisma.productPricePeriod.findFirst({
      where: {
        productId: product.id,
        startsOn: { lte: dateOnly(input.date) },
        OR: [{ endsOn: null }, { endsOn: { gte: dateOnly(input.date) } }]
      },
      orderBy: { startsOn: "desc" }
    });
    const calculated = calculateProductionEntry({
      sector: input.sector,
      plannedBatches: input.plannedBatches,
      realizedBatches: input.realizedBatches,
      usedReworkKg: input.usedReworkKg,
      packedBoxes: input.packedBoxes,
      weighingLossKg: input.weighingLossKg,
      generatedReworkKg: input.generatedReworkKg,
      averagePackageWeightG: input.averagePackageWeightG,
      weightConfig
    });

    const yieldStatus = classifyRule({ metric: "yield", value: calculated.realYieldPercent, target: 0.95 });
    const overweightStatus = classifyRule({
      metric: "overweight",
      value: calculated.overweightPercent,
      target: weightConfig.overweightTolerancePercent
    });
    const costs = calculateProductionCosts({
      producedKg: calculated.producedKg,
      weighingLossKg: input.weighingLossKg,
      overweightKg: calculated.overweightTotalKg,
      pricePerKg: Number(pricePeriod?.pricePerKg ?? product.pricePerKg)
    });

    const order = await this.prisma.productionOrder.upsert({
      where: {
        weekId_orderNumber_productId: {
          weekId: input.weekId,
          orderNumber: input.productionOrder,
          productId: product.id
        }
      },
      create: {
        weekId: input.weekId,
        productId: product.id,
        sectorCode: input.sector,
        orderNumber: input.productionOrder
      },
      update: { status: "OPEN" }
    });

    const entry = await this.prisma.productionEntry.create({
      data: {
        weekId: input.weekId,
        sectorId: sector.id,
        productId: product.id,
        productionOrderId: order.id,
        date: input.date,
        productionOrder: input.productionOrder,
        plannedBatches: input.plannedBatches,
        realizedBatches: input.realizedBatches,
        usedReworkKg: input.usedReworkKg,
        packedBoxes: input.packedBoxes,
        producedKg: calculated.producedKg,
        weighingLossKg: input.weighingLossKg,
        generatedReworkKg: input.generatedReworkKg,
        expectedYieldKg: calculated.expectedYieldKg,
        realYieldPercent: calculated.realYieldPercent,
        massWeightKg: weightConfig.massWeightKg,
        boxWeightKg: weightConfig.boxWeightKg,
        targetPackageWeightG: weightConfig.targetPackageWeightG,
        averagePackageWeightG: input.averagePackageWeightG,
        overweightGPerPackage: calculated.overweightGPerPackage,
        overweightTotalKg: calculated.overweightTotalKg,
        overweightPercent: calculated.overweightPercent,
        unitPricePerKg: costs.unitPricePerKg,
        productionCost: costs.productionCost,
        lossesCost: costs.lossesCost,
        overweightCost: costs.overweightCost,
        status: worstStatus(yieldStatus, overweightStatus),
        notes: [input.notes, ...calculated.inconsistencies].filter(Boolean).join("\n"),
        createdBy: this.safeUserId(user),
        updatedBy: this.safeUserId(user)
      },
      include: { week: true, sector: true, product: true }
    });

    await this.audit.record({ userId: this.safeUserId(user), module: "production", action: "create", entity: "ProductionEntry", entityId: entry.id, after: entry });
    return { ...entry, calculations: calculated };
  }

  async duplicate(id: string, user?: CurrentUser) {
    const current = await this.prisma.productionEntry.findUnique({ where: { id }, include: { week: true, sector: true } });
    if (!current || current.deletedAt) throw new NotFoundException("Lancamento nao encontrado.");
    assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite duplicacao.");
    const newOrderNumber = `${current.productionOrder}-COPIA`;
    const order = await this.prisma.productionOrder.upsert({
      where: {
        weekId_orderNumber_productId: {
          weekId: current.weekId,
          orderNumber: newOrderNumber,
          productId: current.productId
        }
      },
      create: {
        weekId: current.weekId,
        productId: current.productId,
        sectorCode: current.sector.code,
        orderNumber: newOrderNumber
      },
      update: { status: "OPEN" }
    });
    const duplicated = await this.prisma.productionEntry.create({
      data: {
        weekId: current.weekId,
        sectorId: current.sectorId,
        lineId: current.lineId,
        productId: current.productId,
        productionOrderId: order.id,
        date: current.date,
        productionOrder: newOrderNumber,
        plannedBatches: current.plannedBatches,
        realizedBatches: current.realizedBatches,
        usedReworkKg: current.usedReworkKg,
        packedBoxes: current.packedBoxes,
        producedKg: current.producedKg,
        weighingLossKg: current.weighingLossKg,
        generatedReworkKg: current.generatedReworkKg,
        expectedYieldKg: current.expectedYieldKg,
        realYieldPercent: current.realYieldPercent,
        massWeightKg: current.massWeightKg,
        boxWeightKg: current.boxWeightKg,
        targetPackageWeightG: current.targetPackageWeightG,
        averagePackageWeightG: current.averagePackageWeightG,
        overweightGPerPackage: current.overweightGPerPackage,
        overweightTotalKg: current.overweightTotalKg,
        overweightPercent: current.overweightPercent,
        unitPricePerKg: current.unitPricePerKg,
        productionCost: current.productionCost,
        lossesCost: current.lossesCost,
        overweightCost: current.overweightCost,
        status: current.status,
        notes: current.notes,
        createdBy: this.safeUserId(user),
        updatedBy: this.safeUserId(user)
      },
      include: { week: true, sector: true, product: true, order: true }
    });
    await this.audit.record({ userId: this.safeUserId(user), module: "production", action: "duplicate", entity: "ProductionEntry", entityId: duplicated.id, before: current, after: duplicated });
    return duplicated;
  }

  async softDelete(id: string, user?: CurrentUser) {
    const current = await this.prisma.productionEntry.findUnique({ where: { id }, include: { week: true } });
    if (!current || current.deletedAt) throw new NotFoundException("Lancamento nao encontrado.");
    assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite exclusao.");
    const entry = await this.prisma.productionEntry.update({
      where: { id },
      data: { deletedAt: new Date(), updatedBy: this.safeUserId(user) }
    });
    await this.audit.record({ userId: this.safeUserId(user), module: "production", action: "delete", entity: "ProductionEntry", entityId: id, before: current, after: entry });
    return entry;
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
