import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const shiftSchema = z.object({
  code: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(2).max(80),
  startsAt: z.string().regex(timePattern, "Horario inicial deve usar HH:mm."),
  endsAt: z.string().regex(timePattern, "Horario final deve usar HH:mm."),
  active: z.boolean().optional().default(true)
});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function timeValue(value: string) {
  return new Date(`1970-01-01T${value}:00.000Z`);
}

function toDto<T extends { startsAt: Date; endsAt: Date }>(shift: T) {
  return {
    ...shift,
    startsAt: shift.startsAt.toISOString().slice(11, 16),
    endsAt: shift.endsAt.toISOString().slice(11, 16)
  };
}

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(active?: string) {
    const shifts = await this.prisma.shift.findMany({
      where: { deletedAt: null, active: active === undefined ? undefined : active === "true" },
      orderBy: { startsAt: "asc" }
    });
    return shifts.map(toDto);
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = shiftSchema.parse(payload);
    const duplicate = await this.prisma.shift.findUnique({ where: { code: input.code } });
    if (duplicate && !duplicate.deletedAt) throw new ConflictException("Ja existe turno com este codigo.");
    if (duplicate?.deletedAt) {
      const restored = await this.prisma.shift.update({
        where: { id: duplicate.id },
        data: { ...input, startsAt: timeValue(input.startsAt), endsAt: timeValue(input.endsAt), deletedAt: null }
      });
      const result = toDto(restored);
      await this.audit.record({ userId: this.userId(user), module: "shifts", action: "restore", entity: "Shift", entityId: restored.id, before: toDto(duplicate), after: result });
      return result;
    }
    const shift = await this.prisma.shift.create({
      data: { ...input, startsAt: timeValue(input.startsAt), endsAt: timeValue(input.endsAt) }
    });
    const result = toDto(shift);
    await this.audit.record({ userId: this.userId(user), module: "shifts", action: "create", entity: "Shift", entityId: shift.id, after: result });
    return result;
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const input = shiftSchema.partial().parse(payload);
    const current = await this.prisma.shift.findUnique({ where: { id } });
    if (!current || current.deletedAt) throw new NotFoundException("Turno nao encontrado.");
    if (input.code) {
      const duplicate = await this.prisma.shift.findFirst({ where: { id: { not: id }, code: input.code, deletedAt: null } });
      if (duplicate) throw new ConflictException("Ja existe turno com este codigo.");
    }
    const shift = await this.prisma.shift.update({
      where: { id },
      data: {
        ...input,
        startsAt: input.startsAt ? timeValue(input.startsAt) : undefined,
        endsAt: input.endsAt ? timeValue(input.endsAt) : undefined
      }
    });
    const result = toDto(shift);
    await this.audit.record({ userId: this.userId(user), module: "shifts", action: "update", entity: "Shift", entityId: id, before: toDto(current), after: result });
    return result;
  }

  async deactivate(id: string, user?: CurrentUser) {
    const current = await this.prisma.shift.findUnique({ where: { id } });
    if (!current || current.deletedAt) throw new NotFoundException("Turno nao encontrado.");
    const shift = await this.prisma.shift.update({ where: { id }, data: { active: false, deletedAt: new Date() } });
    const result = toDto(shift);
    await this.audit.record({ userId: this.userId(user), module: "shifts", action: "deactivate", entity: "Shift", entityId: id, before: toDto(current), after: result });
    return result;
  }

  private userId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
