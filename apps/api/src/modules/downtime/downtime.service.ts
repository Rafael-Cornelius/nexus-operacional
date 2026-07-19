import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
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

type DowntimeEntryInput = z.infer<typeof downtimeEntrySchema>;

function userNotes(value?: string | null) {
  const lines = (value ?? "").split("\n").filter((line) => line.trim() && !downtimeCalculationNotes.has(line.trim()));
  return lines.join("\n") || undefined;
}

function notesWithCalculations(value: string | undefined, inconsistencies: string[]) {
  return [userNotes(value), ...inconsistencies].filter(Boolean).join("\n") || undefined;
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
    const resolved = await this.resolveEntry(input);
    const userId = this.safeUserId(user);
    const entry = await this.prisma.downtimeEntry.create({
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
    });
    return { ...entry, calculations: resolved.calculated };
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const patch = downtimeEntryUpdateSchema.parse(payload);
    const current = await this.prisma.downtimeEntry.findUnique({
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
    const resolved = await this.resolveEntry(input, {
      entryId: id,
      lineId: current.lineId,
      equipmentId: current.equipmentId,
      shiftId: current.shiftId,
      downtimeReasonId: current.downtimeReasonId
    });
    const userId = this.safeUserId(user);
    const entry = await this.updateWithVersion(id, patch.version, {
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
    });
    return { ...entry, calculations: resolved.calculated };
  }

  async softDelete(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const current = await this.prisma.downtimeEntry.findUnique({
      where: { id },
      include: { week: true }
    });
    if (!current || current.deletedAt) throw new NotFoundException("Parada nao encontrada.");
    if (current.week.deletedAt) throw new BadRequestException("Semana removida nao permite exclusao.");
    assertWeekWritable(current.week, "Semana fechada ou arquivada nao permite exclusao de paradas.");
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
      module: "downtime",
      action: "delete",
      entity: "DowntimeEntry",
      entityId: id,
      before: current,
      after: entry,
      reason: command.reason
    });
    return entry;
  }

  async restore(id: string, payload: unknown, user?: CurrentUser) {
    const command = versionedReasonCommandSchema.parse(payload);
    const current = await this.prisma.downtimeEntry.findUnique({
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
      module: "downtime",
      action: "restore",
      entity: "DowntimeEntry",
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
    await this.audit.record({ userId, module: "downtime", action: "submit", entity: "DowntimeEntry", entityId: id, before: current, after: entry, reason: command.reason });
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
    await this.audit.record({ userId, module: "downtime", action: "approve", entity: "DowntimeEntry", entityId: id, before: current, after: entry, reason: command.reason });
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
    await this.audit.record({ userId, module: "downtime", action: "reject", entity: "DowntimeEntry", entityId: id, before: current, after: entry, reason: command.reason });
    return entry;
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
    input: DowntimeEntryInput,
    existing?: {
      entryId?: string;
      lineId: string | null;
      equipmentId: string | null;
      shiftId: string | null;
      downtimeReasonId: string;
    }
  ) {
    const week = await this.prisma.weeklyPeriod.findUnique({
      where: { id: input.weekId }
    });
    if (!week || week.deletedAt) throw new NotFoundException("Semana nao encontrada.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita alteracoes em paradas.");
    this.assertDatesWithinWeek(input, week);
    this.assertChronology(input);

    const sector = await this.prisma.sector.findUnique({
      where: { code: input.sector }
    });
    if (!sector) throw new NotFoundException("Setor nao encontrado.");
    const [requestedLine, equipment, shift, reason] = await Promise.all([
      input.lineId ? this.prisma.productionLine.findUnique({ where: { id: input.lineId } }) : Promise.resolve(null),
      input.equipmentId ? this.prisma.equipment.findUnique({ where: { id: input.equipmentId }, include: { productionLine: true } }) : Promise.resolve(null),
      input.shiftId ? this.prisma.shift.findUnique({ where: { id: input.shiftId } }) : Promise.resolve(null),
      this.prisma.downtimeReason.findUnique({
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
    if (line) {
      const conflict = await this.prisma.downtimeEntry.findFirst({
        where: {
          id: existing?.entryId ? { not: existing.entryId } : undefined,
          deletedAt: null,
          lineId: line.id,
          downtimeStart: { lt: input.downtimeEnd },
          downtimeEnd: { gt: input.downtimeStart }
        },
        select: { id: true }
      });
      if (conflict) {
        throw new BadRequestException("Ja existe uma parada sobreposta para esta linha de producao.");
      }
    }

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

  private async workflowRecord(id: string, action: string) {
    const current = await this.prisma.downtimeEntry.findUnique({ where: { id }, include: { week: true } });
    if (!current || current.deletedAt) throw new NotFoundException("Parada nao encontrada.");
    if (current.week.deletedAt) throw new BadRequestException(`Semana removida nao permite ${action}.`);
    assertWeekWritable(current.week, `Semana fechada ou arquivada nao permite ${action}.`);
    this.assertDatesWithinWeek(current, current.week);
    this.assertChronology(current);
    return current;
  }

  private async updateWithVersion(id: string, version: number, data: Prisma.DowntimeEntryUncheckedUpdateInput) {
    try {
      return await this.prisma.downtimeEntry.update({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
        include: { sector: true, reason: true, week: true, line: true, equipment: true, shift: true }
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
