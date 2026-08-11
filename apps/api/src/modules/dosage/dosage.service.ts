import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { calculateDosage } from "../../domain/calculations/dosage-calculations";
import { dosageCheckSchema } from "../../domain/validators/schemas";
import { assertDateWithinWeek, assertWeekWritable } from "../../domain/weeks/week-rules";
import {
  assertCanAmendApproved,
  assertCurrentVersion,
  assertIndependentApprover,
  assertWorkflowState,
  recordVersionSchema,
  throwOptimisticConflict,
  versionedOptionalReasonCommandSchema,
  versionedReasonCommandSchema,
  workflowReasonSchema
} from "../../domain/workflow/workflow-rules";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";
import { assertReviewRequiredCalculationRulesApproved } from "../calculation-rules/calculation-rules.service";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dosageUpdateSchema = dosageCheckSchema
  .partial()
  .extend({
    equipmentId: z.string().uuid().nullable().optional(),
    shiftId: z.string().uuid().nullable().optional(),
    operatorId: z.string().uuid().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    version: recordVersionSchema,
    changeReason: workflowReasonSchema.optional()
  })
  .strict()
  .refine(({ version: _version, changeReason: _changeReason, ...changes }) => Object.keys(changes).length > 0, {
    message: "Informe ao menos um campo para atualizar."
  });

type DosageInput = z.infer<typeof dosageCheckSchema>;

const dosageInclude = {
  product: { select: { code: true, name: true } },
  week: { select: { id: true, label: true, startsOn: true, endsOn: true, status: true, deletedAt: true } },
  equipment: true,
  shift: true
} satisfies Prisma.DosageCheckInclude;

