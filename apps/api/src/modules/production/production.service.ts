import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import {
  ProductionEntryInput,
  productionEntrySchema,
  productionPreviewSchema,
} from "../../domain/validators/schemas";
import { calculateProductionEntry } from "../../domain/calculations/production-calculations";
import { ProductWeightConfig } from "../../domain/calculations/types";
import { classifyRule } from "../../domain/alerts/alert-engine";
import { calculateProductionCosts } from "../../domain/calculations/financial-calculations";
import { mergeCalculationRuleVersions } from "../../domain/calculations/rule-registry";
import {
  assertDateWithinWeek,
  assertWeekWritable,
} from "../../domain/weeks/week-rules";
import {
  assertCurrentVersion,
  assertCanAmendApproved,
  assertIndependentApprover,
  assertWorkflowState,
  recordVersionSchema,
  throwOptimisticConflict,
  versionedOptionalReasonCommandSchema,
  versionedReasonCommandSchema,
  workflowReasonSchema,
} from "../../domain/workflow/workflow-rules";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const productionEntryUpdateSchema = productionEntrySchema
  .partial()
  .extend({
    lineId: z.string().uuid().nullable().optional(),
    equipmentId: z.string().uuid().nullable().optional(),
    shiftId: z.string().uuid().nullable().optional(),
    averagePackageWeightG: z.coerce
      .number()
      .nonnegative()
      .nullable()
      .optional(),
    notes: z.string().max(2000).nullable().optional(),
    version: recordVersionSchema,
    changeReason: workflowReasonSchema.optional(),
  })
  .strict()
  .refine(
    ({ version: _version, changeReason: _changeReason, ...changes }) =>
      Object.keys(changes).length > 0,
    {
      message: "Informe ao menos um campo para atualizar.",
    },
  );
const productionCalculationNotes = new Set([
  "Realizado acima do planejado em mais de 10%.",
  "Producao informada sem rendimento esperado calculavel.",
  "Realizado informado sem plano calculavel.",
  "Produto sem peso alvo de pacote valido.",
  "Produto sem pacotes por caixa valido.",
]);
const maxProductionOrderLength = 80;
const maxCopySuffixAttempts = 10_000;

function dateOnly(value: Date) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function userNotes(value?: string | null) {
  const lines = (value ?? "")
    .split("\n")
    .filter(
      (line) => line.trim() && !productionCalculationNotes.has(line.trim()),
    );
  return lines.join("\n") || undefined;
}

function notesWithCalculations(
  value: string | undefined,
  inconsistencies: string[],
) {
  return (
    [userNotes(value), ...inconsistencies].filter(Boolean).join("\n") ||
    undefined
  );
}

