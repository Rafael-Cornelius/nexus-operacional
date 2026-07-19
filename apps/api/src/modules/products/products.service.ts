import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { productPricePeriodSchema, productSchema } from "../../domain/validators/schemas";
import { AuditService } from "../audit/audit.service";
import { CurrentUser } from "../../infrastructure/security/current-user";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  list(query: { active?: string; search?: string }) {
    return this.prisma.product.findMany({
      where: {
        deletedAt: null,
        active: query.active === undefined ? undefined : query.active === "true",
        OR: query.search
          ? [
              { code: { contains: query.search, mode: "insensitive" } },
              { name: { contains: query.search, mode: "insensitive" } }
            ]
          : undefined
      },
      include: { defaultSector: true, weightConfig: true },
      orderBy: [{ active: "desc" }, { code: "asc" }]
    });
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
        pricePerKg: input.pricePerKg,
        filmCostPerKg: input.filmCostPerKg,
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

    const product = await this.prisma.product.update({
      where: { id },
      data: {
        code: input.code,
        name: input.name,
        defaultSectorId: sector?.id,
        unit: input.unit,
        pricePerKg: input.pricePerKg,
        filmCostPerKg: input.filmCostPerKg,
        packageFilmWeightG: input.packageFilmWeightG,
        notes: input.notes,
        updatedBy: userId,
        weightConfig: input.boxWeightKg
          ? {
              upsert: {
                create: {
                  packageWeightKg: input.packageWeightKg ?? 0,
                  boxWeightKg: input.boxWeightKg,
                  packagesPerBox: input.packagesPerBox ?? 1,
                  massWeightKg: input.massWeightKg ?? 0,
                  targetPackageWeightG: input.targetPackageWeightG ?? 1,
                  overweightTolerancePercent: input.overweightTolerancePercent ?? 0.02,
                  formula: input.formula ?? "BOX_WEIGHT"
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

  pricePeriods(productId: string) {
    return this.prisma.productPricePeriod.findMany({
      where: { productId },
      orderBy: { startsOn: "desc" }
    });
  }

  async addPricePeriod(productId: string, payload: unknown, user?: CurrentUser) {
    const input = productPricePeriodSchema.parse(payload);
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.deletedAt) throw new NotFoundException("Produto nao encontrado.");

    const overlapping = await this.prisma.productPricePeriod.findFirst({
      where: {
        productId,
        startsOn: input.endsOn ? { lte: input.endsOn } : undefined,
        OR: [{ endsOn: null }, { endsOn: { gte: input.startsOn } }]
      }
    });
    if (overlapping) {
      throw new BadRequestException("O periodo de preco se sobrepoe a uma vigencia existente deste produto.");
    }

    const period = await this.prisma.productPricePeriod.create({
      data: { productId, ...input }
    });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (input.startsOn <= today && (!input.endsOn || input.endsOn >= today)) {
      await this.prisma.product.update({
        where: { id: productId },
        data: {
          pricePerKg: input.pricePerKg,
          filmCostPerKg: input.filmCostPerKg,
          updatedBy: this.safeUserId(user)
        }
      });
    }
    await this.audit.record({
      userId: this.safeUserId(user),
      module: "products",
      action: "add_price_period",
      entity: "ProductPricePeriod",
      entityId: period.id,
      after: period
    });
    return period;
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

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
