import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  calculateAverageKgPerDay,
  calculateKgPerHour,
  PRODUCTIVITY_ENTRY_CALCULATION_RULE_VERSIONS,
  PRODUCTIVITY_SUMMARY_CALCULATION_RULE_VERSIONS
} from "../../domain/calculations/productivity-calculations";
import { uuidSchema } from "../../domain/validators/schemas";
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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const productivityEntrySchema = z.object({
  weekId: uuidSchema,
  sector: z.enum(["P1", "P2"]),
  equipmentId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  date: z.coerce.date(),
  producedKg: z.coerce.number().nonnegative(),
  productiveHours: z.coerce.number().positive(),
  notes: z.string().max(2000).optional()
}).strict();
const productivityUpdateSchema = productivityEntrySchema
  .partial()
  .extend({
    equipmentId: z.string().uuid().nullable().optional(),
    shiftId: z.string().uuid().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    version: recordVersionSchema,
    changeReason: workflowReasonSchema.optional()
  })
  .strict()
  .refine(({ version: _version, changeReason: _changeReason, ...changes }) => Object.keys(changes).length > 0, {
    message: "Informe ao menos um campo para atualizar."
  });

type ProductivityInput = z.infer<typeof productivityEntrySchema>;

const productivityInclude = {
  week: { select: { id: true, label: true, startsOn: true, endsOn: true, status: true, deletedAt: true } },
  equipment: true,
  shift: true
} satisfies Prisma.ProductivityEntryInclude;

