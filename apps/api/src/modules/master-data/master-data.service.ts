import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { LossTypeCode, Prisma, SectorCode } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = z.string().uuid();

const sectorCreateSchema = z.object({
  code: z.nativeEnum(SectorCode),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional()
}).strict();

const sectorUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para atualizar.");

const lineCreateSchema = z.object({
  sectorId: uuid,
  code: z.string().trim().min(1).max(40).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(2).max(120),
  active: z.boolean().optional().default(true)
}).strict();

const lineUpdateSchema = z.object({
  sectorId: uuid.optional(),
  code: z.string().trim().min(1).max(40).transform((value) => value.toUpperCase()).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  active: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para atualizar.");

const lossTypeCreateSchema = z.object({
  code: z.nativeEnum(LossTypeCode),
  name: z.string().trim().min(2).max(120),
  defaultGoalKg: z.union([z.coerce.number().finite().nonnegative(), z.null()]).optional(),
  active: z.boolean().optional().default(true)
}).strict();

const lossTypeUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  defaultGoalKg: z.union([z.coerce.number().finite().nonnegative(), z.null()]).optional(),
  active: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para atualizar.");

const downtimeReasonCreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  active: z.boolean().optional().default(true)
}).strict();

const downtimeReasonUpdateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  active: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo para atualizar.");