@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  preview(payload: unknown) {
    const input = productionPreviewSchema.parse(payload);
    const calculations = calculateProductionEntry(input);
    const overweightStatus = classifyRule({
      metric: "overweight",
      value: calculations.overweightPercent,
      target: input.weightConfig.overweightTolerancePercent,
    });

    const costs = calculateProductionCosts({
      producedKg: calculations.producedKg,
      weighingLossKg: input.weighingLossKg,
      overweightKg: calculations.overweightTotalKg,
      pricePerKg: input.pricePerKg,
    });
    return {
      ...calculations,
      ...costs,
      calculationRuleVersions: mergeCalculationRuleVersions(
        calculations.calculationRuleVersions,
        costs.calculationRuleVersions,
      ),
      status: overweightStatus,
    };
  }

  async list(query: {
    weekId?: string;
    sector?: "P1" | "P2";
    productId?: string;
    op?: string;
  }) {
    return this.prisma.productionEntry.findMany({
      where: {
        deletedAt: null,
        weekId: query.weekId,
        sector: query.sector ? { code: query.sector } : undefined,
        productId: query.productId,
        productionOrder: query.op,
      },
      include: {
        week: true,
        product: true,
        sector: true,
        line: true,
        equipment: true,
        shift: true,
        pricePeriod: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
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
        order: true,
        pricePeriod: true,
      },
    });
    if (!entry) throw new NotFoundException("Lancamento nao encontrado.");
    return entry;
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = productionEntrySchema.parse(payload);
    const userId = this.safeUserId(user);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockProductionOrder(transaction, input);
      const resolved = await this.resolveEntry(input, undefined, transaction);
      await this.assertNoIdenticalActiveEntry(transaction, input, {
        sectorId: resolved.sector.id,
        lineId: resolved.line?.id ?? null,
        equipmentId: resolved.equipment?.id ?? null,
        shiftId: resolved.shift?.id ?? null,
      });
      const order = await this.upsertOrder(input, transaction);
      const calculationRuleVersions = mergeCalculationRuleVersions(
        resolved.calculated.calculationRuleVersions,
        resolved.costs.calculationRuleVersions,
      );
      const entry = await transaction.productionEntry.create({
        data: {
          weekId: input.weekId,
          sectorId: resolved.sector.id,
          lineId: resolved.line?.id,
          equipmentId: resolved.equipment?.id,
          shiftId: resolved.shift?.id,
          productId: resolved.product.id,
          pricePeriodId: resolved.pricePeriod.id,
          priceVersion: resolved.pricePeriod.version,
          priceOrigin: resolved.pricePeriod.origin,
          priceCurrency: resolved.pricePeriod.currency,
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
          calculationRuleVersions: { ...calculationRuleVersions },
          status: resolved.status,
          workflowStatus: "DRAFT",
          notes: notesWithCalculations(
            input.notes,
            resolved.calculated.inconsistencies,
          ),
          createdBy: userId,
          updatedBy: userId,
        },
        include: {
          week: true,
          sector: true,
          product: true,
          line: true,
          equipment: true,
          shift: true,
          order: true,
          pricePeriod: true,
        },
      });

      await this.audit.record(
        {
          userId,
          module: "production",
          action: "create",
          entity: "ProductionEntry",
          entityId: entry.id,
          after: entry,
        },
        transaction,
      );
      return {
        ...entry,
        calculations: {
          ...resolved.calculated,
          calculationRuleVersions,
        },
      };
    });
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const patch = productionEntryUpdateSchema.parse(payload);
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.productionEntry.findUnique({
        where: { id },
        include: {
          week: true,
          product: true,
          sector: true,
          line: true,
          equipment: true,
          shift: true,
          order: true,
          pricePeriod: true,
        },
      });
      if (!current || current.deletedAt)
        throw new NotFoundException("Lancamento nao encontrado.");
      if (current.week.deletedAt)
        throw new BadRequestException("Semana removida nao permite edicao.");
      assertWeekWritable(
        current.week,
        "Semana fechada ou arquivada nao permite edicao.",
      );
      assertCurrentVersion(current.version, patch.version);
      assertWorkflowState(
        current.workflowStatus,
        ["DRAFT", "REJECTED", "APPROVED"],
        "edicao",
      );
      assertCanAmendApproved(current.workflowStatus, user?.roles);
      if (current.workflowStatus === "APPROVED" && !patch.changeReason) {
        throw new BadRequestException(
          "Alteracao de lancamento aprovado exige motivo.",
        );
      }

      const input = productionEntrySchema.parse({
        weekId: patch.weekId ?? current.weekId,
        sector: patch.sector ?? current.sector.code,
        lineId: Object.prototype.hasOwnProperty.call(patch, "lineId")
          ? (patch.lineId ?? undefined)
          : (current.lineId ?? undefined),
        equipmentId: Object.prototype.hasOwnProperty.call(patch, "equipmentId")
          ? (patch.equipmentId ?? undefined)
          : (current.equipmentId ?? undefined),
        shiftId: Object.prototype.hasOwnProperty.call(patch, "shiftId")
          ? (patch.shiftId ?? undefined)
          : (current.shiftId ?? undefined),
        date: patch.date ?? current.date,
        productId: patch.productId ?? current.productId,
        productionOrder: patch.productionOrder ?? current.productionOrder,
        plannedBatches: patch.plannedBatches ?? current.plannedBatches,
        realizedBatches: patch.realizedBatches ?? current.realizedBatches,
        usedReworkKg: patch.usedReworkKg ?? current.usedReworkKg,
        packedBoxes: patch.packedBoxes ?? current.packedBoxes,
        weighingLossKg: patch.weighingLossKg ?? current.weighingLossKg,
        generatedReworkKg: patch.generatedReworkKg ?? current.generatedReworkKg,
        averagePackageWeightG: Object.prototype.hasOwnProperty.call(
          patch,
          "averagePackageWeightG",
        )
          ? (patch.averagePackageWeightG ?? undefined)
          : (current.averagePackageWeightG ?? undefined),
        notes: Object.prototype.hasOwnProperty.call(patch, "notes")
          ? (patch.notes ?? undefined)
          : userNotes(current.notes),
      });
      await this.lockProductionOrder(transaction, input);
      const resolved = await this.resolveEntry(
        input,
        {
          productId: current.productId,
          lineId: current.lineId,
          equipmentId: current.equipmentId,
          shiftId: current.shiftId,
        },
        transaction,
      );
      await this.assertNoIdenticalActiveEntry(
        transaction,
        input,
        {
          sectorId: resolved.sector.id,
          lineId: resolved.line?.id ?? null,
          equipmentId: resolved.equipment?.id ?? null,
          shiftId: resolved.shift?.id ?? null,
        },
        id,
      );
      const order = await this.upsertOrder(input, transaction);
      const userId = this.safeUserId(user);
      const calculationRuleVersions = mergeCalculationRuleVersions(
        resolved.calculated.calculationRuleVersions,
        resolved.costs.calculationRuleVersions,
      );

      const entry = await this.updateWithVersion(
        id,
        patch.version,
        {
          weekId: input.weekId,
          sectorId: resolved.sector.id,
          lineId: resolved.line?.id ?? null,
          equipmentId: resolved.equipment?.id ?? null,
          shiftId: resolved.shift?.id ?? null,
          productId: resolved.product.id,
          pricePeriodId: resolved.pricePeriod.id,
          priceVersion: resolved.pricePeriod.version,
          priceOrigin: resolved.pricePeriod.origin,
          priceCurrency: resolved.pricePeriod.currency,
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
          averagePackageWeightG:
            Object.prototype.hasOwnProperty.call(
              patch,
              "averagePackageWeightG",
            ) && patch.averagePackageWeightG === null
              ? null
              : input.averagePackageWeightG,
          overweightGPerPackage: resolved.calculated.overweightGPerPackage,
          overweightTotalKg: resolved.calculated.overweightTotalKg,
          overweightPercent: resolved.calculated.overweightPercent,
          unitPricePerKg: resolved.costs.unitPricePerKg,
          productionCost: resolved.costs.productionCost,
          lossesCost: resolved.costs.lossesCost,
          overweightCost: resolved.costs.overweightCost,
          calculationRuleVersions: { ...calculationRuleVersions },
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
          notes:
            notesWithCalculations(
              input.notes,
              resolved.calculated.inconsistencies,
            ) ?? null,
          updatedBy: userId,
        },
        transaction,
      );

      await this.audit.record(
        {
          userId,
          module: "production",
          action: "update",
          entity: "ProductionEntry",
          entityId: id,
          before: current,
          after: entry,
          reason: patch.changeReason,
        },
        transaction,
      );
      return {
        ...entry,
        calculations: {
          ...resolved.calculated,
          calculationRuleVersions,
        },
      };
    });
  }

  async duplicate(id: string, user?: CurrentUser) {
    const userId = this.safeUserId(user);
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.productionEntry.findUnique({
        where: { id },
        include: { week: true, sector: true },
      });
      if (!current || current.deletedAt)
        throw new NotFoundException("Lancamento nao encontrado.");
      if (current.week.deletedAt)
        throw new BadRequestException(
          "Semana removida nao permite duplicacao.",
        );
      assertWeekWritable(
        current.week,
        "Semana fechada ou arquivada nao permite duplicacao.",
      );
      assertDateWithinWeek(
        current.date,
        current.week,
        "Data do lancamento precisa pertencer ao periodo da semana selecionada.",
      );
      const pricePeriod = await transaction.productPricePeriod.findFirst({
        where: {
          productId: current.productId,
          status: "APPROVED",
          startsOn: { lte: dateOnly(current.date) },
          OR: [{ endsOn: null }, { endsOn: { gte: dateOnly(current.date) } }],
        },
        orderBy: [{ startsOn: "desc" }, { version: "desc" }],
      });
      if (!pricePeriod)
        throw new BadRequestException(
          "Produto sem preco aprovado vigente na data do lancamento.",
        );
      const duplicatedCosts = calculateProductionCosts({
        producedKg: current.producedKg,
        weighingLossKg: current.weighingLossKg,
        overweightKg: current.overweightTotalKg,
        pricePerKg: pricePeriod.pricePerKg,
      });
      const newOrderNumber = await this.reserveCopyOrderNumber(transaction, {
        weekId: current.weekId,
        productId: current.productId,
        productionOrder: current.productionOrder,
      });
      const order = await transaction.productionOrder.upsert({
        where: {
          weekId_orderNumber_productId: {
            weekId: current.weekId,
            orderNumber: newOrderNumber,
            productId: current.productId,
          },
        },
        create: {
          weekId: current.weekId,
          productId: current.productId,
          sectorCode: current.sector.code,
          orderNumber: newOrderNumber,
        },
        update: { status: "OPEN", deletedAt: null },
      });
      const duplicated = await transaction.productionEntry.create({
        data: {
          weekId: current.weekId,
          sectorId: current.sectorId,
          lineId: current.lineId,
          equipmentId: current.equipmentId,
          shiftId: current.shiftId,
          productId: current.productId,
          pricePeriodId: pricePeriod.id,
          priceVersion: pricePeriod.version,
          priceOrigin: pricePeriod.origin,
          priceCurrency: pricePeriod.currency,
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
          unitPricePerKg: duplicatedCosts.unitPricePerKg,
          productionCost: duplicatedCosts.productionCost,
          lossesCost: duplicatedCosts.lossesCost,
          overweightCost: duplicatedCosts.overweightCost,
          calculationRuleVersions:
            current.calculationRuleVersions as Prisma.InputJsonObject,
          status: current.status,
          workflowStatus: "DRAFT",
          notes: current.notes,
          createdBy: userId,
          updatedBy: userId,
        },
        include: { week: true, sector: true, product: true, order: true },
      });
      await this.audit.record(
        {
          userId,
          module: "production",
          action: "duplicate",
          entity: "ProductionEntry",
          entityId: duplicated.id,
          before: current,
          after: duplicated,
        },
        transaction,
      );
      return duplicated;
    });
  }

  async softDelete(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const current = await this.prisma.productionEntry.findUnique({
      where: { id },
      include: { week: true },
    });
    if (!current || current.deletedAt)
      throw new NotFoundException("Lancamento nao encontrado.");
    if (current.week.deletedAt)
      throw new BadRequestException("Semana removida nao permite exclusao.");
    assertWeekWritable(
      current.week,
      "Semana fechada ou arquivada nao permite exclusao.",
    );
    assertCurrentVersion(current.version, command.version);
    assertWorkflowState(
      current.workflowStatus,
      ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"],
      "exclusao",
    );
    const userId = this.requireActorId(user);
    const entry = await this.updateWithVersion(id, command.version, {
      deletedAt: new Date(),
      workflowStatus: "CANCELLED",
      updatedBy: userId,
    });
    await this.audit.record({
      userId,
      module: "production",
      action: "delete",
      entity: "ProductionEntry",
      entityId: id,
      before: current,
      after: entry,
      reason: command.reason,
    });
    return entry;
  }

  async restore(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const current = await this.prisma.productionEntry.findUnique({
      where: { id },
      include: { week: true },
    });
    if (!current || !current.deletedAt)
      throw new NotFoundException("Lancamento excluido nao encontrado.");
    if (current.week.deletedAt)
      throw new BadRequestException("Semana removida nao permite restauracao.");
    assertWeekWritable(
      current.week,
      "Semana fechada ou arquivada nao permite restauracao.",
    );
    assertDateWithinWeek(
      current.date,
      current.week,
      "Data do lancamento precisa pertencer ao periodo da semana selecionada.",
    );
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
      updatedBy: userId,
    });
    await this.audit.record({
      userId,
      module: "production",
      action: "restore",
      entity: "ProductionEntry",
      entityId: id,
      before: current,
      after: entry,
      reason: command.reason,
    });
    return entry;
  }

  async submit(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const current = await this.workflowRecord(id, "submissao");
    assertCurrentVersion(current.version, command.version);
    assertWorkflowState(
      current.workflowStatus,
      ["DRAFT", "REJECTED"],
      "submissao",
    );
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
      updatedBy: userId,
    });
    await this.audit.record({
      userId,
      module: "production",
      action: "submit",
      entity: "ProductionEntry",
      entityId: id,
      before: current,
      after: entry,
      reason: command.reason,
    });
    return entry;
  }

  async approve(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const current = await this.workflowRecord(id, "aprovacao");
    assertCurrentVersion(current.version, command.version);
    assertWorkflowState(
      current.workflowStatus,
      ["SUBMITTED", "UNDER_REVIEW"],
      "aprovacao",
    );
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
      updatedBy: userId,
    });
    await this.audit.record({
      userId,
      module: "production",
      action: "approve",
      entity: "ProductionEntry",
      entityId: id,
      before: current,
      after: entry,
      reason: command.reason,
    });
    return entry;
  }

  async reject(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const current = await this.workflowRecord(id, "rejeicao");
    assertCurrentVersion(current.version, command.version);
    assertWorkflowState(
      current.workflowStatus,
      ["SUBMITTED", "UNDER_REVIEW"],
      "rejeicao",
    );
    const userId = this.requireActorId(user);
    const entry = await this.updateWithVersion(id, command.version, {
      workflowStatus: "REJECTED",
      rejectedAt: new Date(),
      rejectedBy: userId,
      rejectionReason: command.reason,
      approvedAt: null,
      approvedBy: null,
      approvalReason: null,
      updatedBy: userId,
    });
    await this.audit.record({
      userId,
      module: "production",
      action: "reject",
      entity: "ProductionEntry",
      entityId: id,
      before: current,
      after: entry,
      reason: command.reason,
    });
    return entry;
  }

  private async lockProductionOrder(
    transaction: Prisma.TransactionClient,
    key: Pick<ProductionEntryInput, "weekId" | "productId" | "productionOrder">,
  ) {
    const lockKey = [
      "nexus",
      "production-order",
      key.weekId,
      key.productId,
      key.productionOrder,
    ].join(":");
    await transaction.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
  }

  private async assertNoIdenticalActiveEntry(
    transaction: Prisma.TransactionClient,
    input: ProductionEntryInput,
    resource: {
      sectorId: string;
      lineId: string | null;
      equipmentId: string | null;
      shiftId: string | null;
    },
    excludeId?: string,
  ) {
    const duplicate = await transaction.productionEntry.findFirst({
      where: {
        id: excludeId ? { not: excludeId } : undefined,
        deletedAt: null,
        weekId: input.weekId,
        sectorId: resource.sectorId,
        lineId: resource.lineId,
        equipmentId: resource.equipmentId,
        shiftId: resource.shiftId,
        productId: input.productId,
        date: input.date,
        productionOrder: input.productionOrder,
        plannedBatches: input.plannedBatches,
        realizedBatches: input.realizedBatches,
        usedReworkKg: input.usedReworkKg,
        packedBoxes: input.packedBoxes,
        weighingLossKg: input.weighingLossKg,
        generatedReworkKg: input.generatedReworkKg,
        averagePackageWeightG: input.averagePackageWeightG ?? null,
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        "Lancamento ativo identico ja existe para esta OP, semana e produto. Informe dados parciais distintos ou edite o registro existente.",
      );
    }
  }

  private async reserveCopyOrderNumber(
    transaction: Prisma.TransactionClient,
    source: Pick<
      ProductionEntryInput,
      "weekId" | "productId" | "productionOrder"
    >,
  ) {
    for (
      let copyNumber = 1;
      copyNumber <= maxCopySuffixAttempts;
      copyNumber += 1
    ) {
      const suffix = copyNumber === 1 ? "-COPIA" : `-COPIA-${copyNumber}`;
      const base = source.productionOrder.slice(
        0,
        Math.max(0, maxProductionOrderLength - suffix.length),
      );
      const candidate = `${base}${suffix}`;
      const key = { ...source, productionOrder: candidate };
      await this.lockProductionOrder(transaction, key);
      const existing = await transaction.productionOrder.findUnique({
        where: {
          weekId_orderNumber_productId: {
            weekId: source.weekId,
            orderNumber: candidate,
            productId: source.productId,
          },
        },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    throw new ConflictException(
      "Nao foi possivel reservar sufixo unico para copia desta OP.",
    );
  }

  private async resolveEntry(
    input: ProductionEntryInput,
    existing?: {
      productId: string;
      lineId: string | null;
      equipmentId: string | null;
      shiftId: string | null;
    },
    client: Prisma.TransactionClient = this.prisma,
  ) {
    const week = await client.weeklyPeriod.findUnique({
      where: { id: input.weekId },
    });
    if (!week || week.deletedAt)
      throw new NotFoundException("Semana nao encontrada.");
    assertWeekWritable(
      week,
      "Semana fechada ou arquivada nao aceita alteracoes no lancamento.",
    );
    assertDateWithinWeek(
      input.date,
      week,
      "Data do lancamento precisa pertencer ao periodo da semana selecionada.",
    );

    const product = await client.product.findUnique({
      where: { id: input.productId },
      include: { weightConfig: true },
    });
    if (!product || product.deletedAt)
      throw new NotFoundException("Produto nao encontrado.");
    if (!product.active && product.id !== existing?.productId) {
      throw new BadRequestException(
        "Produto inativo nao pode ser usado no lancamento.",
      );
    }
    if (!product.weightConfig)
      throw new BadRequestException("Produto sem configuracao de peso.");

    const sector = await client.sector.findUnique({
      where: { code: input.sector },
    });
    if (!sector) throw new NotFoundException("Setor nao encontrado.");
    const [requestedLine, equipment, shift] = await Promise.all([
      input.lineId
        ? client.productionLine.findUnique({ where: { id: input.lineId } })
        : Promise.resolve(null),
      input.equipmentId
        ? client.equipment.findUnique({
            where: { id: input.equipmentId },
            include: { productionLine: true },
          })
        : Promise.resolve(null),
      input.shiftId
        ? client.shift.findUnique({ where: { id: input.shiftId } })
        : Promise.resolve(null),
    ]);
    const line = requestedLine ?? equipment?.productionLine ?? null;
    if (input.lineId && (!requestedLine || requestedLine.deletedAt))
      throw new NotFoundException("Linha de producao nao encontrada.");
    if (line?.deletedAt)
      throw new NotFoundException("Linha de producao nao encontrada.");
    if (line && !line.active && line.id !== existing?.lineId)
      throw new BadRequestException(
        "Linha inativa nao pode ser usada no lancamento.",
      );
    if (line && line.sectorId !== sector.id)
      throw new BadRequestException(
        "Linha de producao nao pertence ao setor informado.",
      );
    if (input.equipmentId && (!equipment || equipment.deletedAt))
      throw new NotFoundException("Equipamento nao encontrado.");
    if (
      equipment &&
      !equipment.active &&
      equipment.id !== existing?.equipmentId
    )
      throw new BadRequestException(
        "Equipamento inativo nao pode ser usado no lancamento.",
      );
    if (
      equipment &&
      requestedLine &&
      equipment.productionLineId !== requestedLine.id
    )
      throw new BadRequestException(
        "Equipamento nao pertence a linha de producao informada.",
      );
    if (input.shiftId && (!shift || shift.deletedAt))
      throw new NotFoundException("Turno nao encontrado.");
    if (shift && !shift.active && shift.id !== existing?.shiftId)
      throw new BadRequestException(
        "Turno inativo nao pode ser usado no lancamento.",
      );
    const weightConfig: ProductWeightConfig = {
      formula: product.weightConfig.formula,
      packageWeightKg: Number(product.weightConfig.packageWeightKg),
      boxWeightKg: Number(product.weightConfig.boxWeightKg),
      packagesPerBox: product.weightConfig.packagesPerBox,
      massWeightKg: Number(product.weightConfig.massWeightKg),
      targetPackageWeightG: Number(product.weightConfig.targetPackageWeightG),
      overweightTolerancePercent: Number(
        product.weightConfig.overweightTolerancePercent,
      ),
    };
    const pricePeriod = await client.productPricePeriod.findFirst({
      where: {
        productId: product.id,
        status: "APPROVED",
        startsOn: { lte: dateOnly(input.date) },
        OR: [{ endsOn: null }, { endsOn: { gte: dateOnly(input.date) } }],
      },
      orderBy: [{ startsOn: "desc" }, { version: "desc" }],
    });
    if (!pricePeriod)
      throw new BadRequestException(
        "Produto sem preco aprovado vigente na data do lancamento.",
      );
    const calculated = calculateProductionEntry({
      sector: input.sector,
      plannedBatches: input.plannedBatches,
      realizedBatches: input.realizedBatches,
      usedReworkKg: input.usedReworkKg,
      packedBoxes: input.packedBoxes,
      weighingLossKg: input.weighingLossKg,
      generatedReworkKg: input.generatedReworkKg,
      averagePackageWeightG: input.averagePackageWeightG,
      weightConfig,
    });
    const overweightStatus = classifyRule({
      metric: "overweight",
      value: calculated.overweightPercent,
      target: weightConfig.overweightTolerancePercent,
    });
    const costs = calculateProductionCosts({
      producedKg: calculated.producedKg,
      weighingLossKg: input.weighingLossKg,
      overweightKg: calculated.overweightTotalKg,
      pricePerKg: pricePeriod.pricePerKg,
    });

    return {
      week,
      product,
      sector,
      line,
      equipment,
      shift,
      pricePeriod,
      weightConfig,
      calculated,
      costs,
      status: overweightStatus,
    };
  }

  private async upsertOrder(
    input: ProductionEntryInput,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    const key = {
      weekId_orderNumber_productId: {
        weekId: input.weekId,
        orderNumber: input.productionOrder,
        productId: input.productId,
      },
    };
    const current = await client.productionOrder.findUnique({ where: key });
    if (current && !current.deletedAt && current.sectorCode !== input.sector) {
      throw new BadRequestException(
        "Ordem de producao ja esta vinculada a outro setor.",
      );
    }
    const order = await client.productionOrder.upsert({
      where: {
        ...key,
      },
      create: {
        weekId: input.weekId,
        productId: input.productId,
        sectorCode: input.sector,
        orderNumber: input.productionOrder,
      },
      update: {
        status: "OPEN",
        sectorCode: current?.deletedAt ? input.sector : undefined,
        deletedAt: null,
      },
    });
    if (order.sectorCode !== input.sector) {
      throw new BadRequestException(
        "Ordem de producao ja esta vinculada a outro setor.",
      );
    }
    return order;
  }

  private async workflowRecord(id: string, action: string) {
    const current = await this.prisma.productionEntry.findUnique({
      where: { id },
      include: { week: true },
    });
    if (!current || current.deletedAt)
      throw new NotFoundException("Lancamento nao encontrado.");
    if (current.week.deletedAt)
      throw new BadRequestException(`Semana removida nao permite ${action}.`);
    assertWeekWritable(
      current.week,
      `Semana fechada ou arquivada nao permite ${action}.`,
    );
    assertDateWithinWeek(
      current.date,
      current.week,
      "Data do lancamento precisa pertencer ao periodo da semana selecionada.",
    );
    return current;
  }

  private async updateWithVersion(
    id: string,
    version: number,
    data: Prisma.ProductionEntryUncheckedUpdateInput,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    try {
      return await client.productionEntry.update({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
        include: {
          week: true,
          product: true,
          sector: true,
          line: true,
          equipment: true,
          shift: true,
          order: true,
          pricePeriod: true,
        },
      });
    } catch (error) {
      throwOptimisticConflict(error);
    }
  }

  private requireActorId(user?: CurrentUser) {
    const userId = this.safeUserId(user);
    if (!userId)
      throw new BadRequestException(
        "Usuario autenticado invalido para esta operacao.",
      );
    return userId;
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