@Injectable()
export class ProductivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  list(weekId?: string) {
    return this.prisma.productivityEntry.findMany({
      where: { weekId, deletedAt: null },
      include: productivityInclude,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  async getById(id: string) {
    const row = await this.prisma.productivityEntry.findFirst({ where: { id, deletedAt: null }, include: productivityInclude });
    if (!row) throw new NotFoundException("Apontamento de produtividade nao encontrado.");
    return row;
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = productivityEntrySchema.parse(payload);
    const userId = this.safeUserId(user);
    return this.writeTransaction(async (transaction) => {
      const resolved = await this.resolveInput(transaction, input);
      const row = await transaction.productivityEntry.create({
        data: {
          weekId: input.weekId,
          sectorCode: input.sector,
          equipmentId: resolved.equipment?.id,
          shiftId: resolved.shift?.id,
          date: input.date,
          producedKg: input.producedKg,
          productiveHours: input.productiveHours,
          kgPerHour: calculateKgPerHour(input.producedKg, input.productiveHours * 60),
          dataSource: "INFORMED_MANUALLY",
          calculationRuleVersions: { ...PRODUCTIVITY_ENTRY_CALCULATION_RULE_VERSIONS },
          workflowStatus: "DRAFT",
          notes: input.notes,
          createdBy: userId,
          updatedBy: userId
        },
        include: productivityInclude
      });
      await this.audit.record(
        { userId, module: "productivity", action: "create", entity: "ProductivityEntry", entityId: row.id, after: row },
        transaction
      );
      return row;
    });
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const patch = productivityUpdateSchema.parse(payload);
    return this.writeTransaction(async (transaction) => {
      await this.lock(transaction, id);
      const current = await transaction.productivityEntry.findUnique({ where: { id }, include: productivityInclude });
      if (!current || current.deletedAt) throw new NotFoundException("Apontamento de produtividade nao encontrado.");
      if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite edicao da produtividade.");
      assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite edicao da produtividade.");
      assertCurrentVersion(current.version, patch.version);
      assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED", "APPROVED"], "edicao");
      assertCanAmendApproved(current.workflowStatus, user?.roles);
      if (current.workflowStatus === "APPROVED" && !patch.changeReason) {
        throw new BadRequestException("Alteracao de produtividade aprovada exige motivo.");
      }
      const input = productivityEntrySchema.parse({
        weekId: patch.weekId ?? current.weekId,
        sector: patch.sector ?? current.sectorCode,
        equipmentId: Object.prototype.hasOwnProperty.call(patch, "equipmentId") ? (patch.equipmentId ?? undefined) : (current.equipmentId ?? undefined),
        shiftId: Object.prototype.hasOwnProperty.call(patch, "shiftId") ? (patch.shiftId ?? undefined) : (current.shiftId ?? undefined),
        date: patch.date ?? current.date,
        producedKg: patch.producedKg ?? current.producedKg,
        productiveHours: patch.productiveHours ?? current.productiveHours,
        notes: Object.prototype.hasOwnProperty.call(patch, "notes") ? (patch.notes ?? undefined) : (current.notes ?? undefined)
      });
      const resolved = await this.resolveInput(transaction, input, {
        equipmentId: current.equipmentId,
        shiftId: current.shiftId
      });
      const userId = this.safeUserId(user);
      const row = await this.updateWithVersion(transaction, id, patch.version, {
        weekId: input.weekId,
        sectorCode: input.sector,
        equipmentId: resolved.equipment?.id ?? null,
        shiftId: resolved.shift?.id ?? null,
        date: input.date,
        producedKg: input.producedKg,
        productiveHours: input.productiveHours,
        kgPerHour: calculateKgPerHour(input.producedKg, input.productiveHours * 60),
        dataSource: "INFORMED_MANUALLY",
        calculationRuleVersions: { ...PRODUCTIVITY_ENTRY_CALCULATION_RULE_VERSIONS },
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
        { userId, module: "productivity", action: "update", entity: "ProductivityEntry", entityId: id, before: current, after: row, reason: patch.changeReason },
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
      const row = await this.updateWithVersion(transaction, id, command.version, { deletedAt: new Date(), workflowStatus: "CANCELLED", updatedBy: userId });
      await this.audit.record(
        { userId, module: "productivity", action: "delete", entity: "ProductivityEntry", entityId: id, before: current, after: row, reason: command.reason },
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
      const current = await transaction.productivityEntry.findUnique({ where: { id }, include: productivityInclude });
      if (!current || !current.deletedAt) throw new NotFoundException("Apontamento de produtividade excluido nao encontrado.");
      if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite restauracao da produtividade.");
      assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite restauracao da produtividade.");
      assertDateWithinWeek(current.date, current.week, "Data da produtividade precisa pertencer a semana selecionada.");
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
        { userId, module: "productivity", action: "restore", entity: "ProductivityEntry", entityId: id, before: current, after: row, reason: command.reason },
        transaction
      );
      return row;
    });
  }

  async submit(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    return this.transition(id, command.version, "submit", command.reason, this.requireActorId(user));
  }

  async approve(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    return this.transition(id, command.version, "approve", command.reason, this.requireActorId(user));
  }

  async reject(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    return this.transition(id, command.version, "reject", command.reason, this.requireActorId(user));
  }

  async summary(weekId?: string) {
    const production = await this.prisma.productionEntry.aggregate({
      where: { deletedAt: null, workflowStatus: "APPROVED", weekId },
      _sum: { producedKg: true },
      _avg: { realYieldPercent: true },
      _count: true
    });
    const days = await this.prisma.productionEntry.groupBy({
      by: ["date"],
      where: { deletedAt: null, workflowStatus: "APPROVED", weekId },
      _sum: { producedKg: true },
      _avg: { realYieldPercent: true },
      orderBy: { date: "asc" }
    });
    const producedKg = Number(production._sum.producedKg ?? 0);
    return {
      source: "CALCULATED_FROM_APPROVED_PRODUCTION" as const,
      sourceDescription: "Calculado somente a partir de lancamentos de producao aprovados; apontamentos informados nao substituem estes indicadores.",
      producedKg,
      averageYield: Number(production._avg.realYieldPercent ?? 0),
      workedDays: days.length,
      averageKgPerDay: calculateAverageKgPerDay(producedKg, days.length),
      records: production._count,
      calculationRuleVersions: PRODUCTIVITY_SUMMARY_CALCULATION_RULE_VERSIONS,
      daily: days.map((day) => ({
        date: day.date,
        producedKg: Number(day._sum.producedKg ?? 0),
        averageYield: Number(day._avg.realYieldPercent ?? 0)
      }))
    };
  }

  private async transition(id: string, version: number, action: "submit" | "approve" | "reject", reason: string | undefined, userId: string) {
    return this.writeTransaction(async (transaction) => {
      const current = await this.workflowRecord(transaction, id, action);
      assertCurrentVersion(current.version, version);
      if (action === "submit") assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED"], "submissao");
      else assertWorkflowState(current.workflowStatus, ["SUBMITTED", "UNDER_REVIEW"], action === "approve" ? "aprovacao" : "rejeicao");
      if (action === "approve") assertIndependentApprover(current.submittedBy, userId);
      const now = new Date();
      const data: Prisma.ProductivityEntryUncheckedUpdateInput = action === "submit"
        ? {
            workflowStatus: "SUBMITTED", submittedAt: now, submittedBy: userId, submissionReason: reason ?? null,
            approvedAt: null, approvedBy: null, approvalReason: null, rejectedAt: null, rejectedBy: null, rejectionReason: null, updatedBy: userId
          }
        : action === "approve"
          ? { workflowStatus: "APPROVED", approvedAt: now, approvedBy: userId, approvalReason: reason ?? null, rejectedAt: null, rejectedBy: null, rejectionReason: null, updatedBy: userId }
          : { workflowStatus: "REJECTED", rejectedAt: now, rejectedBy: userId, rejectionReason: reason, approvedAt: null, approvedBy: null, approvalReason: null, updatedBy: userId };
      const row = await this.updateWithVersion(transaction, id, version, data);
      await this.audit.record(
        { userId, module: "productivity", action, entity: "ProductivityEntry", entityId: id, before: current, after: row, reason },
        transaction
      );
      return row;
    });
  }

  private async resolveInput(
    transaction: Prisma.TransactionClient,
    input: ProductivityInput,
    existing?: { equipmentId: string | null; shiftId: string | null }
  ) {
    const [week, sector, equipment, shift] = await Promise.all([
      transaction.weeklyPeriod.findUnique({ where: { id: input.weekId } }),
      transaction.sector.findUnique({ where: { code: input.sector } }),
      input.equipmentId
        ? transaction.equipment.findUnique({ where: { id: input.equipmentId }, include: { productionLine: { include: { sector: true } } } })
        : Promise.resolve(null),
      input.shiftId ? transaction.shift.findUnique({ where: { id: input.shiftId } }) : Promise.resolve(null)
    ]);
    if (!week || week.deletedAt) throw new NotFoundException("Semana nao encontrada.");
    if (!sector) throw new NotFoundException("Setor nao encontrado.");
    if (input.equipmentId && (!equipment || equipment.deletedAt || equipment.productionLine.deletedAt)) throw new NotFoundException("Equipamento nao encontrado.");
    if (equipment && (!equipment.active || !equipment.productionLine.active) && equipment.id !== existing?.equipmentId) {
      throw new BadRequestException("Equipamento ou linha inativa nao pode ser usado na produtividade.");
    }
    if (equipment && equipment.productionLine.sector.code !== input.sector) throw new BadRequestException("Equipamento nao pertence ao setor informado.");
    if (input.shiftId && (!shift || shift.deletedAt)) throw new NotFoundException("Turno nao encontrado.");
    if (shift && !shift.active && shift.id !== existing?.shiftId) throw new BadRequestException("Turno inativo nao pode ser usado na produtividade.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita apontamentos de produtividade.");
    assertDateWithinWeek(input.date, week, "Data da produtividade precisa pertencer a semana selecionada.");
    return { week, sector, equipment, shift };
  }

  private async workflowRecord(transaction: Prisma.TransactionClient, id: string, action: string) {
    await this.lock(transaction, id);
    const current = await transaction.productivityEntry.findUnique({ where: { id }, include: productivityInclude });
    if (!current || current.deletedAt) throw new NotFoundException("Apontamento de produtividade nao encontrado.");
    if (current.week.deletedAt) throw new BadRequestException(`Semana removida nao permite ${action}.`);
    assertWeekWritable(current.week, `Semana fechada ou arquivada nao permite ${action}.`);
    assertDateWithinWeek(current.date, current.week, "Data da produtividade precisa pertencer a semana selecionada.");
    return current;
  }

  private async updateWithVersion(transaction: Prisma.TransactionClient, id: string, version: number, data: Prisma.ProductivityEntryUncheckedUpdateInput) {
    try {
      return await transaction.productivityEntry.update({ where: { id, version }, data: { ...data, version: { increment: 1 } }, include: productivityInclude });
    } catch (error) {
      throwOptimisticConflict(error);
    }
  }

  private async lock(transaction: Prisma.TransactionClient, id: string) {
    await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "productivity_entries" WHERE "id" = CAST(${id} AS uuid) FOR UPDATE`);
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