@Injectable()
export class MasterDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async overview() {
    const [sectors, lines, lossTypes, downtimeReasons] = await Promise.all([
      this.sectors(),
      this.lines({ deleted: "all" }),
      this.lossTypes(),
      this.downtimeReasons()
    ]);
    return { sectors, lines, lossTypes, downtimeReasons };
  }

  sectors() {
    return this.prisma.sector.findMany({
      include: {
        _count: {
          select: { lines: true, products: true, entries: true, losses: true, downtimes: true, goals: true }
        }
      },
      orderBy: { code: "asc" }
    });
  }

  async createSector(payload: unknown, user?: CurrentUser) {
    const input = sectorCreateSchema.parse(payload);
    try {
      return await this.write(async (transaction) => {
        const duplicate = await transaction.sector.findUnique({ where: { code: input.code } });
        if (duplicate) throw new ConflictException("Ja existe setor com este codigo.");
        const sector = await transaction.sector.create({ data: input });
        await this.record(transaction, user, "create", "Sector", sector.id, undefined, sector);
        return sector;
      });
    } catch (error) {
      this.rethrowWriteError(error, "Ja existe setor com este codigo.");
    }
  }

  async updateSector(id: string, payload: unknown, user?: CurrentUser) {
    const input = sectorUpdateSchema.parse(payload);
    return this.write(async (transaction) => {
      const current = await transaction.sector.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("Setor nao encontrado.");
      const sector = await transaction.sector.update({ where: { id }, data: input });
      await this.record(transaction, user, "update", "Sector", id, current, sector);
      return sector;
    });
  }

  async deleteSector(id: string, user?: CurrentUser) {
    try {
      return await this.write(async (transaction) => {
        const current = await transaction.sector.findUnique({ where: { id } });
        if (!current) throw new NotFoundException("Setor nao encontrado.");
        const [lines, products, production, losses, downtimes, goals] = await Promise.all([
          transaction.productionLine.count({ where: { sectorId: id } }),
          transaction.product.count({ where: { defaultSectorId: id } }),
          transaction.productionEntry.count({ where: { sectorId: id } }),
          transaction.lossEntry.count({ where: { sectorId: id } }),
          transaction.downtimeEntry.count({ where: { sectorId: id } }),
          transaction.goal.count({ where: { sectorCode: current.code } })
        ]);
        const dependencies = lines + products + production + losses + downtimes + goals;
        if (dependencies > 0) {
          throw new ConflictException(`Setor possui ${dependencies} vinculo(s) e nao pode ser removido.`);
        }
        const sector = await transaction.sector.delete({ where: { id } });
        await this.record(transaction, user, "delete", "Sector", id, current, sector);
        return sector;
      });
    } catch (error) {
      this.rethrowWriteError(error, "Setor possui vinculos e nao pode ser removido.");
    }
  }

  lines(query: { sectorId?: string; active?: string; deleted?: string }) {
    return this.prisma.productionLine.findMany({
      where: {
        sectorId: query.sectorId,
        active: query.active === undefined ? undefined : query.active === "true",
        deletedAt: query.deleted === "all" ? undefined : query.deleted === "true" ? { not: null } : null
      },
      include: {
        sector: true,
        _count: { select: { equipment: true, entries: true, downtimes: true, goals: true } }
      },
      orderBy: [{ sector: { code: "asc" } }, { code: "asc" }]
    });
  }

  async createLine(payload: unknown, user?: CurrentUser) {
    const input = lineCreateSchema.parse(payload);
    try {
      return await this.write(async (transaction) => {
        await this.assertSector(input.sectorId, transaction);
        const duplicate = await transaction.productionLine.findUnique({
          where: { sectorId_code: { sectorId: input.sectorId, code: input.code } }
        });
        if (duplicate && !duplicate.deletedAt) throw new ConflictException("Ja existe linha com este codigo no setor.");
        const line = duplicate
          ? await transaction.productionLine.update({
              where: { id: duplicate.id },
              data: { ...input, deletedAt: null },
              include: { sector: true }
            })
          : await transaction.productionLine.create({ data: input, include: { sector: true } });
        await this.record(transaction, user, duplicate ? "restore" : "create", "ProductionLine", line.id, duplicate ?? undefined, line);
        return line;
      });
    } catch (error) {
      this.rethrowWriteError(error, "Ja existe linha com este codigo no setor.");
    }
  }

  async updateLine(id: string, payload: unknown, user?: CurrentUser) {
    const input = lineUpdateSchema.parse(payload);
    try {
      return await this.write(async (transaction) => {
        const current = await transaction.productionLine.findUnique({ where: { id }, include: { sector: true } });
        if (!current || current.deletedAt) throw new NotFoundException("Linha de producao nao encontrada.");
        const sectorId = input.sectorId ?? current.sectorId;
        if (input.sectorId) await this.assertSector(input.sectorId, transaction);
        if (input.code || input.sectorId) {
          const duplicate = await transaction.productionLine.findFirst({
            where: { id: { not: id }, sectorId, code: input.code ?? current.code, deletedAt: null }
          });
          if (duplicate) throw new ConflictException("Ja existe linha com este codigo no setor.");
        }
        const line = await transaction.productionLine.update({
          where: { id },
          data: input,
          include: { sector: true }
        });
        await this.record(transaction, user, "update", "ProductionLine", id, current, line);
        return line;
      });
    } catch (error) {
      this.rethrowWriteError(error, "Ja existe linha com este codigo no setor.");
    }
  }

  async deactivateLine(id: string, user?: CurrentUser) {
    return this.write(async (transaction) => {
      const current = await transaction.productionLine.findUnique({ where: { id }, include: { sector: true } });
      if (!current || current.deletedAt) throw new NotFoundException("Linha de producao nao encontrada.");
      const activeEquipment = await transaction.equipment.count({ where: { productionLineId: id, active: true, deletedAt: null } });
      if (activeEquipment > 0) {
        throw new ConflictException(`Desative os ${activeEquipment} equipamento(s) ativos da linha antes de remove-la.`);
      }
      const line = await transaction.productionLine.update({
        where: { id },
        data: { active: false, deletedAt: new Date() },
        include: { sector: true }
      });
      await this.record(transaction, user, "deactivate", "ProductionLine", id, current, line);
      return line;
    });
  }

  async restoreLine(id: string, user?: CurrentUser) {
    return this.write(async (transaction) => {
      const current = await transaction.productionLine.findUnique({ where: { id }, include: { sector: true } });
      if (!current || !current.deletedAt) throw new NotFoundException("Linha de producao removida nao encontrada.");
      await this.assertSector(current.sectorId, transaction);
      const line = await transaction.productionLine.update({
        where: { id },
        data: { active: true, deletedAt: null },
        include: { sector: true }
      });
      await this.record(transaction, user, "restore", "ProductionLine", id, current, line);
      return line;
    });
  }

  lossTypes(active?: string) {
    return this.prisma.lossType.findMany({
      where: { active: active === undefined ? undefined : active === "true" },
      include: { _count: { select: { entries: true } } },
      orderBy: { code: "asc" }
    });
  }

  async createLossType(payload: unknown, user?: CurrentUser) {
    const input = lossTypeCreateSchema.parse(payload);
    try {
      return await this.write(async (transaction) => {
        const duplicate = await transaction.lossType.findUnique({ where: { code: input.code } });
        if (duplicate?.active) throw new ConflictException("Ja existe tipo de perda com este codigo.");
        const lossType = duplicate
          ? await transaction.lossType.update({ where: { id: duplicate.id }, data: { ...input, active: true } })
          : await transaction.lossType.create({ data: input });
        await this.record(transaction, user, duplicate ? "restore" : "create", "LossType", lossType.id, duplicate ?? undefined, lossType);
        return lossType;
      });
    } catch (error) {
      this.rethrowWriteError(error, "Ja existe tipo de perda com este codigo.");
    }
  }

  async updateLossType(id: string, payload: unknown, user?: CurrentUser) {
    const input = lossTypeUpdateSchema.parse(payload);
    return this.write(async (transaction) => {
      const current = await transaction.lossType.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("Tipo de perda nao encontrado.");
      const lossType = await transaction.lossType.update({ where: { id }, data: input });
      await this.record(transaction, user, "update", "LossType", id, current, lossType);
      return lossType;
    });
  }

  async deactivateLossType(id: string, user?: CurrentUser) {
    return this.write(async (transaction) => {
      const current = await transaction.lossType.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("Tipo de perda nao encontrado.");
      const lossType = await transaction.lossType.update({ where: { id }, data: { active: false } });
      await this.record(transaction, user, "deactivate", "LossType", id, current, lossType);
      return lossType;
    });
  }

  async restoreLossType(id: string, user?: CurrentUser) {
    return this.write(async (transaction) => {
      const current = await transaction.lossType.findUnique({ where: { id } });
      if (!current || current.active) throw new NotFoundException("Tipo de perda inativo nao encontrado.");
      const lossType = await transaction.lossType.update({ where: { id }, data: { active: true } });
      await this.record(transaction, user, "restore", "LossType", id, current, lossType);
      return lossType;
    });
  }

  downtimeReasons(active?: string) {
    return this.prisma.downtimeReason.findMany({
      where: { active: active === undefined ? undefined : active === "true" },
      include: { _count: { select: { entries: true } } },
      orderBy: { name: "asc" }
    });
  }

  async createDowntimeReason(payload: unknown, user?: CurrentUser) {
    const input = downtimeReasonCreateSchema.parse(payload);
    try {
      return await this.write(async (transaction) => {
        const duplicate = await transaction.downtimeReason.findFirst({
          where: { name: { equals: input.name, mode: "insensitive" } }
        });
        if (duplicate?.active) throw new ConflictException("Ja existe motivo de parada com este nome.");
        const reason = duplicate
          ? await transaction.downtimeReason.update({ where: { id: duplicate.id }, data: { ...input, active: true } })
          : await transaction.downtimeReason.create({ data: input });
        await this.record(transaction, user, duplicate ? "restore" : "create", "DowntimeReason", reason.id, duplicate ?? undefined, reason);
        return reason;
      });
    } catch (error) {
      this.rethrowWriteError(error, "Ja existe motivo de parada com este nome.");
    }
  }

  async updateDowntimeReason(id: string, payload: unknown, user?: CurrentUser) {
    const input = downtimeReasonUpdateSchema.parse(payload);
    try {
      return await this.write(async (transaction) => {
        const current = await transaction.downtimeReason.findUnique({ where: { id } });
        if (!current) throw new NotFoundException("Motivo de parada nao encontrado.");
        if (input.name) {
          const duplicate = await transaction.downtimeReason.findFirst({
            where: { id: { not: id }, name: { equals: input.name, mode: "insensitive" } }
          });
          if (duplicate) throw new ConflictException("Ja existe motivo de parada com este nome.");
        }
        const reason = await transaction.downtimeReason.update({ where: { id }, data: input });
        await this.record(transaction, user, "update", "DowntimeReason", id, current, reason);
        return reason;
      });
    } catch (error) {
      this.rethrowWriteError(error, "Ja existe motivo de parada com este nome.");
    }
  }

  async deactivateDowntimeReason(id: string, user?: CurrentUser) {
    return this.write(async (transaction) => {
      const current = await transaction.downtimeReason.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("Motivo de parada nao encontrado.");
      const reason = await transaction.downtimeReason.update({ where: { id }, data: { active: false } });
      await this.record(transaction, user, "deactivate", "DowntimeReason", id, current, reason);
      return reason;
    });
  }

  async restoreDowntimeReason(id: string, user?: CurrentUser) {
    return this.write(async (transaction) => {
      const current = await transaction.downtimeReason.findUnique({ where: { id } });
      if (!current || current.active) throw new NotFoundException("Motivo de parada inativo nao encontrado.");
      const reason = await transaction.downtimeReason.update({ where: { id }, data: { active: true } });
      await this.record(transaction, user, "restore", "DowntimeReason", id, current, reason);
      return reason;
    });
  }

  private write<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async assertSector(id: string, transaction: Prisma.TransactionClient) {
    const sector = await transaction.sector.findUnique({ where: { id } });
    if (!sector) throw new NotFoundException("Setor nao encontrado.");
    return sector;
  }

  private record(
    transaction: Prisma.TransactionClient,
    user: CurrentUser | undefined,
    action: string,
    entity: string,
    entityId: string,
    before?: unknown,
    after?: unknown
  ) {
    return this.audit.record({
      userId: user?.id && uuidPattern.test(user.id) ? user.id : undefined,
      module: "master-data",
      action,
      entity,
      entityId,
      before,
      after
    }, transaction);
  }

  private rethrowWriteError(error: unknown, conflictMessage: string): never {
    if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2003"].includes(error.code)) {
      throw new ConflictException(conflictMessage);
    }
    throw error;
  }
}
