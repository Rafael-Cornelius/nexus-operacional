import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { ProductionEntryInput, productionEntrySchema, productionPreviewSchema } from "../../domain/validators/schemas";
import { calculateProductionEntry } from "../../domain/calculations/production-calculations";
import { ProductWeightConfig } from "../../domain/calculations/types";
import { classifyRule } from "../../domain/alerts/alert-engine";
import { calculateProductionCosts } from "../../domain/calculations/financial-calculations";
import { assertDateWithinWeek, assertWeekWritable } from "../../domain/weeks/week-rules";
import {
  assertCurrentVersion,
  assertCanAmendApproved,
  assertIndependentApprover,
  assertWorkflowState,
  recordVersionSchema,
  throwOptimisticConflict,
  versionedOptionalReasonCommandSchema,
  versionedReasonCommandSchema,
  workflowReasonSchema
} from "../../domain/workflow/workflow-rules";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";

const severity = { OK: 0, MEDIUM: 1, ATTENTION: 2, CRITICAL: 3 } as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const productionEntryUpdateSchema = productionEntrySchema
  .partial()
  .extend({
    lineId: z.string().uuid().nullable().optional(),
    equipmentId: z.string().uuid().nullable().optional(),
    shiftId: z.string().uuid().nullable().optional(),
    averagePackageWeightG: z.coerce.number().nonnegative().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    version: recordVersionSchema,
    changeReason: workflowReasonSchema.optional()
  })
  .strict()
  .refine(({ version: _version, changeReason: _changeReason, ...changes }) => Object.keys(changes).length > 0, {
    message: "Informe ao menos um campo para atualizar."
  });
const productionCalculationNotes = new Set([
  "Realizado acima do planejado em mais de 10%.",
  "Producao informada sem rendimento esperado calculavel.",
  "Produto sem peso alvo de pacote valido.",
  "Produto sem pacotes por caixa valido."
]);

function worstStatus(...statuses: Array<keyof typeof severity>) {
  return statuses.sort((a, b) => severity[b] - severity[a])[0] ?? "OK";
}

function dateOnly(value: Date) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function userNotes(value?: string | null) {
  const lines = (value ?? "").split("\n").filter((line) => line.trim() && !productionCalculationNotes.has(line.trim()));
  return lines.join("\n") || undefined;
}

