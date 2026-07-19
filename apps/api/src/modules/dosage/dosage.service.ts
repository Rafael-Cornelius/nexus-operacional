import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { dosageCheckSchema } from "../../domain/validators/schemas";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";
import { assertDateWithinWeek, assertWeekWritable } from "../../domain/weeks/week-rules";
import { calculateDosage } from "../../domain/calculations/dosage-calculations";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class DosageService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(weekId?: string, productId?: string) {
    return this.prisma.dosageCheck.findMany({
      where: { weekId, productId },
      include: { product: { select: { code: true, name: true } }, week: { select: { label: true } }, equipment: true, shift: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }]
    });
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = dosageCheckSchema.parse(payload);
    const [week, product, equipment, shift, operator] = await Promise.all([
      this.prisma.weeklyPeriod.findUnique({ where: { id: input.weekId } }),
      this.prisma.product.findUnique({ where: { id: input.productId }, include: { weightConfig: true } }),
      input.equipmentId
        ? this.prisma.equipment.findUnique({ where: { id: input.equipmentId }, include: { productionLine: { include: { sector: true } } } })
        : Promise.resolve(null),
      input.shiftId ? this.prisma.shift.findUnique({ where: { id: input.shiftId } }) : Promise.resolve(null),
      input.operatorId ? this.prisma.user.findUnique({ where: { id: input.operatorId } }) : Promise.resolve(null)
    ]);
    if (!week) throw new NotFoundException("Semana nao encontrada.");
    if (!product || product.deletedAt || !product.weightConfig) throw new NotFoundException("Produto ou configuracao de peso nao encontrado.");
    if (input.equipmentId && (!equipment || equipment.deletedAt)) throw new NotFoundException("Equipamento nao encontrado.");
    if (equipment && (!equipment.active || !equipment.productionLine.active || equipment.productionLine.deletedAt)) {
      throw new BadRequestException("Equipamento ou linha inativa nao pode ser usada na dosagem.");
    }
    if (equipment && equipment.productionLine.sector.code !== input.sector) {
      throw new BadRequestException("Equipamento nao pertence ao setor informado.");
    }
    if (input.shiftId && (!shift || shift.deletedAt)) throw new NotFoundException("Turno nao encontrado.");
    if (shift && !shift.active) throw new BadRequestException("Turno inativo nao pode ser usado na dosagem.");
    if (input.operatorId && (!operator || operator.deletedAt || !operator.active)) throw new NotFoundException("Operador ativo nao encontrado.");
    assertWeekWritable(week, "Semana fechada ou arquivada nao aceita amostras.");
    assertDateWithinWeek(input.date, week, "Data da amostra precisa pertencer à semana selecionada.");
    const targetWeightG = Number(product.weightConfig.targetPackageWeightG);
    const calculated = calculateDosage(input.sampleWeightsG, targetWeightG);
    const row = await this.prisma.dosageCheck.create({
      data: {
        weekId: input.weekId,
        productId: input.productId,
        sectorCode: input.sector,
        equipmentId: equipment?.id,
        shiftId: shift?.id,
        operatorId: operator?.id,
        date: input.date,
        targetWeightG,
        sampleWeightsG: input.sampleWeightsG,
        sampleCount: calculated.sampleCount,
        averageWeightG: calculated.averageWeightG,
        standardDeviationG: calculated.standardDeviationG,
        overweightG: calculated.overweightG,
        calculationRuleVersions: { ...calculated.calculationRuleVersions },
        notes: input.notes
      },
      include: { product: { select: { code: true, name: true } }, week: { select: { label: true } }, equipment: true, shift: true }
    });
    await this.audit.record({ userId: this.safeUserId(user), module: "dosage", action: "create", entity: "DosageCheck", entityId: row.id, after: row });
    return { ...row, calculationRuleVersions: calculated.calculationRuleVersions };
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