@Injectable()
export class DosageService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(weekId?: string, productId?: string) {
    return this.prisma.dosageCheck.findMany({
      where: { deletedAt: null, weekId, productId },
      include: dosageInclude,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  async getById(id: string) {
    const row = await this.prisma.dosageCheck.findFirst({ where: { id, deletedAt: null }, include: dosageInclude });
    if (!row) throw new NotFoundException("Controle de dosagem nao encontrado.");
    return row;
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = dosageCheckSchema.parse(payload);
    const userId = this.safeUserId(user);
    return this.writeTransaction(async (transaction) => {
      const resolved = await this.resolveInput(transaction, input);
      const row = await transaction.dosageCheck.create({
        data: {
          weekId: input.weekId,
          productId: input.productId,
          sectorCode: input.sector,
          equipmentId: resolved.equipment?.id,
          shiftId: resolved.shift?.id,
          operatorId: resolved.operator?.id,
          date: input.date,
          targetWeightG: resolved.targetWeightG,
          sampleWeightsG: input.sampleWeightsG,
          sampleCount: resolved.calculated.sampleCount,
          averageWeightG: resolved.calculated.averageWeightG,
          standardDeviationG: resolved.calculated.standardDeviationG,
          overweightG: resolved.calculated.overweightG,
          calculationRuleVersions: { ...resolved.calculated.calculationRuleVersions },
          workflowStatus: "DRAFT",
          notes: input.notes,
          createdBy: userId,
          updatedBy: userId
        },
        include: dosageInclude
      });
      await this.audit.record(
        { userId, module: "dosage", action: "create", entity: "DosageCheck", entityId: row.id, after: row },
        transaction
      );
      return row;
    });
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const patch = dosageUpdateSchema.parse(payload);
    return this.writeTransaction(async (transaction) => {
      await this.lock(transaction, id);
      const current = await transaction.dosageCheck.findUnique({ where: { id }, include: dosageInclude });
      if (!current || current.deletedAt) throw new NotFoundException("Controle de dosagem nao encontrado.");
      if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite edicao da dosagem.");
      assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite edicao da dosagem.");
      assertCurrentVersion(current.version, patch.version);
      assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED", "APPROVED"], "edicao");
      assertCanAmendApproved(current.workflowStatus, user?.roles);
      if (current.workflowStatus === "APPROVED" && !patch.changeReason) {
        throw new BadRequestException("Alteracao de dosagem aprovada exige motivo.");
      }
      const input = dosageCheckSchema.parse({
        weekId: patch.weekId ?? current.weekId,
        productId: patch.productId ?? current.productId,
        sector: patch.sector ?? current.sectorCode,
        equipmentId: Object.prototype.hasOwnProperty.call(patch, "equipmentId") ? (patch.equipmentId ?? undefined) : (current.equipmentId ?? undefined),
        shiftId: Object.prototype.hasOwnProperty.call(patch, "shiftId") ? (patch.shiftId ?? undefined) : (current.shiftId ?? undefined),
        operatorId: Object.prototype.hasOwnProperty.call(patch, "operatorId") ? (patch.operatorId ?? undefined) : (current.operatorId ?? undefined),
        date: patch.date ?? current.date,
        sampleWeightsG: patch.sampleWeightsG ?? current.sampleWeightsG,
        notes: Object.prototype.hasOwnProperty.call(patch, "notes") ? (patch.notes ?? undefined) : (current.notes ?? undefined)
      });
      const resolved = await this.resolveInput(transaction, input, {
        productId: current.productId,
        equipmentId: current.equipmentId,
        shiftId: current.shiftId,
        operatorId: current.operatorId
      });
      const userId = this.safeUserId(user);
      const row = await this.updateWithVersion(transaction, id, patch.version, {
        weekId: input.weekId,
        productId: input.productId,
        sectorCode: input.sector,
        equipmentId: resolved.equipment?.id ?? null,
        shiftId: resolved.shift?.id ?? null,
        operatorId: resolved.operator?.id ?? null,
        date: input.date,
        targetWeightG: resolved.targetWeightG,
        sampleWeightsG: input.sampleWeightsG,
        sampleCount: resolved.calculated.sampleCount,
        averageWeightG: resolved.calculated.averageWeightG,
        standardDeviationG: resolved.calculated.standardDeviationG,
        overweightG: resolved.calculated.overweightG,
        calculationRuleVersions: { ...resolved.calculated.calculationRuleVersions },
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
        notes: input.notes ?? null,
        updatedBy: userId
      });
      await this.audit.record(
        { userId, module: "dosage", action: "update", entity: "DosageCheck", entityId: id, before: current, after: row, reason: patch.changeReason },
        transaction
      );
      return row;
    });
  }

  async softDelete(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.writeTransaction(async (transaction) => {
      const current = await this.workflowRecord(transaction, id, "exclusao");
      assertCurrentVersion(current.version, command.version);
      assertWorkflowState(current.workflowStatus, ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"], "exclusao");
      const row = await this.updateWithVersion(transaction, id, command.version, {
        deletedAt: new Date(),
        workflowStatus: "CANCELLED",
        updatedBy: userId
      });
      await this.audit.record(
        { userId, module: "dosage", action: "delete", entity: "DosageCheck", entityId: id, before: current, after: row, reason: command.reason },
        transaction
      );
      return row;
    });
  }

  async restore(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.writeTransaction(async (transaction) => {
      await this.lock(transaction, id);
      const current = await transaction.dosageCheck.findUnique({ where: { id }, include: dosageInclude });
      if (!current || !current.deletedAt) throw new NotFoundException("Controle de dosagem excluido nao encontrado.");
      if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite restauracao da dosagem.");
      assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite restauracao da dosagem.");
      assertDateWithinWeek(current.date, current.week, "Data da amostra precisa pertencer a semana selecionada.");
      assertCurrentVersion(current.version, command.version);
      const row = await this.updateWithVersion(transaction, id, command.version, {
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
      await this.audit.record(
        { userId, module: "dosage", action: "restore", entity: "DosageCheck", entityId: id, before: current, after: row, reason: command.reason },
        transaction
      );
      return row;
    });
  }

  async submit(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.transition(id, command.version, "submit", command.reason, userId);
  }

  async approve(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.transition(id, command.version, "approve", command.reason, userId);
  }

  async reject(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.transition(id, command.version, "reject", command.reason, userId);
  }

  private async transition(id: string, version: number, action: "submit" | "approve" | "reject", reason: string | undefined, userId: string) {
    return this.writeTransaction(async (transaction) => {
      const current = await this.workflowRecord(transaction, id, action);
      assertCurrentVersion(current.version, version);
      if (action === "submit") assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED"], "submissao");
      else assertWorkflowState(current.workflowStatus, ["SUBMITTED", "UNDER_REVIEW"], action === "approve" ? "aprovacao" : "rejeicao");
      if (action === "approve") assertIndependentApprover(current.submittedBy, userId);
      if (action === "approve") {
        await assertReviewRequiredCalculationRulesApproved(transaction, current.calculationRuleVersions);
      }
      const now = new Date();
      const data: Prisma.DosageCheckUncheckedUpdateInput = action === "submit"
        ? {
            workflowStatus: "SUBMITTED", submittedAt: now, submittedBy: userId, submissionReason: reason ?? null,
            approvedAt: null, approvedBy: null, approvalReason: null, rejectedAt: null, rejectedBy: null, rejectionReason: null, updatedBy: userId
          }
        : action === "approve"
          ? { workflowStatus: "APPROVED", approvedAt: now, approvedBy: userId, approvalReason: reason ?? null, rejectedAt: null, rejectedBy: null, rejectionReason: null, updatedBy: userId }
          : { workflowStatus: "REJECTED", rejectedAt: now, rejectedBy: userId, rejectionReason: reason, approvedAt: null, approvedBy: null, approvalReason: null, updatedBy: userId };
      const row = await this.updateWithVersion(transaction, id, version, data);
      await this.audit.record(
        { userId, module: "dosage", action, entity: "DosageCheck", entityId: id, before: current, after: row, reason },
        transaction
      );
      return row;
    });
  }

  private async resolveInput(
    transaction: Prisma.TransactionClient,
    input: DosageInput,
    existing?: { productId: string; equipmentId: string | null; shiftId: string | null; operatorId: string | null }
  ) {
    const [week, product, equipment, shift, operator] = await Promise.all([
      transaction.weeklyPeriod.findUnique({ where: { id: input.weekId } }),
      transaction.product.findUnique({ where: { id: input.productId }, include: { weightConfig: true } }),
      input.equipmentId
        ? transaction.equipment.findUnique({ where: { id: input.equipmentId }, include: { productionLine: { include: { sector: true } } } })
        : Promise.resolve(null),
      input.shiftId ? transaction.shift.findUnique({ where: { id: input.shiftId } }) : Promise.resolve(null),
      input.operatorId ? transaction.user.findUnique({ where: { id: input.operatorId } }) : Promise.resolve(null)
    ]);
    if (!week || week.deletedAt) throw new NotFoundException("Semana nao encontrada.");
    if (!product || product.deletedAt || !product.weightConfig) throw new NotFoundException("Produto ou configuracao de peso nao encontrado.");
    if (product.active === false && product.id !== existing?.productId) throw new BadRequestException("Produto inativo nao pode ser usado na dosagem.");
    if (input.equipmentId && (!equipment || equipment.deletedAt || equipment.productionLine.deletedAt)) throw new NotFoundException("Equipamento nao encontrado.");
    if (equipment && (!equipment.active || !equipment.productionLine.active) && equipment.id !== existing?.equipmentId) {
      throw new BadRequestException("Equipamento ou linha inativa nao pode ser usada na dosagem.");
    }
    if (equipment && equipment.productionLine.sector.code !== input.sector) throw new BadRequestException("Equipamento nao pertence ao setor informado.");
    if (input.shiftId && (!shift || shift.deletedAt)) throw new NotFoundException("Turno nao encontrado.");
    if (shift && !shift.active && shift.id !== existing?.shiftId) throw new BadRequestException("Turno inativo nao pode ser usado na dosagem.");
    if (input.operatorId && (!operator || operator.deletedAt)) throw new NotFoundException("Operador nao encontrado.");
    if (operator && !operator.active && operator.id !== existing?.operatorId) throw new BadRequestException("Operador inativo nao pode ser usado na dosagem.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita amostras.");
    assertDateWithinWeek(input.date, week, "Data da amostra precisa pertencer a semana selecionada.");
    const targetWeightG = Number(product.weightConfig.targetPackageWeightG);
    return { week, product, equipment, shift, operator, targetWeightG, calculated: calculateDosage(input.sampleWeightsG, targetWeightG) };
  }

  private async workflowRecord(transaction: Prisma.TransactionClient, id: string, action: string) {
    await this.lock(transaction, id);
    const current = await transaction.dosageCheck.findUnique({ where: { id }, include: dosageInclude });
    if (!current || current.deletedAt) throw new NotFoundException("Controle de dosagem nao encontrado.");
    if (current.week.deletedAt) throw new BadRequestException(`Semana removida nao permite ${action}.`);
    assertWeekWritable(current.week, `Semana fechada ou arquivada nao permite ${action}.`);
    assertDateWithinWeek(current.date, current.week, "Data da amostra precisa pertencer a semana selecionada.");
    return current;
  }

  private async updateWithVersion(transaction: Prisma.TransactionClient, id: string, version: number, data: Prisma.DosageCheckUncheckedUpdateInput) {
    try {
      return await transaction.dosageCheck.update({ where: { id, version }, data: { ...data, version: { increment: 1 } }, include: dosageInclude });
    } catch (error) {
      throwOptimisticConflict(error);
    }
  }

  private async lock(transaction: Prisma.TransactionClient, id: string) {
    await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "dosage_checks" WHERE "id" = CAST(${id} AS uuid) FOR UPDATE`);
  }

  private writeTransaction<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
