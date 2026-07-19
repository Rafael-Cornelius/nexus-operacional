import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";

const uuid = z.string().uuid();
const equipmentSchema = z.object({
  productionLineId: uuid,
  code: z.string().trim().min(1).max(40).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(2).max(120),
  type: z.string().trim().max(80).optional(),
  active: z.boolean().optional().default(true)
});
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class EquipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  list(query: { active?: string; productionLineId?: string; search?: string }) {
    return this.prisma.equipment.findMany({
      where: {
        deletedAt: null,
        active: query.active === undefined ? undefined : query.active === "true",
        productionLineId: query.productionLineId,
        OR: query.search ? [
          { code: { contains: query.search, mode: "insensitive" } },
          { name: { contains: query.search, mode: "insensitive" } },
          { type: { contains: query.search, mode: "insensitive" } }
        ] : undefined
      },
      include: { productionLine: { include: { sector: true } } },
      orderBy: [{ productionLine: { code: "asc" } }, { code: "asc" }]
    });
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = equipmentSchema.parse(payload);
    await this.assertLine(input.productionLineId);
    const duplicate = await this.prisma.equipment.findUnique({
      where: { productionLineId_code: { productionLineId: input.productionLineId, code: input.code } }
    });
    if (duplicate && !duplicate.deletedAt) throw new ConflictException("Ja existe equipamento com este codigo na linha.");
    if (duplicate?.deletedAt) {
      const restored = await this.prisma.equipment.update({
        where: { id: duplicate.id },
        data: { ...input, deletedAt: null },
        include: { productionLine: { include: { sector: true } } }
      });
      await this.audit.record({ userId: this.userId(user), module: "equipment", action: "restore", entity: "Equipment", entityId: restored.id, before: duplicate, after: restored });
      return restored;
    }
    const equipment = await this.prisma.equipment.create({
      data: input,
      include: { productionLine: { include: { sector: true } } }
    });
    await this.audit.record({ userId: this.userId(user), module: "equipment", action: "create", entity: "Equipment", entityId: equipment.id, after: equipment });
    return equipment;
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const input = equipmentSchema.partial().parse(payload);
    const current = await this.prisma.equipment.findUnique({ where: { id }, include: { productionLine: true } });
    if (!current || current.deletedAt) throw new NotFoundException("Equipamento nao encontrado.");
    const productionLineId = input.productionLineId ?? current.productionLineId;
    if (input.productionLineId) await this.assertLine(input.productionLineId);
    if (input.code || input.productionLineId) {
      const duplicate = await this.prisma.equipment.findFirst({
        where: { id: { not: id }, productionLineId, code: input.code ?? current.code, deletedAt: null }
      });
      if (duplicate) throw new ConflictException("Ja existe equipamento com este codigo na linha.");
    }
    const equipment = await this.prisma.equipment.update({
      where: { id },
      data: input,
      include: { productionLine: { include: { sector: true } } }
    });
    await this.audit.record({ userId: this.userId(user), module: "equipment", action: "update", entity: "Equipment", entityId: id, before: current, after: equipment });
    return equipment;
  }

  async deactivate(id: string, user?: CurrentUser) {
    const current = await this.prisma.equipment.findUnique({ where: { id } });
    if (!current || current.deletedAt) throw new NotFoundException("Equipamento nao encontrado.");
    const equipment = await this.prisma.equipment.update({ where: { id }, data: { active: false, deletedAt: new Date() } });
    await this.audit.record({ userId: this.userId(user), module: "equipment", action: "deactivate", entity: "Equipment", entityId: id, before: current, after: equipment });
    return equipment;
  }

  private async assertLine(id: string) {
    const line = await this.prisma.productionLine.findUnique({ where: { id } });
    if (!line || line.deletedAt || !line.active) throw new NotFoundException("Linha de producao ativa nao encontrada.");
  }

  private userId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
