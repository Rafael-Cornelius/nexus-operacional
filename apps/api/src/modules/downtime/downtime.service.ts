import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { downtimeEntrySchema } from "../../domain/validators/schemas";
import { calculateDowntime } from "../../domain/calculations/downtime-calculations";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
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
const downtimeEntryUpdateSchema = downtimeEntrySchema
  .partial()
  .extend({
    lineId: z.string().uuid().nullable().optional(),
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
const downtimeCalculationNotes = new Set(["Termino da producao menor que inicio da producao.", "Termino da parada menor que inicio da parada.", "Tempo disponivel zerado."]);
const downtimeEquipmentOverlapConstraint = "downtime_entries_no_equipment_overlap";
const downtimeLineOverlapConstraint = "downtime_entries_no_line_overlap_without_equipment";

type DowntimeEntryInput = z.infer<typeof downtimeEntrySchema>;

function userNotes(value?: string | null) {
  const lines = (value ?? "").split("\n").filter((line) => line.trim() && !downtimeCalculationNotes.has(line.trim()));
  return lines.join("\n") || undefined;
}

function notesWithCalculations(value: string | undefined, inconsistencies: string[]) {
  return [userNotes(value), ...inconsistencies].filter(Boolean).join("\n") || undefined;
}

function databaseErrorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const candidate = error as { code?: unknown; message?: unknown; meta?: unknown; cause?: unknown };
  let meta = "";
  try {
    meta = JSON.stringify(candidate.meta ?? candidate.cause ?? "");
  } catch {
    meta = String(candidate.meta ?? candidate.cause ?? "");
  }
  return [candidate.code, candidate.message, meta].map((value) => String(value ?? "")).join(" ");
}

export function downtimeOverlapConstraint(error: unknown): "equipment" | "line" | "unknown" | null {
  const text = databaseErrorText(error);
  if (text.includes(downtimeEquipmentOverlapConstraint)) return "equipment";
  if (text.includes(downtimeLineOverlapConstraint)) return "line";
  if (/\b23P01\b/.test(text) || /exclusion constraint/i.test(text)) return "unknown";
  return null;
}

@Injectable()
export class DowntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  list(query: { weekId?: string; reasonId?: string }) {
    return this.prisma.downtimeEntry.findMany({
      where: {
        deletedAt: null,
        weekId: query.weekId,
        downtimeReasonId: query.reasonId
      },
      include: { week: true, sector: true, line: true, equipment: true, shift: true, reason: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  async getById(id: string) {
    const entry = await this.prisma.downtimeEntry.findFirst({
      where: { id, deletedAt: null },
      include: { week: true, sector: true, line: true, equipment: true, shift: true, reason: true }
    });
    if (!entry) throw new NotFoundException("Parada nao encontrada.");
    return entry;
  }

  reasons() {
    return this.prisma.downtimeReason.findMany({
      where: { active: true },
      orderBy: { name: "asc" }
    });
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = downtimeEntrySchema.parse(payload);
    const userId = this.safeUserId(user);
    return this.writeTransaction(async (transaction) => {
      const resolved = await this.resolveEntry(transaction, input);
      const entry = await transaction.downtimeEntry.create({
        data: {
          weekId: input.weekId,
          date: input.date,
          sectorId: resolved.sector.id,
          lineId: resolved.line?.id,
          equipmentId: resolved.equipment?.id,
          shiftId: resolved.shift?.id,
          productionStart: input.productionStart,
          productionEnd: input.productionEnd,
          downtimeStart: input.downtimeStart,
          downtimeEnd: input.downtimeEnd,
          producedMassKg: input.producedMassKg,
          stoppedMinutes: resolved.calculated.stoppedMinutes,
          stoppedPercent: resolved.calculated.stoppedPercent,
          realKgHour: resolved.calculated.realKgHour,
          possibleKgHour: resolved.calculated.possibleKgHour,
          calculationRuleVersions: { ...resolved.calculated.calculationRuleVersions },
          status: resolved.calculated.status,
          workflowStatus: "DRAFT",
          downtimeReasonId: input.downtimeReasonId,
          notes: notesWithCalculations(input.notes, resolved.calculated.inconsistencies),
          createdBy: userId,
          updatedBy: userId
        },
        include: { sector: true, reason: true, week: true, line: true, equipment: true, shift: true }
      });
      await this.audit.record({
        userId,
        module: "downtime",
        action: "create",
        entity: "DowntimeEntry",
        entityId: entry.id,
        after: entry
      }, transaction);
      return { ...entry, calculations: resolved.calculated };
    });
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const patch = downtimeEntryUpdateSchema.parse(payload);
    const userId = this.safeUserId(user);
    return this.writeTransaction(async (transaction) => {
      await this.lockDowntimeEntry(transaction, id);
      const current = await transaction.downtimeEntry.findUnique({
        where: { id },
        include: { week: true, sector: true, line: true, equipment: true, shift: true, reason: true }
      });
      if (!current || current.deletedAt) throw new NotFoundException("Parada nao encontrada.");
      if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite edicao.");
      assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite edicao de paradas.");
      assertCurrentVersion(current.version, patch.version);
      assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED", "APPROVED"], "edicao");
      assertCanAmendApproved(current.workflowStatus, user?.roles);
      if (current.workflowStatus === "APPROVED" && !patch.changeReason) {
        throw new BadRequestException("Alteracao de parada aprovada exige motivo.");
      }

      const input = downtimeEntrySchema.parse({
        weekId: patch.weekId ?? current.weekId,
        date: patch.date ?? current.date,
        sector: patch.sector ?? current.sector.code,
        lineId: Object.prototype.hasOwnProperty.call(patch, "lineId") ? (patch.lineId ?? undefined) : (current.lineId ?? undefined),
        equipmentId: Object.prototype.hasOwnProperty.call(patch, "equipmentId") ? (patch.equipmentId ?? undefined) : (current.equipmentId ?? undefined),
        shiftId: Object.prototype.hasOwnProperty.call(patch, "shiftId") ? (patch.shiftId ?? undefined) : (current.shiftId ?? undefined),
        productionStart: patch.productionStart ?? current.productionStart,
        productionEnd: patch.productionEnd ?? current.productionEnd,
        downtimeStart: patch.downtimeStart ?? current.downtimeStart,
        downtimeEnd: patch.downtimeEnd ?? current.downtimeEnd,
        producedMassKg: patch.producedMassKg ?? current.producedMassKg,
        downtimeReasonId: patch.downtimeReasonId ?? current.downtimeReasonId,
        notes: Object.prototype.hasOwnProperty.call(patch, "notes") ? (patch.notes ?? undefined) : userNotes(current.notes)
      });
      const resolved = await this.resolveEntry(transaction, input, {
        entryId: id,
        lineId: current.lineId,
        equipmentId: current.equipmentId,
        shiftId: current.shiftId,
        downtimeReasonId: current.downtimeReasonId
      });
      const entry = await this.updateWithVersion(transaction, id, patch.version, {
        weekId: input.weekId,
        date: input.date,
        sectorId: resolved.sector.id,
        lineId: resolved.line?.id ?? null,
        equipmentId: resolved.equipment?.id ?? null,
        shiftId: resolved.shift?.id ?? null,
        productionStart: input.productionStart,
        productionEnd: input.productionEnd,
        downtimeStart: input.downtimeStart,
        downtimeEnd: input.downtimeEnd,
        producedMassKg: input.producedMassKg,
        stoppedMinutes: resolved.calculated.stoppedMinutes,
        stoppedPercent: resolved.calculated.stoppedPercent,
        realKgHour: resolved.calculated.realKgHour,
        possibleKgHour: resolved.calculated.possibleKgHour,
        calculationRuleVersions: { ...resolved.calculated.calculationRuleVersions },
        status: resolved.calculated.status,
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
        downtimeReasonId: input.downtimeReasonId,
        notes: notesWithCalculations(input.notes, resolved.calculated.inconsistencies) ?? null,
        updatedBy: userId
      });
      await this.audit.record({
        userId,
        module: "downtime",
        action: "update",
        entity: "DowntimeEntry",
        entityId: id,
        before: current,
        after: entry,
        reason: patch.changeReason
      }, transaction);
      return { ...entry, calculations: resolved.calculated };
    });
  }

  async softDelete(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.writeTransaction(async (transaction) => {
      await this.lockDowntimeEntry(transaction, id);
      const current = await transaction.downtimeEntry.findUnique({
        where: { id },
        include: { week: true }
      });
      if (!current || current.deletedAt) throw new NotFoundException("Parada nao encontrada.");
      if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite exclusao.");
      assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite exclusao de paradas.");
      assertCurrentVersion(current.version, command.version);
      assertWorkflowState(current.workflowStatus, ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"], "exclusao");
      const entry = await this.updateWithVersion(transaction, id, command.version, {
        deletedAt: new Date(),
        workflowStatus: "CANCELLED",
        updatedBy: userId
      });
      await this.audit.record({
        userId,
        module: "downtime",
        action: "delete",
        entity: "DowntimeEntry",
        entityId: id,
        before: current,
        after: entry,
        reason: command.reason
      }, transaction);
      return entry;
    });
  }

  async restore(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.writeTransaction(async (transaction) => {
      await this.lockDowntimeEntry(transaction, id);
      const current = await transaction.downtimeEntry.findUnique({
        where: { id },
        include: { week: true }
      });
      if (!current || !current.deletedAt) throw new NotFoundException("Parada excluida nao encontrada.");
      if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite restauracao.");
      assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite restauracao de paradas.");
      this.assertDatesWithinWeek(
        {
          date: current.date,
          productionStart: current.productionStart,
          productionEnd: current.productionEnd,
          downtimeStart: current.downtimeStart,
          downtimeEnd: current.downtimeEnd
        },
        current.week
      );
      this.assertChronology({
        productionStart: current.productionStart,
        productionEnd: current.productionEnd,
        downtimeStart: current.downtimeStart,
        downtimeEnd: current.downtimeEnd
      });
      if (!current.lineId && !current.equipmentId) {
        throw new BadRequestException("Associe uma linha de producao ou equipamento antes de restaurar a parada legada.");
      }
      await this.assertNoOverlap(transaction, {
        entryId: current.id,
        equipmentId: current.equipmentId,
        lineId: current.lineId,
        downtimeStart: current.downtimeStart,
        downtimeEnd: current.downtimeEnd
      });
      assertCurrentVersion(current.version, command.version);
      const entry = await this.updateWithVersion(transaction, id, command.version, {
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
        module: "downtime",
        action: "restore",
        entity: "DowntimeEntry",
        entityId: id,
        before: current,
        after: entry,
        reason: command.reason
      }, transaction);
      return entry;
    });
  }

  async submit(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.writeTransaction(async (transaction) => {
      const current = await this.workflowRecord(transaction, id, "submissao");
      assertCurrentVersion(current.version, command.version);
      assertWorkflowState(current.workflowStatus, ["DRAFT", "REJECTED"], "submissao");
      const entry = await this.updateWithVersion(transaction, id, command.version, {
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
      await this.audit.record({ userId, module: "downtime", action: "submit", entity: "DowntimeEntry", entityId: id, before: current, after: entry, reason: command.reason }, transaction);
      return entry;
    });
  }

  async approve(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedOptionalReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.writeTransaction(async (transaction) => {
      const current = await this.workflowRecord(transaction, id, "aprovacao");
      assertCurrentVersion(current.version, command.version);
      assertWorkflowState(current.workflowStatus, ["SUBMITTED", "UNDER_REVIEW"], "aprovacao");
      assertIndependentApprover(current.submittedBy, userId);
      const entry = await this.updateWithVersion(transaction, id, command.version, {
        workflowStatus: "APPROVED",
        approvedAt: new Date(),
        approvedBy: userId,
        approvalReason: command.reason ?? null,
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
        updatedBy: userId
      });
      await this.audit.record({ userId, module: "downtime", action: "approve", entity: "DowntimeEntry", entityId: id, before: current, after: entry, reason: command.reason }, transaction);
      return entry;
    });
  }

  async reject(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const userId = this.requireActorId(user);
    return this.writeTransaction(async (transaction) => {
      const current = await this.workflowRecord(transaction, id, "rejeicao");
      assertCurrentVersion(current.version, command.version);
      assertWorkflowState(current.workflowStatus, ["SUBMITTED", "UNDER_REVIEW"], "rejeicao");
      const entry = await this.updateWithVersion(transaction, id, command.version, {
        workflowStatus: "REJECTED",
        rejectedAt: new Date(),
        rejectedBy: userId,
        rejectionReason: command.reason,
        approvedAt: null,
        approvedBy: null,
        approvalReason: null,
        updatedBy: userId
      });
      await this.audit.record({ userId, module: "downtime", action: "reject", entity: "DowntimeEntry", entityId: id, before: current, after: entry, reason: command.reason }, transaction);
      return entry;
    });
  }

  async summary(weekId?: string) {
    const rows = await this.prisma.downtimeEntry.groupBy({
      by: ["downtimeReasonId"],
      where: { deletedAt: null, workflowStatus: "APPROVED", weekId },
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

  private async resolveEntry(
    transaction: Prisma.TransactionClient,
    input: DowntimeEntryInput,
    existing?: {
      entryId?: string;
      lineId: string | null;
      equipmentId: string | null;
      shiftId: string | null;
      downtimeReasonId: string;
    }
  ) {
    if (!input.lineId && !input.equipmentId) {
      throw new BadRequestException("Informe a linha de producao ou o equipamento da parada.");
    }
    const week = await transaction.weeklyPeriod.findUnique({
      where: { id: input.weekId }
    });
    if (!week || week.deletedAt) throw new NotFoundException("Semana nao encontrada.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita alteracoes em paradas.");
    this.assertDatesWithinWeek(input, week);
    this.assertChronology(input);

    const sector = await transaction.sector.findUnique({
      where: { code: input.sector }
    });
    if (!sector) throw new NotFoundException("Setor nao encontrado.");
    const [requestedLine, equipment, shift, reason] = await Promise.all([
      input.lineId ? transaction.productionLine.findUnique({ where: { id: input.lineId } }) : Promise.resolve(null),
      input.equipmentId ? transaction.equipment.findUnique({ where: { id: input.equipmentId }, include: { productionLine: true } }) : Promise.resolve(null),
      input.shiftId ? transaction.shift.findUnique({ where: { id: input.shiftId } }) : Promise.resolve(null),
      transaction.downtimeReason.findUnique({
        where: { id: input.downtimeReasonId }
      })
    ]);
    const line = requestedLine ?? equipment?.productionLine ?? null;
    if (input.lineId && (!requestedLine || requestedLine.deletedAt)) throw new NotFoundException("Linha de producao nao encontrada.");
    if (line?.deletedAt) throw new NotFoundException("Linha de producao nao encontrada.");
    if (line && !line.active && line.id !== existing?.lineId) {
      throw new BadRequestException("Linha inativa nao pode ser usada na parada.");
    }
    if (line && line.sectorId !== sector.id) {
      throw new BadRequestException("Linha de producao nao pertence ao setor informado.");
    }
    if (input.equipmentId && (!equipment || equipment.deletedAt)) throw new NotFoundException("Equipamento nao encontrado.");
    if (equipment && !equipment.active && equipment.id !== existing?.equipmentId) {
      throw new BadRequestException("Equipamento inativo nao pode ser usado na parada.");
    }
    if (equipment && requestedLine && equipment.productionLineId !== requestedLine.id) {
      throw new BadRequestException("Equipamento nao pertence a linha de producao informada.");
    }
    if (input.shiftId && (!shift || shift.deletedAt)) throw new NotFoundException("Turno nao encontrado.");
    if (shift && !shift.active && shift.id !== existing?.shiftId) {
      throw new BadRequestException("Turno inativo nao pode ser usado na parada.");
    }
    if (!reason) throw new NotFoundException("Motivo de parada nao encontrado.");
    if (!reason.active && reason.id !== existing?.downtimeReasonId) {
      throw new BadRequestException("Motivo inativo nao pode ser usado na parada.");
    }
    await this.assertNoOverlap(transaction, {
      entryId: existing?.entryId,
      equipmentId: equipment?.id ?? null,
      lineId: line?.id ?? null,
      downtimeStart: input.downtimeStart,
      downtimeEnd: input.downtimeEnd
    });

    const calculated = calculateDowntime({
      productionStart: input.productionStart,
      productionEnd: input.productionEnd,
      downtimeStart: input.downtimeStart,
      downtimeEnd: input.downtimeEnd,
      producedMassKg: input.producedMassKg
    });
    return { week, sector, line, equipment, shift, reason, calculated };
  }

  private assertDatesWithinWeek(
    input: Pick<DowntimeEntryInput, "date" | "productionStart" | "productionEnd" | "downtimeStart" | "downtimeEnd">,
    week: { startsOn: Date; endsOn: Date }
  ) {
    assertDateWithinWeek(input.date, week, "Data da parada precisa pertencer ao periodo da semana selecionada.");
    for (const timestamp of [input.productionStart, input.productionEnd, input.downtimeStart, input.downtimeEnd]) {
      assertDateWithinWeek(timestamp, week, "Horarios da parada precisam pertencer ao periodo da semana selecionada.");
    }
  }

  private assertChronology(input: Pick<DowntimeEntryInput, "productionStart" | "productionEnd" | "downtimeStart" | "downtimeEnd">) {
    if (input.productionEnd <= input.productionStart) {
      throw new BadRequestException("Termino da producao precisa ser posterior ao inicio.");
    }
    if (input.downtimeEnd <= input.downtimeStart) {
      throw new BadRequestException("Termino da parada precisa ser posterior ao inicio.");
    }
    if (input.downtimeStart < input.productionStart || input.downtimeEnd > input.productionEnd) {
      throw new BadRequestException("Intervalo da parada precisa estar contido no periodo de producao.");
    }
  }

  private async assertNoOverlap(transaction: Prisma.TransactionClient, input: {
    entryId?: string;
    equipmentId: string | null;
    lineId: string | null;
    downtimeStart: Date;
    downtimeEnd: Date;
  }) {
    if (!input.equipmentId && !input.lineId) return;
    const resource: Prisma.DowntimeEntryWhereInput = input.equipmentId
      ? { equipmentId: input.equipmentId }
      : { equipmentId: null, lineId: input.lineId };
    const conflict = await transaction.downtimeEntry.findFirst({
      where: {
        id: input.entryId ? { not: input.entryId } : undefined,
        deletedAt: null,
        ...resource,
        downtimeStart: { lt: input.downtimeEnd },
        downtimeEnd: { gt: input.downtimeStart }
      },
      select: { id: true }
    });
    if (conflict) {
      const resourceName = input.equipmentId ? "equipamento" : "linha de producao sem equipamento";
      throw new ConflictException(`Ja existe uma parada sobreposta para este ${resourceName}.`);
    }
  }

  private async workflowRecord(transaction: Prisma.TransactionClient, id: string, action: string) {
    await this.lockDowntimeEntry(transaction, id);
    const current = await transaction.downtimeEntry.findUnique({ where: { id }, include: { week: true } });
    if (!current || current.deletedAt) throw new NotFoundException("Parada nao encontrada.");
    if (current.week.deletedAt) throw new BadRequestException(`Semana removida nao permite ${action}.`);
    assertWeekWritable(current.week, `Semana fechada ou arquivada nao permite ${action}.`);
    if (!current.lineId && !current.equipmentId) {
      throw new BadRequestException("Associe uma linha de producao ou equipamento antes de avançar o fluxo da parada.");
    }
    this.assertDatesWithinWeek(current, current.week);
    this.assertChronology(current);
    return current;
  }

  private async updateWithVersion(
    transaction: Prisma.TransactionClient,
    id: string,
    version: number,
    data: Prisma.DowntimeEntryUncheckedUpdateInput
  ) {
    try {
      return await transaction.downtimeEntry.update({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
        include: { sector: true, reason: true, week: true, line: true, equipment: true, shift: true }
      });
    } catch (error) {
      this.throwIfOverlapConstraint(error);
      throwOptimisticConflict(error);
    }
  }

  private async lockDowntimeEntry(transaction: Prisma.TransactionClient, id: string) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
        FROM "downtime_entries"
       WHERE "id" = CAST(${id} AS uuid)
       FOR UPDATE
    `);
  }

  private throwIfOverlapConstraint(error: unknown) {
    const scope = downtimeOverlapConstraint(error);
    if (!scope) return;
    const resource = scope === "equipment"
      ? "equipamento"
      : scope === "line"
        ? "linha de producao sem equipamento"
        : "equipamento ou linha de producao";
    throw new ConflictException(
      `Conflito concorrente: outra parada sobreposta foi gravada para este ${resource}. Recarregue os dados e tente novamente.`
    );
  }

  private async writeTransaction<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) {
    try {
      return await this.prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      this.throwIfOverlapConstraint(error);
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2034") {
        throw new ConflictException("Conflito concorrente ao gravar a parada. Recarregue os dados e tente novamente.");
      }
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
