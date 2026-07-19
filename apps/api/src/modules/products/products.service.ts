import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import {
  productPriceApprovalSchema,
  productPricePeriodSchema,
  productPriceRetirementSchema,
  productSchema
} from "../../domain/validators/schemas";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { assertCurrentVersion } from "../../domain/workflow/workflow-rules";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dateOnly(value: Date) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(query: { active?: string; search?: string; deleted?: string }) {
    const today = dateOnly(new Date());
    const products = await this.prisma.product.findMany({
      where: {
        deletedAt: query.deleted === "true" ? { not: null } : null,
        active: query.active === undefined ? undefined : query.active === "true",
        OR: query.search
          ? [
              { code: { contains: query.search, mode: "insensitive" } },
              { name: { contains: query.search, mode: "insensitive" } }
            ]
          : undefined
      },
      include: {
        defaultSector: true,
        weightConfig: true,
        pricePeriods: {
          where: {
            status: "APPROVED",
            startsOn: { lte: today },
            OR: [{ endsOn: null }, { endsOn: { gte: today } }]
          },
          orderBy: [{ startsOn: "desc" }, { version: "desc" }],
          take: 1
        }
      },
      orderBy: [{ active: "desc" }, { code: "asc" }]
    });
    return products.map((product) => {
      const effectivePricePeriod = product.pricePeriods[0] ?? null;
      return {
        ...product,
        effectivePricePeriod,
        pricePerKg: effectivePricePeriod?.pricePerKg ?? null,
        filmCostPerKg: effectivePricePeriod?.filmCostPerKg ?? null
      };
    });
  }

  async byId(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        defaultSector: true,
        weightConfig: true,
        pricePeriods: {
          orderBy: [{ version: "desc" }, { createdAt: "desc" }],
          include: {
            responsible: { select: { id: true, name: true, email: true } },
            approver: { select: { id: true, name: true, email: true } },
            retirer: { select: { id: true, name: true, email: true } }
          }
        }
      }
    });
    if (!product) throw new NotFoundException("Produto nao encontrado.");
    return product;
  }

  async create(payload: unknown, user?: CurrentUser) {
    const input = productSchema.parse(payload);
    const sector = await this.prisma.sector.findUniqueOrThrow({ where: { code: input.defaultSector } });
    const userId = this.safeUserId(user);
    const product = await this.prisma.product.create({
      data: {
        code: input.code,
        name: input.name,
        defaultSectorId: sector.id,
        unit: input.unit,
        packageFilmWeightG: input.packageFilmWeightG,
        notes: input.notes,
        createdBy: userId,
        updatedBy: userId,
        weightConfig: {
          create: {
            packageWeightKg: input.packageWeightKg,
            boxWeightKg: input.boxWeightKg,
            packagesPerBox: input.packagesPerBox,
            massWeightKg: input.massWeightKg,
            targetPackageWeightG: input.targetPackageWeightG,
            overweightTolerancePercent: input.overweightTolerancePercent,
            formula: input.formula
          }
        }
      },
      include: { defaultSector: true, weightConfig: true }
    });

    await this.audit.record({ userId, module: "products", action: "create", entity: "Product", entityId: product.id, after: product });
    return product;
  }

  async update(id: string, payload: unknown, user?: CurrentUser) {
    const input = productSchema.partial().parse(payload);
    const current = await this.prisma.product.findUnique({ where: { id }, include: { weightConfig: true } });
    if (!current) throw new NotFoundException("Produto nao encontrado.");
    const userId = this.safeUserId(user);

    const sector = input.defaultSector
      ? await this.prisma.sector.findUniqueOrThrow({ where: { code: input.defaultSector } })
      : undefined;

    const weightFields = ["packageWeightKg", "boxWeightKg", "packagesPerBox", "massWeightKg", "targetPackageWeightG", "overweightTolerancePercent", "formula"] as const;
    const hasWeightPatch = weightFields.some((field) => Object.prototype.hasOwnProperty.call(input, field));
    if (hasWeightPatch && !current.weightConfig) {
      const missing = weightFields.filter((field) => input[field] === undefined);
      if (missing.length) {
        throw new BadRequestException(`Configuracao de peso inexistente. Informe todos os campos tecnicos: ${missing.join(", ")}.`);
      }
    }

    const product = await this.prisma.product.update({
      where: { id },
      data: {
        code: input.code,
        name: input.name,
        defaultSectorId: sector?.id,
        unit: input.unit,
        packageFilmWeightG: input.packageFilmWeightG,
        notes: input.notes,
        updatedBy: userId,
        weightConfig: hasWeightPatch
          ? {
              upsert: {
                create: {
                  packageWeightKg: input.packageWeightKg!,
                  boxWeightKg: input.boxWeightKg!,
                  packagesPerBox: input.packagesPerBox!,
                  massWeightKg: input.massWeightKg!,
                  targetPackageWeightG: input.targetPackageWeightG!,
                  overweightTolerancePercent: input.overweightTolerancePercent!,
                  formula: input.formula!
                },
                update: {
                  packageWeightKg: input.packageWeightKg,
                  boxWeightKg: input.boxWeightKg,
                  packagesPerBox: input.packagesPerBox,
                  massWeightKg: input.massWeightKg,
                  targetPackageWeightG: input.targetPackageWeightG,
                  overweightTolerancePercent: input.overweightTolerancePercent,
                  formula: input.formula
                }
              }
            }
          : undefined
      },
      include: { defaultSector: true, weightConfig: true }
    });

    await this.audit.record({ userId, module: "products", action: "update", entity: "Product", entityId: id, before: current, after: product });
    return product;
  }

  async pricePeriods(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true, deletedAt: true } });
    if (!product) throw new NotFoundException("Produto nao encontrado.");
    return this.prisma.productPricePeriod.findMany({
      where: { productId },
      orderBy: [{ version: "desc" }, { createdAt: "desc" }],
      include: {
        responsible: { select: { id: true, name: true, email: true } },
        approver: { select: { id: true, name: true, email: true } },
        retirer: { select: { id: true, name: true, email: true } }
      }
    });
  }

  async addPricePeriod(productId: string, payload: unknown, user?: CurrentUser) {
    const input = productPricePeriodSchema.parse(payload);
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.deletedAt) throw new NotFoundException("Produto nao encontrado.");
    const userId = this.requireActorId(user);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const latest = await tx.productPricePeriod.findFirst({
          where: { productId },
          orderBy: { version: "desc" },
          select: { version: true }
        });
        const period = await tx.productPricePeriod.create({
          data: {
            productId,
            startsOn: input.startsOn,
            endsOn: input.endsOn ?? null,
            pricePerKg: input.pricePerKg,
            filmCostPerKg: input.filmCostPerKg,
            currency: input.currency,
            origin: input.origin,
            observation: input.observation ?? null,
            responsibleBy: userId,
            version: (latest?.version ?? 0) + 1,
            status: "DRAFT"
          }
        });
        await this.audit.record({
          userId,
          module: "products",
          action: "create_price_draft",
          entity: "ProductPricePeriod",
          entityId: period.id,
          after: period,
          reason: input.observation ?? undefined
        }, tx);
        return period;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwPriceWriteConflict(error);
    }
  }

  async approvePricePeriod(productId: string, priceId: string, payload: unknown, user?: CurrentUser) {
    const command = productPriceApprovalSchema.parse(payload);
    const approverId = this.requireActorId(user);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.productPricePeriod.findFirst({ where: { id: priceId, productId } });
        if (!current) throw new NotFoundException("Periodo de preco nao encontrado.");
        assertCurrentVersion(current.recordVersion, command.recordVersion);
        if (current.status !== "DRAFT") {
          throw new BadRequestException(`Periodo em estado ${current.status} nao permite aprovacao.`);
        }
        if (!current.responsibleBy || !current.currency || !current.origin) {
          throw new BadRequestException("Preco legado ou incompleto exige novo rascunho com moeda, origem e responsavel.");
        }
        if (current.responsibleBy === approverId) {
          throw new ForbiddenException("Responsavel pelo preco nao pode aprovar o proprio registro.");
        }
        const overlappingApproved = await tx.productPricePeriod.findFirst({
          where: {
            id: { not: priceId },
            productId,
            status: "APPROVED",
            startsOn: current.endsOn ? { lte: current.endsOn } : undefined,
            OR: [{ endsOn: null }, { endsOn: { gte: current.startsOn } }]
          }
        });
        if (overlappingApproved) {
          throw new BadRequestException("A vigencia se sobrepoe a outro preco aprovado deste produto.");
        }
        const approved = await tx.productPricePeriod.update({
          where: { id: priceId, recordVersion: command.recordVersion },
          data: {
            status: "APPROVED",
            approvedAt: new Date(),
            approvedBy: approverId,
            approvalReason: command.reason,
            recordVersion: { increment: 1 }
          }
        });
        await this.audit.record({
          userId: approverId,
          module: "products",
          action: "approve_price",
          entity: "ProductPricePeriod",
          entityId: priceId,
          before: current,
          after: approved,
          reason: command.reason
        }, tx);
        return approved;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwPriceWriteConflict(error);
    }
  }

  async retirePricePeriod(productId: string, priceId: string, payload: unknown, user?: CurrentUser) {
    const command = productPriceRetirementSchema.parse(payload);
    const actorId = this.requireActorId(user);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.productPricePeriod.findFirst({ where: { id: priceId, productId } });
        if (!current) throw new NotFoundException("Periodo de preco nao encontrado.");
        assertCurrentVersion(current.recordVersion, command.recordVersion);
        if (!(["DRAFT", "APPROVED"] as string[]).includes(current.status)) {
          throw new BadRequestException(`Periodo em estado ${current.status} nao permite aposentadoria.`);
        }
        const retired = await tx.productPricePeriod.update({
          where: { id: priceId, recordVersion: command.recordVersion },
          data: {
            status: "RETIRED",
            retiredAt: new Date(),
            retiredBy: actorId,
            retirementReason: command.reason,
            recordVersion: { increment: 1 }
          }
        });
        await this.audit.record({
          userId: actorId,
          module: "products",
          action: "retire_price",
          entity: "ProductPricePeriod",
          entityId: priceId,
          before: current,
          after: retired,
          reason: command.reason
        }, tx);
        return retired;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwPriceWriteConflict(error);
    }
  }

  async deactivate(id: string, user?: CurrentUser) {
    const current = await this.prisma.product.findUnique({ where: { id }, include: { weightConfig: true } });
    if (!current) throw new NotFoundException("Produto nao encontrado.");
    const userId = this.safeUserId(user);
    const product = await this.prisma.product.update({
      where: { id },
      data: { active: false, updatedBy: userId },
      include: { defaultSector: true, weightConfig: true }
    });
    await this.audit.record({ userId, module: "products", action: "deactivate", entity: "Product", entityId: id, before: current, after: product });
    return product;
  }

  async activate(id: string, user?: CurrentUser) {
    const current = await this.prisma.product.findUnique({ where: { id }, include: { weightConfig: true } });
    if (!current || current.deletedAt) throw new NotFoundException("Produto nao encontrado.");
    const userId = this.safeUserId(user);
    const product = await this.prisma.product.update({
      where: { id },
      data: { active: true, updatedBy: userId },
      include: { defaultSector: true, weightConfig: true }
    });
    await this.audit.record({ userId, module: "products", action: "activate", entity: "Product", entityId: id, before: current, after: product });
    return product;
  }

  async remove(id: string, user?: CurrentUser) {
    const current = await this.prisma.product.findUnique({ where: { id }, include: { weightConfig: true } });
    if (!current || current.deletedAt) throw new NotFoundException("Produto nao encontrado.");
    const userId = this.safeUserId(user);
    const product = await this.prisma.product.update({
      where: { id },
      data: { active: false, deletedAt: new Date(), updatedBy: userId },
      include: { defaultSector: true, weightConfig: true }
    });
    await this.audit.record({ userId, module: "products", action: "delete", entity: "Product", entityId: id, before: current, after: product });
    return product;
  }

  async restore(id: string, user?: CurrentUser) {
    const current = await this.prisma.product.findUnique({ where: { id }, include: { weightConfig: true } });
    if (!current || !current.deletedAt) throw new NotFoundException("Produto removido nao encontrado.");
    const userId = this.safeUserId(user);
    const product = await this.prisma.product.update({
      where: { id },
      data: { deletedAt: null, active: false, updatedBy: userId },
      include: { defaultSector: true, weightConfig: true }
    });
    await this.audit.record({ userId, module: "products", action: "restore", entity: "Product", entityId: id, before: current, after: product });
    return product;
  }

  private throwPriceWriteConflict(error: unknown): never {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    let text = error instanceof Error ? error.message : "";
    if (error && typeof error === "object") {
      try {
        text += ` ${JSON.stringify(error)}`;
      } catch {
        // Keep the original error text when driver metadata is not serializable.
      }
    }
    if (code === "P2004" || /\b23P01\b/.test(text) || text.includes("product_price_periods_no_approved_date_overlap")) {
      throw new ConflictException("Outra versao de preco aprovada ocupa esta vigencia. Recarregue e revise o periodo.");
    }
    if (["P2002", "P2025", "P2034"].includes(code)) {
      throw new ConflictException("Preco foi alterado por outro usuario. Recarregue os dados e tente novamente.");
    }
    throw error;
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
