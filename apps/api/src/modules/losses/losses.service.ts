import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { lossEntrySchema } from "../../domain/validators/schemas";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { calculatePackagingLoss } from "../../domain/calculations/financial-calculations";
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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lossEntryUpdateSchema = lossEntrySchema
  .partial()
  .extend({
    sector: z.enum(["P1", "P2"]).nullable().optional(),
    productId: z.string().uuid().nullable().optional(),
    productionOrderId: z.string().uuid().nullable().optional(),
    equipmentId: z.string().uuid().nullable().optional(),
    shiftId: z.string().uuid().nullable().optional(),
    reason: z.string().max(240).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    version: recordVersionSchema,
    changeReason: workflowReasonSchema.optional()
  })
  .strict()
  .refine(({ version: _version, changeReason: _changeReason, ...changes }) => Object.keys(changes).length > 0, {
    message: "Informe ao menos um campo para atualizar."
  });

type LossEntryInput = z.infer<typeof lossEntrySchema>;

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
      where: {
        deletedAt: null,
        weekId: query.weekId,
        lossTypeId: query.typeId
      },
      include: {
        lossType: true,
        product: true,
        sector: true,
        week: true,
        equipment: true,
        shift: true,
        pricePeriod: true
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  async getById(id: string) {
    const entry = await this.prisma.lossEntry.findFirst({
      where: { id, deletedAt: null },
      include: {
        lossType: true,
        product: true,
        sector: true,
        week: true,
        productionOrder: true,
        equipment: true,
        shift: true,
        pricePeriod: true
      }
    });
    if (!entry) throw new NotFoundException("Perda nao encontrada.");
    return entry;
  }

  types() {
    return this.prisma.lossType.findMany({
      where: { active: true },
      orderBy: { name: "asc" }
    });
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = lossEntrySchema.parse(payload);
    const userId = this.safeUserId(user);
    return this.prisma.$transaction(
      async (transaction) => {
        const resolved = await this.resolveEntry(input, undefined, transaction);
        const loss = await transaction.lossEntry.create({
          data: {
            weekId: input.weekId,
            date: input.date,
            sectorId: resolved.sector?.id,
            productId: input.productId,
            pricePeriodId: resolved.pricePeriod?.id,
            priceVersion: resolved.pricePeriod?.version,
            priceOrigin: resolved.pricePeriod?.origin,
            priceCurrency: resolved.pricePeriod?.currency,
            productionOrderId: input.productionOrderId,
            equipmentId: resolved.equipment?.id,
            shiftId: resolved.shift?.id,
            lossTypeId: input.lossTypeId,
            quantityKg: input.quantityKg,
            filmShift1Kg: input.filmShift1Kg,
            filmShift2Kg: input.filmShift2Kg,
            boxLossUnits: input.boxLossUnits,
            boxLossShift1Units: input.boxLossShift1Units,
            boxLossShift2Units: input.boxLossShift2Units,
            unitCost: resolved.unitCost,
            lossCost: resolved.financial.lossCost,
            packedBoxes: input.packedBoxes,
            packageFilmWeightG: resolved.packageFilmWeightG,
            filmCostPerKg: resolved.filmCostPerKg,
            filmUsedKg: resolved.isPackaging ? resolved.financial.filmUsedKg : 0,
            filmUsedValue: resolved.isPackaging ? resolved.financial.filmUsedValue : 0,
            financialResult: resolved.isPackaging ? resolved.financial.financialResult : resolved.financial.lossOnlyFinancialResult,
            calculationRuleVersions: {
              ...(resolved.isPackaging ? resolved.financial.calculationRuleVersions : resolved.financial.lossOnlyCalculationRuleVersions)
            },
            workflowStatus: "DRAFT",
            reason: input.reason,
            notes: input.notes,
            createdBy: userId,
            updatedBy: userId
          },
          include: {
            lossType: true,
            product: true,
            sector: true,
            week: true,
            productionOrder: true,
            equipment: true,
            shift: true,
            pricePeriod: true
          }
        });
        await this.audit.record(
          {
            userId,
            module: "losses",
            action: "create",
            entity: "LossEntry",
            entityId: loss.id,
            after: loss
          },
          transaction
        );
        return loss;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const patch = lossEntryUpdateSchema.parse(payload);
    return this.prisma.$transaction(
      async (transaction) => {
        await this.lockLossEntry(transaction, id);
        const current = await transaction.lossEntry.findUnique({
          where: { id },
          include: {
            lossType: true,
            product: true,
            sector: true,
            week: true,
            productionOrder: true,
            equipment: true,
            shift: true,
            pricePeriod: true
          }
        });
        if (!current || current.deletedAt) throw new NotFoundException("Perda nao encontrada.");
        if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite edicao.");
        assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite edicao de perdas.");
        assertCurrentVersion(current.version, patch.version);
        assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED", "APPROVED"], "edicao");
        assertCanAmendApproved(current.workflowStatus, user?.roles);
        if (current.workflowStatus === "APPROVED" && !patch.changeReason) {
          throw new BadRequestException("Alteracao de perda aprovada exige motivo.");
        }

        const input = lossEntrySchema.parse({
          weekId: patch.weekId ?? current.weekId,
          date: patch.date ?? current.date,
          sector: Object.prototype.hasOwnProperty.call(patch, "sector") ? (patch.sector ?? undefined) : current.sector?.code,
          productId: Object.prototype.hasOwnProperty.call(patch, "productId") ? (patch.productId ?? undefined) : (current.productId ?? undefined),
          productionOrderId: Object.prototype.hasOwnProperty.call(patch, "productionOrderId") ? (patch.productionOrderId ?? undefined) : (current.productionOrderId ?? undefined),
          equipmentId: Object.prototype.hasOwnProperty.call(patch, "equipmentId") ? (patch.equipmentId ?? undefined) : (current.equipmentId ?? undefined),
          shiftId: Object.prototype.hasOwnProperty.call(patch, "shiftId") ? (patch.shiftId ?? undefined) : (current.shiftId ?? undefined),
          lossTypeId: patch.lossTypeId ?? current.lossTypeId,
          quantityKg: patch.quantityKg ?? current.quantityKg,
          filmShift1Kg: patch.filmShift1Kg ?? current.filmShift1Kg ?? undefined,
          filmShift2Kg: patch.filmShift2Kg ?? current.filmShift2Kg ?? undefined,
          boxLossUnits: patch.boxLossUnits ?? current.boxLossUnits ?? undefined,
          boxLossShift1Units: patch.boxLossShift1Units ?? current.boxLossShift1Units ?? undefined,
          boxLossShift2Units: patch.boxLossShift2Units ?? current.boxLossShift2Units ?? undefined,
          packedBoxes: patch.packedBoxes ?? current.packedBoxes,
          reason: Object.prototype.hasOwnProperty.call(patch, "reason") ? (patch.reason ?? undefined) : (current.reason ?? undefined),
          notes: Object.prototype.hasOwnProperty.call(patch, "notes") ? (patch.notes ?? undefined) : (current.notes ?? undefined)
        });
        const resolved = await this.resolveEntry(
          input,
          {
            lossTypeId: current.lossTypeId,
            productId: current.productId,
            equipmentId: current.equipmentId,
            shiftId: current.shiftId
          },
          transaction
        );
        const userId = this.safeUserId(user);
        const loss = await this.updateWithVersion(
          id,
          patch.version,
          {
            weekId: input.weekId,
            date: input.date,
            sectorId: resolved.sector?.id ?? null,
            productId: input.productId ?? null,
            pricePeriodId: resolved.pricePeriod?.id ?? null,
            priceVersion: resolved.pricePeriod?.version ?? null,
            priceOrigin: resolved.pricePeriod?.origin ?? null,
            priceCurrency: resolved.pricePeriod?.currency ?? null,
            productionOrderId: input.productionOrderId ?? null,
            equipmentId: resolved.equipment?.id ?? null,
            shiftId: resolved.shift?.id ?? null,
            lossTypeId: input.lossTypeId,
            quantityKg: input.quantityKg,
            filmShift1Kg: input.filmShift1Kg,
            filmShift2Kg: input.filmShift2Kg,
            boxLossUnits: input.boxLossUnits,
            boxLossShift1Units: input.boxLossShift1Units,
            boxLossShift2Units: input.boxLossShift2Units,
            unitCost: resolved.unitCost,
            lossCost: resolved.financial.lossCost,
            packedBoxes: input.packedBoxes,
            packageFilmWeightG: resolved.packageFilmWeightG,
            filmCostPerKg: resolved.filmCostPerKg,
            filmUsedKg: resolved.isPackaging ? resolved.financial.filmUsedKg : 0,
            filmUsedValue: resolved.isPackaging ? resolved.financial.filmUsedValue : 0,
            financialResult: resolved.isPackaging ? resolved.financial.financialResult : resolved.financial.lossOnlyFinancialResult,
            calculationRuleVersions: {
              ...(resolved.isPackaging ? resolved.financial.calculationRuleVersions : resolved.financial.lossOnlyCalculationRuleVersions)
            },
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
            reason: input.reason ?? null,
            notes: input.notes ?? null,
            updatedBy: userId
          },
          transaction
        );
        await this.audit.record(
          {
            userId,
            module: "losses",
            action: "update",
            entity: "LossEntry",
            entityId: id,
            before: current,
            after: loss,
            reason: patch.changeReason
          },
          transaction
        );
        return loss;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async softDelete(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.prisma.$transaction(
      async (transaction) => {
        await this.lockLossEntry(transaction, id);
        const current = await transaction.lossEntry.findUnique({
          where: { id },
          include: { week: true }
        });
        if (!current || current.deletedAt) throw new NotFoundException("Perda nao encontrada.");
        if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite exclusao.");
        assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite exclusao de perdas.");
        assertCurrentVersion(current.version, command.version);
        assertWorkflowState(current.workflowStatus, ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"], "exclusao");
        const loss = await this.updateWithVersion(
          id,
          command.version,
          {
            deletedAt: new Date(),
            workflowStatus: "CANCELLED",
            updatedBy: userId
          },
          transaction
        );
        await this.audit.record(
          {
            userId,
            module: "losses",
            action: "delete",
            entity: "LossEntry",
            entityId: id,
            before: current,
            after: loss,
            reason: command.reason
          },
          transaction
        );
        return loss;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async restore(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.prisma.$transaction(
      async (transaction) => {
        await this.lockLossEntry(transaction, id);
        const current = await transaction.lossEntry.findUnique({
          where: { id },
          include: { week: true }
        });
        if (!current || !current.deletedAt) throw new NotFoundException("Perda excluida nao encontrada.");
        if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite restauracao.");
        assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite restauracao de perdas.");
        assertDateWithinWeek(current.date, current.week, "Data da perda precisa pertencer ao periodo da semana selecionada.");
        assertCurrentVersion(current.version, command.version);
        const loss = await this.updateWithVersion(
          id,
          command.version,
          {
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
          },
          transaction
        );
        await this.audit.record(
          {
            userId,
            module: "losses",
            action: "restore",
            entity: "LossEntry",
            entityId: id,
            before: current,
            after: loss,
            reason: command.reason
          },
          transaction
        );
        return loss;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async submit(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.prisma.$transaction(
      async (transaction) => {
        const current = await this.workflowRecord(id, "submissao", transaction);
        assertCurrentVersion(current.version, command.version);
        assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED"], "submissao");
        const loss = await this.updateWithVersion(
          id,
          command.version,
          {
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
          },
          transaction
        );
        await this.audit.record(
          {
            userId,
            module: "losses",
            action: "submit",
            entity: "LossEntry",
            entityId: id,
            before: current,
            after: loss,
            reason: command.reason
          },
          transaction
        );
        return loss;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async approve(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.prisma.$transaction(
      async (transaction) => {
        const current = await this.workflowRecord(id, "aprovacao", transaction);
        assertCurrentVersion(current.version, command.version);
        assertWorkflowState(current.workflowStatus, ["SUBMITTED", "UNDER_REVIEW"], "aprovacao");
        assertIndependentApprover(current.submittedBy, userId);
        const loss = await this.updateWithVersion(
          id,
          command.version,
          {
            workflowStatus: "APPROVED",
            approvedAt: new Date(),
            approvedBy: userId,
            approvalReason: command.reason ?? null,
            rejectedAt: null,
            rejectedBy: null,
            rejectionReason: null,
            updatedBy: userId
          },
          transaction
        );
        await this.audit.record(
          {
            userId,
            module: "losses",
            action: "approve",
            entity: "LossEntry",
            entityId: id,
            before: current,
            after: loss,
            reason: command.reason
          },
          transaction
        );
        return loss;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async reject(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.prisma.$transaction(
      async (transaction) => {
        const current = await this.workflowRecord(id, "rejeicao", transaction);
        assertCurrentVersion(current.version, command.version);
        assertWorkflowState(current.workflowStatus, ["SUBMITTED", "UNDER_REVIEW"], "rejeicao");
        const loss = await this.updateWithVersion(
          id,
          command.version,
          {
            workflowStatus: "REJECTED",
            rejectedAt: new Date(),
            rejectedBy: userId,
            rejectionReason: command.reason,
            approvedAt: null,
            approvedBy: null,
            approvalReason: null,
            updatedBy: userId
          },
          transaction
        );
        await this.audit.record(
          {
            userId,
            module: "losses",
            action: "reject",
            entity: "LossEntry",
            entityId: id,
            before: current,
            after: loss,
            reason: command.reason
          },
          transaction
        );
        return loss;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async summary(weekId?: string) {
    const rows = await this.prisma.lossEntry.groupBy({
      by: ["lossTypeId"],
      where: { deletedAt: null, workflowStatus: "APPROVED", weekId },
      _sum: { quantityKg: true }
    });
    const types = await this.prisma.lossType.findMany();
    return rows.map((row) => {
      const type = types.find((item) => item.id === row.lossTypeId);
      return {
        type: type?.name ?? row.lossTypeId,
        quantityKg: Number(row._sum.quantityKg ?? 0)
      };
    });
  }

  private async resolveEntry(
    input: LossEntryInput,
    existing:
      | {
          lossTypeId: string;
          productId: string | null;
          equipmentId: string | null;
          shiftId: string | null;
        }
      | undefined,
    client: Prisma.TransactionClient | PrismaService
  ) {
    this.assertMeasurementDimensions(input);
    const week = await client.weeklyPeriod.findUnique({
      where: { id: input.weekId }
    });
    if (!week || week.deletedAt) throw new NotFoundException("Semana nao encontrada.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita alteracoes em perdas.");
    assertDateWithinWeek(input.date, week, "Data da perda precisa pertencer ao periodo da semana selecionada.");

    const [lossType, product, requestedSector, productionOrder, equipment, shift] = await Promise.all([
      client.lossType.findUnique({ where: { id: input.lossTypeId } }),
      input.productId
        ? client.product.findUnique({
            where: { id: input.productId },
            include: { weightConfig: true }
          })
        : Promise.resolve(null),
      input.sector ? client.sector.findUnique({ where: { code: input.sector } }) : Promise.resolve(null),
      input.productionOrderId
        ? client.productionOrder.findUnique({
            where: { id: input.productionOrderId }
          })
        : Promise.resolve(null),
      input.equipmentId
        ? client.equipment.findUnique({
            where: { id: input.equipmentId },
            include: { productionLine: { include: { sector: true } } }
          })
        : Promise.resolve(null),
      input.shiftId ? client.shift.findUnique({ where: { id: input.shiftId } }) : Promise.resolve(null)
    ]);
    const sector = requestedSector ?? equipment?.productionLine.sector ?? null;
    if (!lossType) throw new NotFoundException("Tipo de perda nao encontrado.");
    if (!lossType.active && lossType.id !== existing?.lossTypeId) {
      throw new BadRequestException("Tipo de perda inativo nao pode ser usado no lancamento.");
    }
    if (!input.productId) {
      throw new BadRequestException("Produto e obrigatorio para aplicar preco aprovado e impedir custo presumido como zero.");
    }
    if (!product || product.deletedAt) throw new NotFoundException("Produto nao encontrado.");
    if (product && !product.active && product.id !== existing?.productId) {
      throw new BadRequestException("Produto inativo nao pode ser usado na perda.");
    }
    if (input.sector && !sector) throw new NotFoundException("Setor nao encontrado.");
    if (input.equipmentId && (!equipment || equipment.deletedAt || equipment.productionLine.deletedAt)) throw new NotFoundException("Equipamento nao encontrado.");
    if (equipment && (!equipment.active || !equipment.productionLine.active) && equipment.id !== existing?.equipmentId) {
      throw new BadRequestException("Equipamento ou linha inativa nao pode ser usada na perda.");
    }
    if (equipment && input.sector && equipment.productionLine.sector.code !== input.sector) {
      throw new BadRequestException("Equipamento nao pertence ao setor informado.");
    }
    if (input.shiftId && (!shift || shift.deletedAt)) throw new NotFoundException("Turno nao encontrado.");
    if (shift && !shift.active && shift.id !== existing?.shiftId) throw new BadRequestException("Turno inativo nao pode ser usado na perda.");
    if (input.productionOrderId && (!productionOrder || productionOrder.deletedAt)) {
      throw new NotFoundException("Ordem de producao nao encontrada.");
    }
    if (productionOrder?.weekId !== undefined && productionOrder.weekId !== input.weekId) {
      throw new BadRequestException("Ordem de producao precisa pertencer a semana da perda.");
    }
    if (productionOrder && input.productId && productionOrder.productId !== input.productId) {
      throw new BadRequestException("Ordem de producao nao pertence ao produto informado.");
    }
    if (productionOrder && input.sector && productionOrder.sectorCode !== input.sector) {
      throw new BadRequestException("Ordem de producao nao pertence ao setor informado.");
    }

    const pricePeriod = product
      ? await client.productPricePeriod.findFirst({
          where: {
            productId: product.id,
            status: "APPROVED",
            startsOn: { lte: dateOnly(input.date) },
            OR: [{ endsOn: null }, { endsOn: { gte: dateOnly(input.date) } }]
          },
          orderBy: [{ startsOn: "desc" }, { version: "desc" }]
        })
      : null;
    if (product && !pricePeriod) {
      throw new BadRequestException("Produto sem preco aprovado vigente na data da perda.");
    }
    const isPackaging = lossType.code === "PACKAGING";
    const unitCost = isPackaging ? (pricePeriod?.filmCostPerKg ?? 0) : (pricePeriod?.pricePerKg ?? 0);
    if (Number(unitCost) <= 0) {
      throw new BadRequestException(
        isPackaging ? "Preco aprovado vigente nao possui custo de filme positivo para esta perda." : "Preco aprovado vigente nao possui custo unitario positivo para esta perda."
      );
    }
    const packageFilmWeightG = product?.packageFilmWeightG ?? 0;
    const filmCostPerKg = pricePeriod?.filmCostPerKg ?? 0;
    const financial = calculatePackagingLoss({
      quantityKg: input.quantityKg,
      unitCost,
      packedBoxes: input.packedBoxes,
      packagesPerBox: product?.weightConfig?.packagesPerBox ?? 0,
      packageFilmWeightG,
      filmCostPerKg
    });

    return {
      week,
      lossType,
      product,
      sector,
      productionOrder,
      equipment,
      shift,
      pricePeriod,
      isPackaging,
      unitCost,
      packageFilmWeightG,
      filmCostPerKg,
      financial
    };
  }

  private async workflowRecord(id: string, action: string, client: Prisma.TransactionClient) {
    await this.lockLossEntry(client, id);
    const current = await client.lossEntry.findUnique({
      where: { id },
      include: { week: true }
    });
    if (!current || current.deletedAt) throw new NotFoundException("Perda nao encontrada.");
    if (current.week.deletedAt) throw new BadRequestException(`Semana removida nao permite ${action}.`);
    assertWeekWritable(current.week, `Semana fechada ou arquivada nao permite ${action}.`);
    assertDateWithinWeek(current.date, current.week, "Data da perda precisa pertencer ao periodo da semana selecionada.");
    return current;
  }

  private async updateWithVersion(id: string, version: number, data: Prisma.LossEntryUncheckedUpdateInput, client: Prisma.TransactionClient) {
    try {
      return await client.lossEntry.update({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
        include: {
          lossType: true,
          product: true,
          sector: true,
          week: true,
          productionOrder: true,
          equipment: true,
          shift: true,
          pricePeriod: true
        }
      });
    } catch (error) {
      throwOptimisticConflict(error);
    }
  }

  private async lockLossEntry(client: Prisma.TransactionClient, id: string) {
    await client.$queryRaw(Prisma.sql`
      SELECT "id"
        FROM "loss_entries"
       WHERE "id" = CAST(${id} AS uuid)
       FOR UPDATE
    `);
  }

  private requireActorId(user?: CurrentUser) {
    const userId = this.safeUserId(user);
    if (!userId) throw new BadRequestException("Usuario autenticado invalido para esta operacao.");
    return userId;
  }

  private assertMeasurementDimensions(input: LossEntryInput) {
    const hasFilmBreakdown = input.filmShift1Kg !== undefined || input.filmShift2Kg !== undefined;
    if (hasFilmBreakdown) {
      if (input.filmShift1Kg === undefined || input.filmShift2Kg === undefined) {
        throw new BadRequestException("Informe filme T1 e T2 juntos; ausente nao equivale a zero.");
      }
      if (Math.abs(input.quantityKg - (input.filmShift1Kg + input.filmShift2Kg)) > 0.001) {
        throw new BadRequestException("Total de filme em kg deve conferir com T1 + T2.");
      }
    }
    const hasBoxBreakdown = input.boxLossUnits !== undefined || input.boxLossShift1Units !== undefined || input.boxLossShift2Units !== undefined;
    if (hasBoxBreakdown) {
      if (input.boxLossUnits === undefined || input.boxLossShift1Units === undefined || input.boxLossShift2Units === undefined) {
        throw new BadRequestException("Informe total de caixas, T1 e T2 juntos; ausente nao equivale a zero.");
      }
      if (Math.abs(input.boxLossUnits - (input.boxLossShift1Units + input.boxLossShift2Units)) > 0.001) {
        throw new BadRequestException("Total de caixas em unidades deve conferir com T1 + T2.");
      }
    }
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
