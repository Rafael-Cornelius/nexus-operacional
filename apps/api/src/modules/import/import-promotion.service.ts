import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional
} from "@nestjs/common";
import { ImportStagingClassification, Prisma } from "@prisma/client";
import { calculateDowntime } from "../../domain/calculations/downtime-calculations";
import { calculatePackagingLoss, calculateProductionCosts } from "../../domain/calculations/financial-calculations";
import { calculateProductionEntry } from "../../domain/calculations/production-calculations";
import { mergeCalculationRuleVersions } from "../../domain/calculations/rule-registry";
import { assertDateWithinWeek, assertWeekWritable } from "../../domain/weeks/week-rules";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { RequestContextService } from "../../infrastructure/request-context/request-context.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";
import { isPromotionBlocker } from "./import-staging-policy";
import { ImportStagingService } from "./import-staging.service";
import { xlsxImporterVersion } from "./import-version";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const importerVersion = xlsxImporterVersion;

interface ProductValue {
  code: string;
  name: string;
  defaultSector: "P1" | "P2";
  packageWeightKg: number;
  boxWeightKg: number;
  packagesPerBox: number;
  massWeightKg: number;
  targetPackageWeightG: number;
  unit: string;
  overweightTolerancePercent: number;
  formula: "BOX_WEIGHT" | "PACKAGE_WEIGHT";
  active: boolean;
  pricePerKg?: number | null;
}

interface ProductionValue {
  sector: "P1" | "P2";
  legacyWeekNumber: number;
  date: string;
  productCode: string;
  productionOrder: string;
  plannedBatches: number;
  realizedBatches: number;
  usedReworkKg: number;
  packedBoxes: number;
  weighingLossKg: number;
  generatedReworkKg: number;
  averagePackageWeightG?: number | null;
  notes?: string | null;
  pricePerKg?: number;
}

interface LossValue {
  date: string;
  quantityKg: number;
  filmShift1Kg: number;
  filmShift2Kg: number;
  boxLossUnits: number;
  boxLossShift1Units: number;
  boxLossShift2Units: number;
  sector: "P1" | "P2";
  productCode: string;
  legacyLine: string;
  lossType: "PACKAGING";
  notes?: string | null;
}

interface DowntimeValue {
  sector: "P1" | "P2";
  lineId: string;
  downtimeReasonId: string;
  date: string;
  productionStartDate?: string | null;
  productionEndDate?: string | null;
  downtimeStartDate?: string | null;
  downtimeEndDate?: string | null;
  productionStart: string;
  productionEnd: string;
  downtimeStart: string;
  downtimeEnd: string;
  reason: string;
  legacyLine: string;
  legacyWeekNumber?: number | null;
  producedMassKg: number;
}

interface Metrics {
  productionRows: number;
  plannedBatches: number;
  realizedBatches: number;
  packedBoxes: number;
  usedReworkKg: number;
  generatedReworkKg: number;
  productionKg: number;
  weighingLossKg: number;
  overweightKg: number;
  lossRows: number;
  registeredLossKg: number;
  filmShift1Kg: number;
  filmShift2Kg: number;
  boxLossUnits: number;
  boxLossShift1Units: number;
  boxLossShift2Units: number;
  downtimeRows: number;
  downtimeMinutes: number;
}

interface Totals extends Metrics {
  bySector: Record<"P1" | "P2", Metrics>;
}