function notesWithCalculations(value: string | undefined, inconsistencies: string[]) {
  return [userNotes(value), ...inconsistencies].filter(Boolean).join("\n") || undefined;
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
    const yieldStatus = classifyRule({
      metric: "yield",
      value: calculations.realYieldPercent,
      target: 0.95
    });
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
      include: { week: true, product: true, sector: true, line: true, equipment: true, shift: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  async getById(id: string) {
    const entry = await this.prisma.productionEntry.findFirst({
      where: { id, deletedAt: null },
      include: {
        week: true,
        product: true,
        sector: true,
        line: true,
        equipment: true,
        shift: true,
        order: true
      }
    });
    if (!entry) throw new NotFoundException("Lancamento nao encontrado.");
    return entry;
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = productionEntrySchema.parse(payload);
    const resolved = await this.resolveEntry(input);
    const order = await this.upsertOrder(input);
    const userId = this.safeUserId(user);

    const entry = await this.prisma.productionEntry.create({
      data: {
        weekId: input.weekId,
        sectorId: resolved.sector.id,
        lineId: resolved.line?.id,
        equipmentId: resolved.equipment?.id,
        shiftId: resolved.shift?.id,
        productId: resolved.product.id,
        productionOrderId: order.id,
        date: input.date,
        productionOrder: input.productionOrder,
        plannedBatches: input.plannedBatches,
        realizedBatches: input.realizedBatches,
        usedReworkKg: input.usedReworkKg,
        packedBoxes: input.packedBoxes,
        producedKg: resolved.calculated.producedKg,
        weighingLossKg: input.weighingLossKg,
        generatedReworkKg: input.generatedReworkKg,
        expectedYieldKg: resolved.calculated.expectedYieldKg,
        realYieldPercent: resolved.calculated.realYieldPercent,
        massWeightKg: resolved.weightConfig.massWeightKg,
        boxWeightKg: resolved.weightConfig.boxWeightKg,
        targetPackageWeightG: resolved.weightConfig.targetPackageWeightG,
        averagePackageWeightG: input.averagePackageWeightG,
        overweightGPerPackage: resolved.calculated.overweightGPerPackage,
        overweightTotalKg: resolved.calculated.overweightTotalKg,
        overweightPercent: resolved.calculated.overweightPercent,
        unitPricePerKg: resolved.costs.unitPricePerKg,
        productionCost: resolved.costs.productionCost,
        lossesCost: resolved.costs.lossesCost,
        overweightCost: resolved.costs.overweightCost,
        status: resolved.status,
        workflowStatus: "DRAFT",
        notes: notesWithCalculations(input.notes, resolved.calculated.inconsistencies),
        createdBy: userId,
        updatedBy: userId
      },
      include: {
        week: true,
        sector: true,
        product: true,
        line: true,
        equipment: true,
        shift: true,
        order: true
      }
    });

    await this.audit.record({
      userId,
      module: "production",
      action: "create",
      entity: "ProductionEntry",
      entityId: entry.id,
      after: entry
    });
    return { ...entry, calculations: resolved.calculated };
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const patch = productionEntryUpdateSchema.parse(payload);
    const current = await this.prisma.productionEntry.findUnique({
      where: { id },
      include: {
        week: true,
        product: true,
        sector: true,
        line: true,
        equipment: true,
        shift: true,
        order: true
      }
    });
    if (!current || current.deletedAt) throw new NotFoundException("Lancamento nao encontrado.");
    if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite edicao.");
    assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite edicao.");
    assertCurrentVersion(current.version, patch.version);
    assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED", "APPROVED"], "edicao");
    assertCanAmendApproved(current.workflowStatus, user?.roles);
    if (current.workflowStatus === "APPROVED" && !patch.changeReason) {
      throw new BadRequestException("Alteracao de lancamento aprovado exige motivo.");
    }

    const input = productionEntrySchema.parse({
      weekId: patch.weekId ?? current.weekId,
      sector: patch.sector ?? current.sector.code,
      lineId: Object.prototype.hasOwnProperty.call(patch, "lineId") ? (patch.lineId ?? undefined) : (current.lineId ?? undefined),
      equipmentId: Object.prototype.hasOwnProperty.call(patch, "equipmentId") ? (patch.equipmentId ?? undefined) : (current.equipmentId ?? undefined),
      shiftId: Object.prototype.hasOwnProperty.call(patch, "shiftId") ? (patch.shiftId ?? undefined) : (current.shiftId ?? undefined),
      date: patch.date ?? current.date,
      productId: patch.productId ?? current.productId,
      productionOrder: patch.productionOrder ?? current.productionOrder,
      plannedBatches: patch.plannedBatches ?? current.plannedBatches,
      realizedBatches: patch.realizedBatches ?? current.realizedBatches,
      usedReworkKg: patch.usedReworkKg ?? current.usedReworkKg,
      packedBoxes: patch.packedBoxes ?? current.packedBoxes,
      weighingLossKg: patch.weighingLossKg ?? current.weighingLossKg,
      generatedReworkKg: patch.generatedReworkKg ?? current.generatedReworkKg,
      averagePackageWeightG: Object.prototype.hasOwnProperty.call(patch, "averagePackageWeightG")
        ? (patch.averagePackageWeightG ?? undefined)
        : (current.averagePackageWeightG ?? undefined),
      notes: Object.prototype.hasOwnProperty.call(patch, "notes") ? (patch.notes ?? undefined) : userNotes(current.notes)
    });
    const resolved = await this.resolveEntry(input, {
      productId: current.productId,
      lineId: current.lineId,
      equipmentId: current.equipmentId,
      shiftId: current.shiftId
    });
    const order = await this.upsertOrder(input);
    const userId = this.safeUserId(user);

    const entry = await this.updateWithVersion(id, patch.version, {
      weekId: input.weekId,
      sectorId: resolved.sector.id,
      lineId: resolved.line?.id ?? null,
      equipmentId: resolved.equipment?.id ?? null,
      shiftId: resolved.shift?.id ?? null,
      productId: resolved.product.id,
      productionOrderId: order.id,
      date: input.date,
      productionOrder: input.productionOrder,
      plannedBatches: input.plannedBatches,
      realizedBatches: input.realizedBatches,
      usedReworkKg: input.usedReworkKg,
      packedBoxes: input.packedBoxes,
      producedKg: resolved.calculated.producedKg,
      weighingLossKg: input.weighingLossKg,
      generatedReworkKg: input.generatedReworkKg,
      expectedYieldKg: resolved.calculated.expectedYieldKg,
      realYieldPercent: resolved.calculated.realYieldPercent,
      massWeightKg: resolved.weightConfig.massWeightKg,
      boxWeightKg: resolved.weightConfig.boxWeightKg,
      targetPackageWeightG: resolved.weightConfig.targetPackageWeightG,
      averagePackageWeightG: Object.prototype.hasOwnProperty.call(patch, "averagePackageWeightG") && patch.averagePackageWeightG === null ? null : input.averagePackageWeightG,
      overweightGPerPackage: resolved.calculated.overweightGPerPackage,
      overweightTotalKg: resolved.calculated.overweightTotalKg,
      overweightPercent: resolved.calculated.overweightPercent,
      unitPricePerKg: resolved.costs.unitPricePerKg,
      productionCost: resolved.costs.productionCost,
      lossesCost: resolved.costs.lossesCost,
      overweightCost: resolved.costs.overweightCost,
      status: resolved.status,
      workflowStatus: "DRAFT",
      submittedAt: null,
      submittedBy: null,
      submissionReason: null,
      approvedAt: null,
      approvedBy: null,
      approvalReason: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      notes: notesWithCalculations(input.notes, resolved.calculated.inconsistencies) ?? null,
      updatedBy: userId
    });

    await this.audit.record({
      userId,
      module: "production",
      action: "update",
      entity: "ProductionEntry",
      entityId: id,
      before: current,
      after: entry,
      reason: patch.changeReason
    });
    return { ...entry, calculations: resolved.calculated };
  }

  async duplicate(id: string, user?: CurrentUser) {
    const current = await this.prisma.productionEntry.findUnique({
      where: { id },
      include: { week: true, sector: true }
    });
    if (!current || current.deletedAt) throw new NotFoundException("Lancamento nao encontrado.");
    if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite duplicacao.");
    assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite duplicacao.");
    assertDateWithinWeek(current.date, current.week, "Data do lancamento precisa pertencer ao periodo da semana selecionada.");
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
        equipmentId: current.equipmentId,
        shiftId: current.shiftId,
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
        workflowStatus: "DRAFT",
        notes: current.notes,
        createdBy: this.safeUserId(user),
        updatedBy: this.safeUserId(user)
      },
      include: { week: true, sector: true, product: true, order: true }
    });
    await this.audit.record({
      userId: this.safeUserId(user),
      module: "production",
      action: "duplicate",
      entity: "ProductionEntry",
      entityId: duplicated.id,
      before: current,
      after: duplicated
    });
    return duplicated;
  }

  async softDelete(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const current = await this.prisma.productionEntry.findUnique({
      where: { id },
      include: { week: true }
    });
    if (!current || current.deletedAt) throw new NotFoundException("Lancamento nao encontrado.");
    if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite exclusao.");
    assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite exclusao.");
    assertCurrentVersion(current.version, command.version);
    assertWorkflowState(current.workflowStatus, ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"], "exclusao");
    const userId = this.requireActorId(user);
    const entry = await this.updateWithVersion(id, command.version, {
      deletedAt: new Date(),
      workflowStatus: "CANCELLED",
      updatedBy: userId
    });
    await this.audit.record({
      userId,
      module: "production",
      action: "delete",
      entity: "ProductionEntry",
      entityId: id,
      before: current,
      after: entry,
      reason: command.reason
    });
    return entry;
  }

  async restore(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const current = await this.prisma.productionEntry.findUnique({
      where: { id },
      include: { week: true }
    });
    if (!current || !current.deletedAt) throw new NotFoundException("Lancamento excluido nao encontrado.");
    if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite restauracao.");
    assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite restauracao.");
    assertDateWithinWeek(current.date, current.week, "Data do lancamento precisa pertencer ao periodo da semana selecionada.");
    assertCurrentVersion(current.version, command.version);
    const userId = this.requireActorId(user);
    const entry = await this.updateWithVersion(id, command.version, {
      deletedAt: null,
      workflowStatus: "DRAFT",
      submittedAt: null,
      submittedBy: null,
      submissionReason: null,
      approvedAt: null,
      approvedBy: null,
      approvalReason: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      updatedBy: userId
    });
    await this.audit.record({
      userId,
      module: "production",
      action: "restore",
      entity: "ProductionEntry",
      entityId: id,
      before: current,
      after: entry,
      reason: command.reason
    });
    return entry;
  }

  async submit(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const current = await this.workflowRecord(id, "submissao");
    assertCurrentVersion(current.version, command.version);
    assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED"], "submissao");
    const userId = this.requireActorId(user);
    const entry = await this.updateWithVersion(id, command.version, {
      workflowStatus: "SUBMITTED",
      submittedAt: new Date(),
      submittedBy: userId,
      submissionReason: command.reason ?? null,
      approvedAt: null,
      approvedBy: null,
      approvalReason: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      updatedBy: userId
    });
    await this.audit.record({ userId, module: "production", action: "submit", entity: "ProductionEntry", entityId: id, before: current, after: entry, reason: command.reason });
    return entry;
  }

  async approve(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const current = await this.workflowRecord(id, "aprovacao");
    assertCurrentVersion(current.version, command.version);
    assertWorkflowState(current.workflowStatus, ["SUBMITTED", "UNDER_REVIEW"], "aprovacao");
    const userId = this.requireActorId(user);
    assertIndependentApprover(current.submittedBy, userId);
    const entry = await this.updateWithVersion(id, command.version, {
      workflowStatus: "APPROVED",
      approvedAt: new Date(),
      approvedBy: userId,
      approvalReason: command.reason ?? null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      updatedBy: userId
    });
    await this.audit.record({ userId, module: "production", action: "approve", entity: "ProductionEntry", entityId: id, before: current, after: entry, reason: command.reason });
    return entry;
  }

  async reject(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const current = await this.workflowRecord(id, "rejeicao");
    assertCurrentVersion(current.version, command.version);
    assertWorkflowState(current.workflowStatus, ["SUBMITTED", "UNDER_REVIEW"], "rejeicao");
    const userId = this.requireActorId(user);
    const entry = await this.updateWithVersion(id, command.version, {
      workflowStatus: "REJECTED",
      rejectedAt: new Date(),
      rejectedBy: userId,
      rejectionReason: command.reason,
      approvedAt: null,
      approvedBy: null,
      approvalReason: null,
      updatedBy: userId
    });
    await this.audit.record({ userId, module: "production", action: "reject", entity: "ProductionEntry", entityId: id, before: current, after: entry, reason: command.reason });
    return entry;
  }

  private async resolveEntry(
    input: ProductionEntryInput,
    existing?: { productId: string; lineId: string | null; equipmentId: string | null; shiftId: string | null }
  ) {
    const week = await this.prisma.weeklyPeriod.findUnique({
      where: { id: input.weekId }
    });
    if (!week || week.deletedAt) throw new NotFoundException("Semana nao encontrada.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita alteracoes no lancamento.");
    assertDateWithinWeek(input.date, week, "Data do lancamento precisa pertencer ao periodo da semana selecionada.");

    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
      include: { weightConfig: true }
    });
    if (!product || product.deletedAt) throw new NotFoundException("Produto nao encontrado.");
    if (!product.active && product.id !== existing?.productId) {
      throw new BadRequestException("Produto inativo nao pode ser usado no lancamento.");
    }
    if (!product.weightConfig) throw new BadRequestException("Produto sem configuracao de peso.");

    const sector = await this.prisma.sector.findUnique({
      where: { code: input.sector }
    });
    if (!sector) throw new NotFoundException("Setor nao encontrado.");
    const [requestedLine, equipment, shift] = await Promise.all([
      input.lineId ? this.prisma.productionLine.findUnique({ where: { id: input.lineId } }) : Promise.resolve(null),
      input.equipmentId ? this.prisma.equipment.findUnique({ where: { id: input.equipmentId }, include: { productionLine: true } }) : Promise.resolve(null),
      input.shiftId ? this.prisma.shift.findUnique({ where: { id: input.shiftId } }) : Promise.resolve(null)
    ]);
    const line = requestedLine ?? equipment?.productionLine ?? null;
    if (input.lineId && (!requestedLine || requestedLine.deletedAt)) throw new NotFoundException("Linha de producao nao encontrada.");
    if (line?.deletedAt) throw new NotFoundException("Linha de producao nao encontrada.");
    if (line && !line.active && line.id !== existing?.lineId) throw new BadRequestException("Linha inativa nao pode ser usada no lancamento.");
    if (line && line.sectorId !== sector.id) throw new BadRequestException("Linha de producao nao pertence ao setor informado.");
    if (input.equipmentId && (!equipment || equipment.deletedAt)) throw new NotFoundException("Equipamento nao encontrado.");
    if (equipment && !equipment.active && equipment.id !== existing?.equipmentId) throw new BadRequestException("Equipamento inativo nao pode ser usado no lancamento.");
    if (equipment && requestedLine && equipment.productionLineId !== requestedLine.id) throw new BadRequestException("Equipamento nao pertence a linha de producao informada.");
    if (input.shiftId && (!shift || shift.deletedAt)) throw new NotFoundException("Turno nao encontrado.");
    if (shift && !shift.active && shift.id !== existing?.shiftId) throw new BadRequestException("Turno inativo nao pode ser usado no lancamento.");
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
    const yieldStatus = classifyRule({
      metric: "yield",
      value: calculated.realYieldPercent,
      target: 0.95
    });
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

    return {
      week,
      product,
      sector,
      line,
      equipment,
      shift,
      weightConfig,
      calculated,
      costs,
      status: worstStatus(yieldStatus, overweightStatus)
    };
  }

  private async upsertOrder(input: ProductionEntryInput) {
    const key = {
      weekId_orderNumber_productId: {
        weekId: input.weekId,
        orderNumber: input.productionOrder,
        productId: input.productId
      }
    };
    const current = await this.prisma.productionOrder.findUnique({ where: key });
    if (current && !current.deletedAt && current.sectorCode !== input.sector) {
      throw new BadRequestException("Ordem de producao ja esta vinculada a outro setor.");
    }
    const order = await this.prisma.productionOrder.upsert({
      where: {
        ...key
      },
      create: {
        weekId: input.weekId,
        productId: input.productId,
        sectorCode: input.sector,
        orderNumber: input.productionOrder
      },
      update: { status: "OPEN", sectorCode: current?.deletedAt ? input.sector : undefined, deletedAt: null }
    });
    if (order.sectorCode !== input.sector) {
      throw new BadRequestException("Ordem de producao ja esta vinculada a outro setor.");
    }
    return order;
  }

  private async workflowRecord(id: string, action: string) {
    const current = await this.prisma.productionEntry.findUnique({ where: { id }, include: { week: true } });
    if (!current || current.deletedAt) throw new NotFoundException("Lancamento nao encontrado.");
    if (current.week.deletedAt) throw new BadRequestException(`Semana removida nao permite ${action}.`);
    assertWeekWritable(current.week, `Semana fechada ou arquivada nao permite ${action}.`);
    assertDateWithinWeek(current.date, current.week, "Data do lancamento precisa pertencer ao periodo da semana selecionada.");
    return current;
  }

  private async updateWithVersion(id: string, version: number, data: Prisma.ProductionEntryUncheckedUpdateInput) {
    try {
      return await this.prisma.productionEntry.update({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
        include: { week: true, product: true, sector: true, line: true, equipment: true, shift: true, order: true }
      });
    } catch (error) {
      throwOptimisticConflict(error);
    }
  }

  private requireActorId(user?: CurrentUser) {
    const userId = this.safeUserId(user);
    if (!userId) throw new BadRequestException("Usuario autenticado invalido para esta operacao.");
    return userId;
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