@Injectable()
export class ImportPromotionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly staging: ImportStagingService,
    @Optional() private readonly requestContext?: RequestContextService
  ) {}

  async promote(batchId: string, user?: CurrentUser) {
    if (!uuidPattern.test(batchId)) throw new BadRequestException("Lote de importacao invalido.");
    const userId = this.safeUserId(user);
    if (!userId) throw new BadRequestException("Usuario autenticado invalido para promover staging.");
    try {
      return await this.prisma.$transaction(
        async (tx) => this.promoteTransaction(tx, batchId, userId),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 }
      );
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException) {
        throw error;
      }
      await this.prisma.importBatch.updateMany({
        where: { id: batchId, status: { notIn: ["IMPORTED", "IMPORTED_WITH_ERRORS", "CERTIFIED", "LEGACY_CERTIFIED"] } },
        data: { status: "FAILED", completedAt: new Date() }
      }).catch(() => undefined);
      await this.audit.record({
        userId,
        module: "import",
        action: "promote_staging_batch_failed",
        entity: "ImportBatch",
        entityId: batchId,
        after: {
          rollback: "integral",
          error: error instanceof Error ? error.message.slice(0, 400) : "unknown"
        }
      }).catch(() => undefined);
      throw new InternalServerErrorException("Promocao falhou; transacao revertida integralmente.");
    }
  }

  private async promoteTransaction(tx: Prisma.TransactionClient, batchId: string, userId?: string) {
    const batch = await tx.importBatch.findUnique({
      where: { id: batchId },
      include: { stagingRecords: { orderBy: { createdAt: "asc" } } }
    });
    if (!batch) throw new NotFoundException("Lote de importacao nao encontrado.");
    if (["IMPORTED", "IMPORTED_WITH_ERRORS", "CERTIFIED"].includes(batch.status)) {
      return {
        id: batch.id,
        status: batch.status,
        summary: batch.summary,
        promotedAt: batch.promotedAt,
        idempotent: true
      };
    }
    if (batch.status === "LEGACY_CERTIFIED") {
      throw new ConflictException("Lote certificado pelo contrato legado e imutavel. Reenvie o XLSX em um novo lote para reprocessar com a rastreabilidade atual.");
    }
    if (!["STAGED", "FAILED"].includes(batch.status)) {
      throw new ConflictException("Lote nao esta pronto para promocao.");
    }
    if (!batch.stagingRecords.length) throw new ConflictException("Lote sem registros de staging. Reenvie o XLSX.");

    const blockers = batch.stagingRecords.filter(isPromotionBlocker);
    if (blockers.length) {
      const byClassification = Object.fromEntries(
        Object.values(ImportStagingClassification).map((classification) => [
          classification,
          blockers.filter((record) => record.classification === classification).length
        ])
      );
      throw new ConflictException({
        message: "Lote possui registros pendentes de revisao e nao pode ser promovido.",
        blockers: blockers.length,
        byClassification
      });
    }

    const locked = await tx.importBatch.updateMany({
      where: { id: batchId, status: { in: ["STAGED", "FAILED"] } },
      data: { status: "PROMOTING", promotionStartedAt: new Date(), completedAt: null }
    });
    if (locked.count !== 1) throw new ConflictException("Outro processo iniciou a promocao deste lote.");

    const promotableDomains = new Set(["PRODUCT", "PRODUCTION", "LOSS", "DOWNTIME"]);
    const selected = batch.stagingRecords.filter(
      (record) => !["IGNORED", "REJECTED"].includes(record.decision) && promotableDomains.has(record.domain)
    );
    if (!selected.length) throw new ConflictException("Nenhum registro aprovado para promocao.");
    for (const record of selected) {
      const value = record.correctedValue ?? record.interpretedValue;
      this.staging.assertDomainValue(record.domain, value);
    }

    const selectedProductValues = selected
      .filter((record) => record.domain === "PRODUCT")
      .map((record) => ({ record, value: this.value<ProductValue>(record) }));
    const productsByNormalizedCode = new Map<string, typeof selectedProductValues>();
    for (const candidate of selectedProductValues) {
      const normalizedCode = candidate.value.code.normalize("NFKC").trim().toUpperCase();
      productsByNormalizedCode.set(normalizedCode, [...(productsByNormalizedCode.get(normalizedCode) ?? []), candidate]);
    }
    const duplicateProductCodes = [...productsByNormalizedCode.entries()]
      .filter(([, candidates]) => candidates.length > 1)
      .map(([code]) => code);
    if (duplicateProductCodes.length) {
      throw new ConflictException(
        `Mais de um registro de staging resolve para o mesmo codigo de produto: ${duplicateProductCodes.join(", ")}. ` +
        "Rejeite a duplicata antes da promocao; nenhum registro oficial foi alterado."
      );
    }

    const operationalProductCodes = [...new Set(selected.flatMap((record) => {
      if (record.domain === "PRODUCTION") return [this.value<ProductionValue>(record).productCode];
      if (record.domain === "LOSS") return [this.value<LossValue>(record).productCode];
      return [];
    }))];
    if (operationalProductCodes.length) {
      const stagedInactiveCodes = selectedProductValues
        .filter((candidate) => !candidate.value.active && operationalProductCodes.includes(candidate.value.code))
        .map((candidate) => candidate.value.code);
      if (stagedInactiveCodes.length) {
        throw new ConflictException(
          `Produto(s) ${stagedInactiveCodes.join(", ")} seriam desativados e nao podem receber fatos no mesmo lote.`
        );
      }
      const existingOperationalProducts = await tx.product.findMany({
        where: { code: { in: operationalProductCodes } },
        select: { code: true, active: true, deletedAt: true }
      });
      const existingCodes = new Set(existingOperationalProducts.filter((product) => !product.deletedAt).map((product) => product.code));
      const missingCodes = operationalProductCodes.filter((code) => !existingCodes.has(code));
      if (missingCodes.length) {
        throw new ConflictException(
          `Produto(s) novo(s) ${missingCodes.join(", ")} possuem lancamentos operacionais no mesmo lote. ` +
          "Cadastre e revise o produto, crie um preco governado e obtenha aprovacao independente antes de promover o lote."
        );
      }
      const inactiveCodes = existingOperationalProducts
        .filter((product) => !product.deletedAt && !product.active)
        .map((product) => product.code);
      if (inactiveCodes.length) {
        throw new ConflictException(`Produto(s) inativo(s) ${inactiveCodes.join(", ")} nao podem receber lancamentos operacionais.`);
      }
    }

    const [p1, p2] = await Promise.all([
      tx.sector.upsert({
        where: { code: "P1" },
        create: { code: "P1", name: "P1 - Pao de Queijo" },
        update: {}
      }),
      tx.sector.upsert({
        where: { code: "P2" },
        create: { code: "P2", name: "P2 - Bolos e Churros" },
        update: {}
      })
    ]);
    let insertedProducts = 0;
    let updatedProducts = 0;
    let importedProduction = 0;
    let importedLosses = 0;
    let importedDowntime = 0;

    for (const record of selected.filter((item) => item.domain === "PRODUCT")) {
      const product = this.value<ProductValue>(record);
      const existing = await tx.product.findUnique({
        where: { code: product.code },
        include: { weightConfig: true }
      });
      const sector = product.defaultSector === "P2" ? p2 : p1;
      const saved = await tx.product.upsert({
        where: { code: product.code },
        create: {
          code: product.code,
          name: product.name,
          defaultSectorId: sector.id,
          unit: product.unit,
          active: product.active,
          notes: "Importado da planilha legada.",
          createdBy: userId,
          updatedBy: userId
        },
        update: {
          name: product.name,
          defaultSectorId: sector.id,
          unit: product.unit,
          active: product.active,
          notes: "Atualizado pela importacao revisada da planilha legada.",
          updatedBy: userId
        }
      });
      const savedWeightConfig = await tx.productWeightConfig.upsert({
        where: { productId: saved.id },
        create: {
          productId: saved.id,
          packageWeightKg: product.packageWeightKg,
          boxWeightKg: product.boxWeightKg,
          packagesPerBox: product.packagesPerBox,
          massWeightKg: product.massWeightKg,
          targetPackageWeightG: product.targetPackageWeightG,
          overweightTolerancePercent: product.overweightTolerancePercent,
          formula: product.formula
        },
        update: {
          packageWeightKg: product.packageWeightKg,
          boxWeightKg: product.boxWeightKg,
          packagesPerBox: product.packagesPerBox,
          massWeightKg: product.massWeightKg,
          targetPackageWeightG: product.targetPackageWeightG,
          overweightTolerancePercent: product.overweightTolerancePercent,
          formula: product.formula
        }
      });
      await this.audit.record({
        userId,
        module: "import",
        action: existing ? "update_imported_product" : "create_imported_product",
        entity: "Product",
        entityId: saved.id,
        before: existing ?? undefined,
        after: {
          product: saved,
          weightConfig: savedWeightConfig,
          stagingRecordId: record.id,
          sourceFingerprint: record.sourceFingerprint
        },
        reason: record.resolutionReason ?? "Promocao de cadastro revisado do staging."
      }, tx);
      await this.markPromoted(tx, record.id, saved.id);
      if (existing) updatedProducts += 1;
      else insertedProducts += 1;
    }

    const [products, packagingType] = await Promise.all([
      tx.product.findMany({ where: { deletedAt: null }, include: { weightConfig: true } }),
      tx.lossType.upsert({
        where: { code: "PACKAGING" },
        create: { code: "PACKAGING", name: "Embalagem" },
        update: {}
      })
    ]);
    const productsByCode = new Map(products.map((product) => [product.code, product]));
    const totals = this.emptyTotals();

    for (const record of selected.filter((item) => item.domain === "PRODUCTION")) {
      const row = this.value<ProductionValue>(record);
      const product = productsByCode.get(row.productCode);
      if (!product?.weightConfig) {
        throw new ConflictException("Produto " + row.productCode + " nao existe ou nao possui configuracao de peso.");
      }
      const config = product.weightConfig;
      const calculated = calculateProductionEntry({
        sector: row.sector,
        plannedBatches: row.plannedBatches,
        realizedBatches: row.realizedBatches,
        usedReworkKg: row.usedReworkKg,
        packedBoxes: row.packedBoxes,
        weighingLossKg: row.weighingLossKg,
        generatedReworkKg: row.generatedReworkKg,
        averagePackageWeightG: row.averagePackageWeightG,
        weightConfig: {
          formula: config.formula,
          packageWeightKg: Number(config.packageWeightKg),
          boxWeightKg: Number(config.boxWeightKg),
          packagesPerBox: config.packagesPerBox,
          massWeightKg: Number(config.massWeightKg),
          targetPackageWeightG: Number(config.targetPackageWeightG),
          overweightTolerancePercent: Number(config.overweightTolerancePercent)
        }
      });
      const rawRealYieldPercent = calculated.expectedYieldKg > 0
        ? calculated.producedKg / calculated.expectedYieldKg
        : null;
      const calculationIssues = [...calculated.inconsistencies];
      if (row.sector === "P1") {
        calculationIssues.push(
          "Regras de rendimento e perdas derivadas do P1 aguardam homologacao e exigem aprovacao humana."
        );
      }
      if (rawRealYieldPercent !== null && rawRealYieldPercent > 1) {
        calculationIssues.push("Rendimento acima de 100%; registro exige revisao humana antes da promocao.");
      }
      if (calculationIssues.length && record.decision !== "APPROVED") {
        throw new ConflictException(
          "Producao ainda possui anomalia calculada e exige aprovacao explicita: " + calculationIssues.join(" ")
        );
      }
      const week = await this.ensureWeek(tx, row.date, row.legacyWeekNumber);
      const date = new Date(row.date + "T00:00:00.000Z");
      const collision = await tx.productionEntry.findFirst({
        where: {
          weekId: week.id,
          productId: product.id,
          productionOrder: row.productionOrder,
          date,
          deletedAt: null
        },
        select: { id: true }
      });
      if (collision) throw new ConflictException("Producao oficial ja existe: " + row.productionOrder + ".");
      const pricePeriod = await tx.productPricePeriod.findFirst({
        where: {
          productId: product.id,
          status: "APPROVED",
          startsOn: { lte: date },
          OR: [{ endsOn: null }, { endsOn: { gte: date } }]
        },
        orderBy: [{ startsOn: "desc" }, { version: "desc" }]
      });
      if (!pricePeriod || Number(pricePeriod.pricePerKg) <= 0 || !pricePeriod.origin || !pricePeriod.currency) {
        throw new ConflictException(
          "Producao " + row.productionOrder + " exige preco APPROVED vigente, com origem e moeda; preco da planilha nao e promovido automaticamente."
        );
      }
      const price = Number(pricePeriod.pricePerKg);
      const costs = calculateProductionCosts({
        producedKg: calculated.producedKg,
        weighingLossKg: row.weighingLossKg,
        overweightKg: calculated.overweightTotalKg,
        pricePerKg: price
      });
      const sector = row.sector === "P2" ? p2 : p1;
      const order = await tx.productionOrder.upsert({
        where: {
          weekId_orderNumber_productId: {
            weekId: week.id,
            orderNumber: row.productionOrder,
            productId: product.id
          }
        },
        create: {
          weekId: week.id,
          productId: product.id,
          sectorCode: row.sector,
          orderNumber: row.productionOrder
        },
        update: {}
      });
      const entry = await tx.productionEntry.create({
        data: {
          weekId: week.id,
          sectorId: sector.id,
          importBatchId: batchId,
          productId: product.id,
          pricePeriodId: pricePeriod.id,
          priceVersion: pricePeriod.version,
          priceOrigin: pricePeriod.origin,
          priceCurrency: pricePeriod.currency,
          productionOrderId: order.id,
          date,
          productionOrder: row.productionOrder,
          plannedBatches: row.plannedBatches,
          realizedBatches: row.realizedBatches,
          usedReworkKg: row.usedReworkKg,
          packedBoxes: row.packedBoxes,
          producedKg: calculated.producedKg,
          weighingLossKg: row.weighingLossKg,
          generatedReworkKg: row.generatedReworkKg,
          expectedYieldKg: calculated.expectedYieldKg,
          realYieldPercent: calculated.realYieldPercent,
          massWeightKg: config.massWeightKg,
          boxWeightKg: config.boxWeightKg,
          targetPackageWeightG: config.targetPackageWeightG,
          averagePackageWeightG: row.averagePackageWeightG,
          overweightGPerPackage: calculated.overweightGPerPackage,
          overweightTotalKg: calculated.overweightTotalKg,
          overweightPercent: calculated.overweightPercent,
          unitPricePerKg: costs.unitPricePerKg,
          productionCost: costs.productionCost,
          lossesCost: costs.lossesCost,
          overweightCost: costs.overweightCost,
          calculationRuleVersions: {
            ...mergeCalculationRuleVersions(
              calculated.calculationRuleVersions,
              costs.calculationRuleVersions
            )
          },
          status: calculationIssues.length ? "ATTENTION" : "OK",
          workflowStatus: "DRAFT",
          notes: [
            row.notes,
            "Importacao revisada da planilha legada.",
            calculationIssues.length
              ? "Anomalias aprovadas na importacao: " + calculationIssues.join(" ")
              : null
          ].filter(Boolean).join("\n"),
          createdBy: userId,
          updatedBy: userId
        }
      });
      await this.markPromoted(tx, record.id, entry.id);
      this.addProductionTotals(totals, row, calculated.producedKg, calculated.overweightTotalKg);
      importedProduction += 1;
    }

    for (const record of selected.filter((item) => item.domain === "LOSS")) {
      const row = this.value<LossValue>(record);
      const product = productsByCode.get(row.productCode);
      if (!product) throw new ConflictException("Produto " + row.productCode + " nao existe para a perda revisada.");
      const week = await this.existingWeekForDate(tx, row.date);
      const date = new Date(row.date + "T00:00:00.000Z");
      const pricePeriod = await tx.productPricePeriod.findFirst({
        where: {
          productId: product.id,
          status: "APPROVED",
          startsOn: { lte: date },
          OR: [{ endsOn: null }, { endsOn: { gte: date } }]
        },
        orderBy: [{ startsOn: "desc" }, { version: "desc" }]
      });
      if (!pricePeriod || Number(pricePeriod.filmCostPerKg) <= 0 || !pricePeriod.origin || !pricePeriod.currency) {
        throw new ConflictException(
          "Perda de " + row.productCode + " exige custo de filme positivo em preco APPROVED vigente, com origem e moeda."
        );
      }
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${"import-loss:" + record.sourceFingerprint}, 0))
      `);
      const collision = await tx.importStagingRecord.findFirst({
        where: {
          id: { not: record.id },
          domain: "LOSS",
          sourceFingerprint: record.sourceFingerprint,
          promotedEntityId: { not: null },
          batch: { status: { in: ["IMPORTED", "IMPORTED_WITH_ERRORS", "CERTIFIED", "LEGACY_CERTIFIED"] } }
        },
        select: { promotedEntityId: true }
      });
      if (collision) throw new ConflictException("Esta mesma linha de origem de perda ja foi promovida em outro lote.");
      const unitCost = Number(pricePeriod.filmCostPerKg);
      const lossFinancials = calculatePackagingLoss({ quantityKg: row.quantityKg, unitCost });
      const sector = row.sector === "P2" ? p2 : p1;
      const entry = await tx.lossEntry.create({
        data: {
          weekId: week.id,
          date,
          sectorId: sector.id,
          productId: product.id,
          pricePeriodId: pricePeriod.id,
          priceVersion: pricePeriod.version,
          priceOrigin: pricePeriod.origin,
          priceCurrency: pricePeriod.currency,
          importBatchId: batchId,
          lossTypeId: packagingType.id,
          quantityKg: row.quantityKg,
          filmShift1Kg: row.filmShift1Kg,
          filmShift2Kg: row.filmShift2Kg,
          boxLossUnits: row.boxLossUnits,
          boxLossShift1Units: row.boxLossShift1Units,
          boxLossShift2Units: row.boxLossShift2Units,
          unitCost,
          lossCost: lossFinancials.lossCost,
          calculationRuleVersions: { ...lossFinancials.lossCostCalculationRuleVersions },
          reason: row.legacyLine,
          notes: row.notes ?? "Importacao revisada da planilha legada.",
          workflowStatus: "DRAFT",
          createdBy: userId,
          updatedBy: userId
        }
      });
      await this.markPromoted(tx, record.id, entry.id);
      totals.lossRows += 1;
      totals.registeredLossKg += row.quantityKg;
      totals.filmShift1Kg += row.filmShift1Kg;
      totals.filmShift2Kg += row.filmShift2Kg;
      totals.boxLossUnits += row.boxLossUnits;
      totals.boxLossShift1Units += row.boxLossShift1Units;
      totals.boxLossShift2Units += row.boxLossShift2Units;
      totals.bySector[row.sector].lossRows += 1;
      totals.bySector[row.sector].registeredLossKg += row.quantityKg;
      totals.bySector[row.sector].filmShift1Kg += row.filmShift1Kg;
      totals.bySector[row.sector].filmShift2Kg += row.filmShift2Kg;
      totals.bySector[row.sector].boxLossUnits += row.boxLossUnits;
      totals.bySector[row.sector].boxLossShift1Units += row.boxLossShift1Units;
      totals.bySector[row.sector].boxLossShift2Units += row.boxLossShift2Units;
      importedLosses += 1;
    }

    for (const record of selected.filter((item) => item.domain === "DOWNTIME")) {
      const row = this.value<DowntimeValue>(record);
      const timestamp = (time: string, dateValue?: string | null) =>
        new Date((dateValue ?? row.date) + "T" + time + ".000Z");
      const calculated = calculateDowntime({
        productionStart: timestamp(row.productionStart, row.productionStartDate),
        productionEnd: timestamp(row.productionEnd, row.productionEndDate),
        downtimeStart: timestamp(row.downtimeStart, row.downtimeStartDate),
        downtimeEnd: timestamp(row.downtimeEnd, row.downtimeEndDate),
        producedMassKg: row.producedMassKg
      });
      const downtimeIssues = [...calculated.inconsistencies];
      if (timestamp(row.downtimeStart, row.downtimeStartDate) < timestamp(row.productionStart, row.productionStartDate) ||
          timestamp(row.downtimeEnd, row.downtimeEndDate) > timestamp(row.productionEnd, row.productionEndDate)) {
        downtimeIssues.push("Intervalo de parada esta fora da janela de producao e exige revisao.");
      }
      if (downtimeIssues.length && record.decision !== "APPROVED") {
        throw new ConflictException(
          "Parada ainda possui anomalia calculada e exige aprovacao explicita: " + downtimeIssues.join(" ")
        );
      }
      const week = await this.existingWeekForDate(tx, row.date);
      const sector = row.sector === "P2" ? p2 : p1;
      const [line, reason] = await Promise.all([
        tx.productionLine.findFirst({
          where: { id: row.lineId, sectorId: sector.id, active: true, deletedAt: null }
        }),
        tx.downtimeReason.findFirst({
          where: { id: row.downtimeReasonId, active: true }
        })
      ]);
      if (!line) {
        throw new ConflictException("Linha oficial ativa da parada nao foi encontrada no setor revisado. Corrija o lineId no staging.");
      }
      if (!reason) {
        throw new ConflictException("Motivo oficial ativo da parada nao foi encontrado. Corrija o downtimeReasonId no staging.");
      }
      const productionStart = timestamp(row.productionStart, row.productionStartDate);
      const productionEnd = timestamp(row.productionEnd, row.productionEndDate);
      const downtimeStart = timestamp(row.downtimeStart, row.downtimeStartDate);
      const downtimeEnd = timestamp(row.downtimeEnd, row.downtimeEndDate);
      for (const instant of [productionStart, productionEnd, downtimeStart, downtimeEnd]) {
        assertDateWithinWeek(instant, week, "Todos os horarios da parada importada devem pertencer a semana revisada.");
      }
      const overlapping = await tx.downtimeEntry.findFirst({
        where: {
          lineId: line.id,
          deletedAt: null,
          downtimeStart: { lt: downtimeEnd },
          downtimeEnd: { gt: downtimeStart }
        },
        select: { id: true }
      });
      if (overlapping) throw new ConflictException("Intervalo de parada sobrepoe registro oficial da linha.");
      const entry = await tx.downtimeEntry.create({
        data: {
          weekId: week.id,
          date: new Date(row.date + "T00:00:00.000Z"),
          sectorId: sector.id,
          lineId: line.id,
          importBatchId: batchId,
          productionStart,
          productionEnd,
          producedMassKg: row.producedMassKg,
          downtimeStart,
          downtimeEnd,
          stoppedMinutes: calculated.stoppedMinutes,
          stoppedPercent: calculated.stoppedPercent,
          realKgHour: calculated.realKgHour,
          possibleKgHour: calculated.possibleKgHour,
          calculationRuleVersions: { ...calculated.calculationRuleVersions },
          status: calculated.status,
          downtimeReasonId: reason.id,
          notes: [
            "Importado da planilha legada (" + row.legacyLine + ").",
            downtimeIssues.length ? "Anomalias aprovadas na importacao: " + downtimeIssues.join(" ") : null
          ].filter(Boolean).join("\n"),
          workflowStatus: "DRAFT",
          createdBy: userId,
          updatedBy: userId
        }
      });
      await this.markPromoted(tx, record.id, entry.id);
      totals.downtimeRows += 1;
      totals.downtimeMinutes += calculated.stoppedMinutes;
      totals.bySector[row.sector].downtimeRows += 1;
      totals.bySector[row.sector].downtimeMinutes += calculated.stoppedMinutes;
      importedDowntime += 1;
    }

    const excluded = batch.stagingRecords.filter((record) => ["IGNORED", "REJECTED"].includes(record.decision)).length;
    const pendingErrors = await tx.importError.count({ where: { batchId, status: "PENDING" } });
    if (pendingErrors) throw new ConflictException("Lote ainda possui inconsistencias sem resolucao.");
    const normalizedTotals = this.roundTotals(totals);
    const previousSummary = this.jsonObject(batch.summary);
    const status = excluded ? "IMPORTED_WITH_ERRORS" : "IMPORTED";
    const promotedAt = new Date();
    const summary: Prisma.InputJsonObject = {
      ...previousSummary,
      importedProducts: insertedProducts + updatedProducts,
      insertedProducts,
      updatedProducts,
      importedProduction,
      importedLosses,
      importedDowntime,
      excludedStagingRecords: excluded,
      sourceTotals: normalizedTotals,
      stagingTotals: normalizedTotals,
      promotion: {
        importerVersion,
        selectedRecords: selected.length,
        excludedRecords: excluded,
        promotedAt: promotedAt.toISOString()
      }
    };
    const updated = await tx.importBatch.update({
      where: { id: batchId },
      data: {
        status,
        summary,
        completedAt: promotedAt,
        promotedAt,
        promotedBy: userId,
        importerVersion
      }
    });
    await tx.auditLog.create({
      data: {
        userId,
        module: "import",
        action: "promote_staging_batch",
        entity: "ImportBatch",
        entityId: batchId,
        before: { status: batch.status, stagingRecords: batch.stagingRecords.length },
        after: {
          status,
          insertedProducts,
          updatedProducts,
          importedProduction,
          importedLosses,
          importedDowntime,
          excluded,
          importerVersion
        },
        ipAddress: this.requestContext?.current()?.ipAddress,
        userAgent: this.requestContext?.current()?.userAgent,
        correlationId: this.requestContext?.current()?.correlationId,
        requestOrigin: this.requestContext?.current()?.requestOrigin,
        deviceId: this.requestContext?.current()?.deviceId,
        appVersion: this.requestContext?.current()?.appVersion
      }
    });
    return {
      id: updated.id,
      status: updated.status,
      summary: updated.summary,
      promotedAt: updated.promotedAt,
      idempotent: false
    };
  }

  private value<T>(record: { correctedValue: unknown; interpretedValue: unknown }) {
    return (record.correctedValue ?? record.interpretedValue) as T;
  }

  private markPromoted(tx: Prisma.TransactionClient, id: string, promotedEntityId: string) {
    return tx.importStagingRecord.update({
      where: { id },
      data: { promotedEntityId, promotedAt: new Date() }
    });
  }

  private emptyMetrics(): Metrics {
    return {
      productionRows: 0,
      plannedBatches: 0,
      realizedBatches: 0,
      packedBoxes: 0,
      usedReworkKg: 0,
      generatedReworkKg: 0,
      productionKg: 0,
      weighingLossKg: 0,
      overweightKg: 0,
      lossRows: 0,
      registeredLossKg: 0,
      filmShift1Kg: 0,
      filmShift2Kg: 0,
      boxLossUnits: 0,
      boxLossShift1Units: 0,
      boxLossShift2Units: 0,
      downtimeRows: 0,
      downtimeMinutes: 0
    };
  }

  private emptyTotals(): Totals {
    return { ...this.emptyMetrics(), bySector: { P1: this.emptyMetrics(), P2: this.emptyMetrics() } };
  }

  private addProductionTotals(totals: Totals, row: ProductionValue, producedKg: number, overweightKg: number) {
    const add = (metrics: Metrics) => {
      metrics.productionRows += 1;
      metrics.plannedBatches += row.plannedBatches;
      metrics.realizedBatches += row.realizedBatches;
      metrics.packedBoxes += row.packedBoxes;
      metrics.usedReworkKg += row.usedReworkKg;
      metrics.generatedReworkKg += row.generatedReworkKg;
      metrics.productionKg += producedKg;
      metrics.weighingLossKg += row.weighingLossKg;
      metrics.overweightKg += overweightKg;
    };
    add(totals);
    add(totals.bySector[row.sector]);
  }

  private roundTotals(totals: Totals): Prisma.InputJsonObject {
    const round = (value: number) => Math.round((value + Number.EPSILON) * 1_000) / 1_000;
    const normalize = (metrics: Metrics): Prisma.InputJsonObject => ({
      ...metrics,
      plannedBatches: round(metrics.plannedBatches),
      realizedBatches: round(metrics.realizedBatches),
      packedBoxes: round(metrics.packedBoxes),
      usedReworkKg: round(metrics.usedReworkKg),
      generatedReworkKg: round(metrics.generatedReworkKg),
      productionKg: round(metrics.productionKg),
      weighingLossKg: round(metrics.weighingLossKg),
      overweightKg: round(metrics.overweightKg),
      registeredLossKg: round(metrics.registeredLossKg),
      filmShift1Kg: round(metrics.filmShift1Kg),
      filmShift2Kg: round(metrics.filmShift2Kg),
      boxLossUnits: round(metrics.boxLossUnits),
      boxLossShift1Units: round(metrics.boxLossShift1Units),
      boxLossShift2Units: round(metrics.boxLossShift2Units),
      downtimeMinutes: round(metrics.downtimeMinutes)
    });
    return { ...normalize(totals), bySector: { P1: normalize(totals.bySector.P1), P2: normalize(totals.bySector.P2) } };
  }

  private jsonObject(value: unknown): Prisma.InputJsonObject {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Prisma.InputJsonObject
      : {};
  }

  private async existingWeekForDate(tx: Prisma.TransactionClient, dateValue: string) {
    const date = new Date(dateValue + "T00:00:00.000Z");
    if (Number.isNaN(date.getTime())) throw new BadRequestException("Data invalida na importacao: " + dateValue + ".");
    const week = await tx.weeklyPeriod.findFirst({
      where: { deletedAt: null, startsOn: { lte: date }, endsOn: { gte: date } }
    });
    if (!week) {
      throw new ConflictException(
        "Cadastre e revise a semana operacional que contem " + dateValue + " antes de promover perdas ou paradas."
      );
    }
    assertWeekWritable(week, "A semana " + week.label + " nao aceita importacao operacional.");
    return week;
  }

  private async ensureWeek(tx: Prisma.TransactionClient, dateValue: string, legacyWeekNumber: number) {
    const date = new Date(dateValue + "T00:00:00.000Z");
    if (Number.isNaN(date.getTime())) throw new BadRequestException("Data invalida na importacao: " + dateValue + ".");
    const existingForDate = await tx.weeklyPeriod.findFirst({
      where: { deletedAt: null, startsOn: { lte: date }, endsOn: { gte: date } }
    });
    if (existingForDate) {
      assertWeekWritable(
        existingForDate,
        "A importacao nao pode alterar a semana " + existingForDate.label + ", pois ela esta " + existingForDate.status + "."
      );
      return existingForDate;
    }
    const day = date.getUTCDay() || 7;
    const startsOn = new Date(date);
    startsOn.setUTCDate(date.getUTCDate() - day + 1);
    const endsOn = new Date(startsOn);
    endsOn.setUTCDate(startsOn.getUTCDate() + 6);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const weekNumber = Math.min(Math.max(Math.trunc(legacyWeekNumber) || 1, 1), 6);
    const [sameKey, overlapping] = await Promise.all([
      tx.weeklyPeriod.findUnique({ where: { year_month_weekNumber: { year, month, weekNumber } } }),
      tx.weeklyPeriod.findFirst({ where: { deletedAt: null, startsOn: { lte: endsOn }, endsOn: { gte: startsOn } } })
    ]);
    if (sameKey) throw new ConflictException("Chave semanal ja pertence a outro periodo.");
    if (overlapping) throw new ConflictException("Periodo calculado sobrepoe semana oficial existente.");
    return tx.weeklyPeriod.create({
      data: { year, month, weekNumber, label: "Semana " + weekNumber, startsOn, endsOn }
    });
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
