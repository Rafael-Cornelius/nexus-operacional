import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { calculateProductionEntry } from "../../domain/calculations/production-calculations";
import { calculateProductionCosts } from "../../domain/calculations/financial-calculations";
import { calculateDowntime } from "../../domain/calculations/downtime-calculations";
import { assertWeekWritable } from "../../domain/weeks/week-rules";
import {
  importUploadLimitBytes,
  workbookProcessLimits,
  workbookSecurityLimits
} from "./import-security.config";

const execFileAsync = promisify(execFile);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const xlsxMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "application/octet-stream"
]);

export interface UploadedWorkbookFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
}

interface LegacyImportProduct {
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
  source?: unknown;
}

interface LegacyImportError {
  sheetName?: string | null;
  cell?: string | null;
  rowNumber?: number | null;
  field?: string | null;
  message: string;
  rawValue?: string | null;
}

interface LegacyProductionEntry {
  sheetName: string;
  rowNumber: number;
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

interface LegacyLossEntry {
  sheetName: string;
  rowNumber: number;
  date: string;
  quantityKg: number;
  legacyLine: string;
  lossType: "PACKAGING";
  notes?: string | null;
}

interface LegacyDowntimeEntry {
  sheetName: string;
  rowNumber: number;
  date: string;
  productionStart: string;
  productionEnd: string;
  downtimeStart: string;
  downtimeEnd: string;
  reason: string;
  legacyLine: string;
  legacyWeekNumber?: number | null;
}

interface ImportSourceMetrics {
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
  downtimeRows: number;
  downtimeMinutes: number;
}

interface ImportSourceTotals extends ImportSourceMetrics {
  bySector: Record<"P1" | "P2", ImportSourceMetrics>;
}

interface LegacyImportReport {
  file: string;
  sheetCount?: number;
  formulaCount?: number;
  tableCount?: number;
  chartCount?: number;
  errors?: Record<string, number>;
  legacyData?: {
    products?: LegacyImportProduct[];
    productCount?: number;
    duplicateProductCodes?: string[];
    duplicateWeightCodes?: string[];
    importErrors?: LegacyImportError[];
    importErrorCount?: number;
    productionEntries?: LegacyProductionEntry[];
    productionEntryCount?: number;
    lossEntries?: LegacyLossEntry[];
    lossEntryCount?: number;
    downtimeEntries?: LegacyDowntimeEntry[];
    downtimeEntryCount?: number;
    operationalImportErrors?: LegacyImportError[];
  };
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async preview(batchId?: string) {
    const batch = batchId
      ? await this.prisma.importBatch.findUnique({
          where: { id: batchId },
          include: { errors: { take: 100, orderBy: { createdAt: "asc" } } }
        })
      : await this.prisma.importBatch.findFirst({
          orderBy: { createdAt: "desc" },
          include: { errors: { take: 100, orderBy: { createdAt: "asc" } } }
        });

    if (!batch) {
      return {
        source: "Nenhuma planilha carregada",
        sheetCount: 0,
        formulaCount: 0,
        tableCount: 0,
        chartCount: 0,
        errors: {},
        importErrors: [],
        status: "NO_WORKBOOK"
      };
    }

    const summary = typeof batch.summary === "object" && batch.summary ? batch.summary : {};
    return {
      source: batch.originalFileName ?? batch.sourceFile,
      batchId: batch.id,
      status: batch.status,
      fileHash: batch.fileHash,
      fileSizeBytes: batch.fileSizeBytes?.toString() ?? null,
      ...summary,
      importErrors: batch.errors
    };
  }

  async uploadWorkbook(file: UploadedWorkbookFile | undefined, user?: CurrentUser) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("Arquivo XLSX nao enviado.");
    }
    this.assertSafeWorkbook(file);

    const uploadDir = this.uploadDir();
    await mkdir(uploadDir, { recursive: true, mode: 0o700 });

    const fileHash = createHash("sha256").update(file.buffer).digest("hex");
    const storedName = `${randomUUID()}.xlsx`;
    const storedPath = resolve(uploadDir, storedName);
    try {
      await writeFile(storedPath, file.buffer, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await this.removeFile(storedPath);
      }
      throw error;
    }

    let report: LegacyImportReport;
    try {
      report = await this.runLegacyWorkbookImport(storedPath);
    } catch (error) {
      await this.removeFile(storedPath);
      throw error;
    }
    const importErrors = report.legacyData?.importErrors ?? [];
    const createdBy = this.safeUserId(user);

    let batch;
    try {
      batch = await this.prisma.importBatch.create({
        data: {
          sourceFile: file.originalname,
          originalFileName: file.originalname,
          storedFilePath: storedPath,
          fileHash,
          fileSizeBytes: BigInt(file.size),
          status: "CLEANED",
          summary: this.reportSummary(report),
          createdBy,
          errors: importErrors.length ? { create: importErrors.map((error) => this.importErrorData(error)) } : undefined
        },
        include: { errors: { take: 100, orderBy: { createdAt: "asc" } } }
      });
    } catch (error) {
      await this.removeFile(storedPath);
      throw error;
    }

    await this.audit.record({
      userId: createdBy,
      module: "import",
      action: "upload",
      entity: "ImportBatch",
      entityId: batch.id,
      after: {
        originalFileName: batch.originalFileName,
        fileHash: batch.fileHash,
        fileSizeBytes: batch.fileSizeBytes?.toString(),
        status: batch.status
      }
    });

    return {
      id: batch.id,
      status: batch.status,
      sourceFile: batch.sourceFile,
      originalFileName: batch.originalFileName,
      fileHash: batch.fileHash,
      fileSizeBytes: batch.fileSizeBytes?.toString() ?? null,
      summary: batch.summary,
      errors: batch.errors
    };
  }

  async importProducts(batchId: string | undefined, user?: CurrentUser, options?: { preserveBatchStatus?: boolean }) {
    if (!batchId || !uuidPattern.test(batchId)) {
      throw new BadRequestException("Informe o lote de importacao criado por upload.");
    }

    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch?.storedFilePath) {
      throw new NotFoundException("Lote de importacao com arquivo armazenado nao encontrado.");
    }
    if (!options?.preserveBatchStatus && ["IMPORTING", "CERTIFIED"].includes(batch.status)) {
      throw new ConflictException("Este lote esta em processamento ou ja foi certificado e nao pode alterar produtos.");
    }

    const userId = this.safeUserId(user);

    try {
      const report = await this.runLegacyWorkbookImport(batch.storedFilePath);
      const legacyData = report.legacyData;
      const products = legacyData?.products ?? [];
      const importErrors = legacyData?.importErrors ?? [];

      if (!products.length) {
        throw new BadRequestException("Nenhum produto normalizado foi encontrado na planilha.");
      }

      const p1 = await this.prisma.sector.upsert({
        where: { code: "P1" },
        create: { code: "P1", name: "P1 - Pao de Queijo" },
        update: {}
      });
      const p2 = await this.prisma.sector.upsert({
        where: { code: "P2" },
        create: { code: "P2", name: "P2 - Bolos e Churros" },
        update: {}
      });

      let importedProducts = 0;
      for (const product of products) {
        const sector = product.defaultSector === "P2" ? p2 : p1;
        const saved = await this.prisma.product.upsert({
          where: { code: product.code },
          create: {
            code: product.code,
            name: product.name,
            defaultSectorId: sector.id,
            unit: product.unit ?? "kg",
            active: product.active ?? true,
            pricePerKg: this.importPriceForProduct(product.code, legacyData?.productionEntries),
            notes: "Importado da planilha legada.",
            createdBy: userId,
            updatedBy: userId
          },
          update: {
            name: product.name,
            defaultSectorId: sector.id,
            unit: product.unit ?? "kg",
            active: product.active ?? true,
            pricePerKg: this.importPriceForProduct(product.code, legacyData?.productionEntries),
            notes: "Atualizado pela importacao da planilha legada.",
            updatedBy: userId
          }
        });

        await this.prisma.productWeightConfig.upsert({
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
        importedProducts += 1;
      }

      await this.prisma.importError.deleteMany({ where: { batchId: batch.id } });
      if (importErrors.length) {
        await this.prisma.importError.createMany({
          data: importErrors.map((error) => ({
            batchId: batch.id,
            ...this.importErrorData(error)
          }))
        });
      }

      const summary = {
        ...this.reportSummary(report),
        importedProducts,
        duplicateProductCodes: legacyData?.duplicateProductCodes ?? [],
        duplicateWeightCodes: legacyData?.duplicateWeightCodes ?? [],
        importErrorCount: importErrors.length
      };

      const updated = await this.prisma.importBatch.update({
        where: { id: batch.id },
        data: {
          ...(options?.preserveBatchStatus ? {} : { status: importErrors.length ? "IMPORTED_WITH_ERRORS" : "IMPORTED" }),
          summary,
          ...(options?.preserveBatchStatus ? {} : { completedAt: new Date() })
        },
        include: { errors: { take: 100, orderBy: { createdAt: "asc" } } }
      });

      await this.audit.record({
        userId,
        module: "import",
        action: "import_products",
        entity: "ImportBatch",
        entityId: batch.id,
        before: { status: batch.status },
        after: {
          status: updated.status,
          importedProducts,
          importErrorCount: importErrors.length
        }
      });

      return updated;
    } catch (error) {
      await this.prisma.importBatch.update({
        where: { id: batch.id },
        data: {
          status: "FAILED",
          summary: { message: error instanceof Error ? error.message : "Falha desconhecida na importacao." },
          completedAt: new Date()
        }
      });
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(error instanceof Error ? error.message : "Falha ao importar produtos.");
    }
  }

  async importOperationalData(batchId: string | undefined, user?: CurrentUser) {
    if (!batchId || !uuidPattern.test(batchId)) throw new BadRequestException("Informe o lote de importacao criado por upload.");
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch?.storedFilePath) throw new NotFoundException("Lote de importacao com arquivo armazenado nao encontrado.");
    const lock = await this.prisma.importBatch.updateMany({
      where: { id: batchId, status: { notIn: ["IMPORTING", "CERTIFIED"] } },
      data: { status: "IMPORTING", completedAt: null }
    });
    if (lock.count !== 1) {
      throw new ConflictException("Este lote ja esta em processamento ou foi certificado e nao pode ser reimportado.");
    }
    const userId = this.safeUserId(user);

    try {
      await this.importProducts(batchId, user, { preserveBatchStatus: true });
      const report = await this.runLegacyWorkbookImport(batch.storedFilePath);
      const data = report.legacyData;
      const [p1, p2, products, packagingType] = await Promise.all([
        this.prisma.sector.findUniqueOrThrow({ where: { code: "P1" } }),
        this.prisma.sector.findUniqueOrThrow({ where: { code: "P2" } }),
        this.prisma.product.findMany({ include: { weightConfig: true } }),
        this.prisma.lossType.upsert({ where: { code: "PACKAGING" }, create: { code: "PACKAGING", name: "Embalagem" }, update: {} })
      ]);
      const productsByCode = new Map(products.map((product) => [product.code, product]));
      // Erros de cadastro e operacionais pertencem ao mesmo lote. Nunca descarte
      // inconsistencias de produto ao promover os lancamentos operacionais.
      const operationalErrors: LegacyImportError[] = [
        ...(data?.importErrors ?? []),
        ...(data?.operationalImportErrors ?? [])
      ];
      const sourceProduction = data?.productionEntries ?? [];
      const sourceLosses = data?.lossEntries ?? [];
      const sourceDowntime = data?.downtimeEntries ?? [];
      const emptySectorTotals = () => ({
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
        downtimeRows: 0,
        downtimeMinutes: 0
      });
      const sourceTotals = {
        productionRows: sourceProduction.length,
        plannedBatches: sourceProduction.reduce((total, row) => total + row.plannedBatches, 0),
        realizedBatches: sourceProduction.reduce((total, row) => total + row.realizedBatches, 0),
        packedBoxes: sourceProduction.reduce((total, row) => total + row.packedBoxes, 0),
        usedReworkKg: sourceProduction.reduce((total, row) => total + row.usedReworkKg, 0),
        generatedReworkKg: sourceProduction.reduce((total, row) => total + row.generatedReworkKg, 0),
        productionKg: 0,
        weighingLossKg: sourceProduction.reduce((total, row) => total + row.weighingLossKg, 0),
        overweightKg: 0,
        lossRows: sourceLosses.length,
        registeredLossKg: sourceLosses.reduce((total, row) => total + row.quantityKg, 0),
        downtimeRows: sourceDowntime.length,
        downtimeMinutes: 0,
        bySector: {
          P1: emptySectorTotals(),
          P2: emptySectorTotals()
        }
      };
      for (const row of sourceProduction) {
        const sectorTotals = sourceTotals.bySector[row.sector];
        sectorTotals.productionRows += 1;
        sectorTotals.plannedBatches += row.plannedBatches;
        sectorTotals.realizedBatches += row.realizedBatches;
        sectorTotals.packedBoxes += row.packedBoxes;
        sectorTotals.usedReworkKg += row.usedReworkKg;
        sectorTotals.generatedReworkKg += row.generatedReworkKg;
        sectorTotals.weighingLossKg += row.weighingLossKg;
      }
      sourceTotals.bySector.P1.lossRows = sourceLosses.length;
      sourceTotals.bySector.P1.registeredLossKg = sourceTotals.registeredLossKg;
      sourceTotals.bySector.P1.downtimeRows = sourceDowntime.length;
      let importedProduction = 0;
      let importedLosses = 0;
      let importedDowntime = 0;

      for (const row of sourceProduction) {
        const product = productsByCode.get(row.productCode);
        if (!product?.weightConfig) {
          operationalErrors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, field: "productCode", message: `Produto ${row.productCode} não encontrado ou sem configuração de peso.` });
          continue;
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
        sourceTotals.productionKg += calculated.producedKg;
        sourceTotals.overweightKg += calculated.overweightTotalKg;
        sourceTotals.bySector[row.sector].productionKg += calculated.producedKg;
        sourceTotals.bySector[row.sector].overweightKg += calculated.overweightTotalKg;
        const week = await this.ensureImportedWeek(row.date, row.legacyWeekNumber);
        const exists = await this.prisma.productionEntry.findFirst({
          where: { weekId: week.id, productId: product.id, productionOrder: row.productionOrder, date: new Date(`${row.date}T00:00:00.000Z`), deletedAt: null },
          select: { importBatchId: true }
        });
        if (exists?.importBatchId === batchId) continue;
        if (exists) {
          operationalErrors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, field: "production", message: "Lancamento de producao ja existe fora deste lote; nenhuma sobrescrita foi realizada.", rawValue: row.productionOrder });
          continue;
        }
        const unitPrice = row.pricePerKg && row.pricePerKg > 0 ? row.pricePerKg : Number(product.pricePerKg);
        const costs = calculateProductionCosts({ producedKg: calculated.producedKg, weighingLossKg: row.weighingLossKg, overweightKg: calculated.overweightTotalKg, pricePerKg: unitPrice });
        const sector = row.sector === "P2" ? p2 : p1;
        const order = await this.prisma.productionOrder.upsert({
          where: { weekId_orderNumber_productId: { weekId: week.id, orderNumber: row.productionOrder, productId: product.id } },
          create: { weekId: week.id, productId: product.id, sectorCode: row.sector, orderNumber: row.productionOrder },
          update: {}
        });
        await this.prisma.productionEntry.create({ data: {
          weekId: week.id, sectorId: sector.id, importBatchId: batchId, productId: product.id, productionOrderId: order.id, date: new Date(`${row.date}T00:00:00.000Z`), productionOrder: row.productionOrder,
          plannedBatches: row.plannedBatches, realizedBatches: row.realizedBatches, usedReworkKg: row.usedReworkKg, packedBoxes: row.packedBoxes,
          producedKg: calculated.producedKg, weighingLossKg: row.weighingLossKg, generatedReworkKg: row.generatedReworkKg, expectedYieldKg: calculated.expectedYieldKg,
          realYieldPercent: calculated.realYieldPercent, massWeightKg: config.massWeightKg, boxWeightKg: config.boxWeightKg, targetPackageWeightG: config.targetPackageWeightG,
          averagePackageWeightG: row.averagePackageWeightG, overweightGPerPackage: calculated.overweightGPerPackage, overweightTotalKg: calculated.overweightTotalKg,
          overweightPercent: calculated.overweightPercent, unitPricePerKg: costs.unitPricePerKg, productionCost: costs.productionCost, lossesCost: costs.lossesCost,
          overweightCost: costs.overweightCost, status: "OK", workflowStatus: "DRAFT", notes: [row.notes, "Importação da planilha legada."].filter(Boolean).join("\n"), createdBy: userId, updatedBy: userId
        } });
        importedProduction += 1;
      }

      for (const row of sourceLosses) {
        const week = await this.ensureImportedWeek(row.date, 1);
        const exists = await this.prisma.lossEntry.findFirst({
          where: { weekId: week.id, date: new Date(`${row.date}T00:00:00.000Z`), lossTypeId: packagingType.id, reason: row.legacyLine, deletedAt: null },
          select: { importBatchId: true }
        });
        if (exists?.importBatchId === batchId) continue;
        if (exists) {
          operationalErrors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, field: "loss", message: "Lancamento de perda ja existe fora deste lote; nenhuma sobrescrita foi realizada.", rawValue: row.legacyLine });
          continue;
        }
        await this.prisma.lossEntry.create({ data: { weekId: week.id, date: new Date(`${row.date}T00:00:00.000Z`), sectorId: p1.id, importBatchId: batchId, lossTypeId: packagingType.id, quantityKg: row.quantityKg, reason: row.legacyLine, notes: row.notes ?? "Importação da planilha legada.", workflowStatus: "DRAFT", createdBy: userId, updatedBy: userId } });
        importedLosses += 1;
      }

      for (const row of sourceDowntime) {
        const timestamp = (time: string) => new Date(`${row.date}T${time}.000Z`);
        const calculated = calculateDowntime({ productionStart: timestamp(row.productionStart), productionEnd: timestamp(row.productionEnd), downtimeStart: timestamp(row.downtimeStart), downtimeEnd: timestamp(row.downtimeEnd), producedMassKg: 0 });
        sourceTotals.downtimeMinutes += calculated.stoppedMinutes;
        sourceTotals.bySector.P1.downtimeMinutes += calculated.stoppedMinutes;
        const week = await this.ensureImportedWeek(row.date, row.legacyWeekNumber ?? 1);
        const lineCode = row.legacyLine.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 45) || "LEGADO";
        const line = await this.prisma.productionLine.upsert({ where: { sectorId_code: { sectorId: p1.id, code: lineCode } }, create: { sectorId: p1.id, code: lineCode, name: row.legacyLine }, update: {} });
        const reason = await this.prisma.downtimeReason.upsert({ where: { name: row.reason }, create: { name: row.reason }, update: {} });
        const downtimeStart = timestamp(row.downtimeStart);
        const downtimeEnd = timestamp(row.downtimeEnd);
        const exists = await this.prisma.downtimeEntry.findFirst({
          where: { weekId: week.id, lineId: line.id, downtimeReasonId: reason.id, downtimeStart, deletedAt: null },
          select: { importBatchId: true }
        });
        if (exists?.importBatchId === batchId) continue;
        if (exists) {
          operationalErrors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, field: "downtime", message: "Lancamento de parada ja existe fora deste lote; nenhuma sobrescrita foi realizada.", rawValue: row.legacyLine });
          continue;
        }
        const overlapping = await this.prisma.downtimeEntry.findFirst({
          where: {
            lineId: line.id,
            deletedAt: null,
            downtimeStart: { lt: downtimeEnd },
            downtimeEnd: { gt: downtimeStart }
          },
          select: { id: true }
        });
        if (overlapping) {
          operationalErrors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, field: "downtime", message: "Intervalo de parada sobrepoe outro lancamento da mesma linha.", rawValue: `${row.downtimeStart}-${row.downtimeEnd}` });
          continue;
        }
        await this.prisma.downtimeEntry.create({ data: { weekId: week.id, date: new Date(`${row.date}T00:00:00.000Z`), sectorId: p1.id, lineId: line.id, importBatchId: batchId, productionStart: timestamp(row.productionStart), productionEnd: timestamp(row.productionEnd), producedMassKg: 0, downtimeStart: timestamp(row.downtimeStart), downtimeEnd: timestamp(row.downtimeEnd), stoppedMinutes: calculated.stoppedMinutes, stoppedPercent: calculated.stoppedPercent, realKgHour: calculated.realKgHour, possibleKgHour: calculated.possibleKgHour, status: calculated.status, downtimeReasonId: reason.id, notes: `Importado da planilha legada (${row.legacyLine}).`, workflowStatus: "DRAFT", createdBy: userId, updatedBy: userId } });
        importedDowntime += 1;
      }

      const normalizedSourceTotals = this.roundSourceTotals(sourceTotals);
      const summary = { ...this.reportSummary(report), importedProduction, importedLosses, importedDowntime, operationalImportErrorCount: operationalErrors.length, sourceTotals: normalizedSourceTotals };
      await this.prisma.importError.deleteMany({ where: { batchId } });
      if (operationalErrors.length) await this.prisma.importError.createMany({ data: operationalErrors.map((error) => ({ batchId, ...this.importErrorData(error) })) });
      const updated = await this.prisma.importBatch.update({ where: { id: batchId }, data: { status: operationalErrors.length ? "IMPORTED_WITH_ERRORS" : "IMPORTED", summary, completedAt: new Date() }, include: { errors: { take: 100, orderBy: { createdAt: "asc" } } } });
      await this.audit.record({ userId, module: "import", action: "import_operational_data", entity: "ImportBatch", entityId: batchId, after: { importedProduction, importedLosses, importedDowntime, operationalImportErrorCount: operationalErrors.length, sourceTotals: normalizedSourceTotals } });
      return updated;
    } catch (error) {
      await this.prisma.importBatch.update({
        where: { id: batchId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          summary: {
            ...(batch.summary && typeof batch.summary === "object" && !Array.isArray(batch.summary) ? batch.summary : {}),
            failure: error instanceof Error ? error.message : "Falha desconhecida na importacao operacional."
          }
        }
      }).catch(() => undefined);
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(error instanceof Error ? error.message : "Falha ao importar dados operacionais.");
    }
  }

  private assertSafeWorkbook(file: UploadedWorkbookFile) {
    const extension = extname(file.originalname).toLowerCase();
    if (extension !== ".xlsx") {
      throw new BadRequestException("Somente arquivos .xlsx sao aceitos.");
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size !== file.buffer?.length) {
      throw new BadRequestException("Tamanho declarado do arquivo XLSX invalido.");
    }
    if (file.size > importUploadLimitBytes) {
      throw new BadRequestException("Arquivo excede o limite permitido para importacao.");
    }
    if (!xlsxMimeTypes.has(file.mimetype)) {
      throw new BadRequestException("Tipo MIME do arquivo nao permitido para importacao.");
    }
    if (!file.buffer?.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new BadRequestException("Assinatura do arquivo XLSX invalida.");
    }
  }

  private importErrorData(error: LegacyImportError) {
    return {
      sheetName: error.sheetName ?? null,
      cell: error.cell ?? null,
      rowNumber: error.rowNumber ?? null,
      field: error.field ?? null,
      message: error.message,
      rawValue: error.rawValue ?? null,
      originalValue: error.rawValue ?? null
    };
  }

  private reportSummary(report: LegacyImportReport) {
    return {
      sourceFile: report.file,
      sheetCount: report.sheetCount ?? 0,
      formulaCount: report.formulaCount ?? 0,
      tableCount: report.tableCount ?? 0,
      chartCount: report.chartCount ?? 0,
      errors: report.errors ?? {},
      productCount: report.legacyData?.productCount ?? 0,
      importErrorCount: report.legacyData?.importErrorCount ?? report.legacyData?.importErrors?.length ?? 0,
      duplicateProductCodes: report.legacyData?.duplicateProductCodes ?? [],
      duplicateWeightCodes: report.legacyData?.duplicateWeightCodes ?? [],
      productionEntryCount: report.legacyData?.productionEntryCount ?? 0,
      lossEntryCount: report.legacyData?.lossEntryCount ?? 0,
      downtimeEntryCount: report.legacyData?.downtimeEntryCount ?? 0
    };
  }

  private roundSourceTotals(totals: ImportSourceTotals): Prisma.InputJsonObject {
    const round = (value: number) => Math.round((value + Number.EPSILON) * 1_000) / 1_000;
    const normalize = (metrics: ImportSourceMetrics): Prisma.InputJsonObject => ({
      ...metrics,
      productionKg: round(metrics.productionKg),
      plannedBatches: round(metrics.plannedBatches),
      realizedBatches: round(metrics.realizedBatches),
      packedBoxes: round(metrics.packedBoxes),
      usedReworkKg: round(metrics.usedReworkKg),
      generatedReworkKg: round(metrics.generatedReworkKg),
      weighingLossKg: round(metrics.weighingLossKg),
      overweightKg: round(metrics.overweightKg),
      registeredLossKg: round(metrics.registeredLossKg),
      downtimeMinutes: round(metrics.downtimeMinutes)
    });
    return {
      ...normalize(totals),
      bySector: {
        P1: normalize(totals.bySector.P1),
        P2: normalize(totals.bySector.P2)
      }
    };
  }

  private importPriceForProduct(code: string, entries?: LegacyProductionEntry[]) {
    const price = entries?.find((entry) => entry.productCode === code && (entry.pricePerKg ?? 0) > 0)?.pricePerKg;
    return price ?? 0;
  }

  private async ensureImportedWeek(dateValue: string, legacyWeekNumber: number) {
    const date = new Date(`${dateValue}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`Data invalida na importacao: ${dateValue}.`);
    const existingForDate = await this.prisma.weeklyPeriod.findFirst({
      where: { deletedAt: null, startsOn: { lte: date }, endsOn: { gte: date } }
    });
    if (existingForDate) {
      assertWeekWritable(existingForDate, `A importacao nao pode alterar a semana ${existingForDate.label}, pois ela esta ${existingForDate.status}.`);
      return existingForDate;
    }
    const day = date.getUTCDay() || 7;
    const startsOn = new Date(date); startsOn.setUTCDate(date.getUTCDate() - day + 1);
    const endsOn = new Date(startsOn); endsOn.setUTCDate(startsOn.getUTCDate() + 6);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const weekNumber = Math.min(Math.max(Math.trunc(legacyWeekNumber) || 1, 1), 6);
    const [sameKey, overlapping] = await Promise.all([
      this.prisma.weeklyPeriod.findUnique({ where: { year_month_weekNumber: { year, month, weekNumber } } }),
      this.prisma.weeklyPeriod.findFirst({
        where: { deletedAt: null, startsOn: { lte: endsOn }, endsOn: { gte: startsOn } }
      })
    ]);
    if (sameKey) {
      throw new BadRequestException(`A chave ${year}/${month}/Semana ${weekNumber} ja pertence a outro periodo. Corrija o mapeamento antes de importar.`);
    }
    if (overlapping) {
      throw new BadRequestException(`O periodo calculado para ${dateValue} sobrepoe ${overlapping.label}. Corrija as semanas antes de importar.`);
    }
    return this.prisma.weeklyPeriod.create({
      data: { year, month, weekNumber, label: `Semana ${weekNumber}`, startsOn, endsOn }
    });
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }

  private uploadDir() {
    return resolve(process.cwd(), process.env.IMPORT_UPLOAD_DIR ?? "uploads/imports");
  }

  private async runLegacyWorkbookImport(sourceFile: string): Promise<LegacyImportReport> {
    const inspectorPath = this.resolveScript("inspect_workbook.py");
    const parserPath = this.resolveScript("import_excel.py");
    const pythonBin = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
    const securityLimits = workbookSecurityLimits();
    const processLimits = workbookProcessLimits();
    const temporaryRoot = resolve(process.env.IMPORT_TEMP_DIR ?? tmpdir());
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const workingDirectory = await mkdtemp(resolve(temporaryRoot, "nexus-import-"));
    const isolatedWorkbook = resolve(workingDirectory, "workbook.xlsx");

    try {
      await copyFile(sourceFile, isolatedWorkbook);
      await chmod(isolatedWorkbook, 0o600);

      const inspectionOutput = await this.runPythonScript({
        pythonBin,
        scriptPath: inspectorPath,
        args: [
          "--file",
          isolatedWorkbook,
          "--max-entries",
          String(securityLimits.maxEntries),
          "--max-uncompressed-bytes",
          String(securityLimits.maxUncompressedBytes),
          "--max-entry-bytes",
          String(securityLimits.maxEntryBytes),
          "--max-compression-ratio",
          String(securityLimits.maxCompressionRatio),
          "--max-path-depth",
          String(securityLimits.maxPathDepth)
        ],
        cwd: workingDirectory,
        timeout: processLimits.inspectTimeoutMs,
        maxBuffer: processLimits.inspectMaxBufferBytes,
        stage: "inspection"
      });
      this.assertInspectionResult(inspectionOutput);

      const stdout = await this.runPythonScript({
        pythonBin,
        scriptPath: parserPath,
        args: ["--file", isolatedWorkbook],
        cwd: workingDirectory,
        timeout: processLimits.parserTimeoutMs,
        maxBuffer: processLimits.parserMaxBufferBytes,
        stage: "parser"
      });

      return this.parseImportReport(stdout);
    } finally {
      try {
        await rm(workingDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        this.logger.error("Nao foi possivel remover o diretorio temporario de uma importacao XLSX.");
      }
    }
  }

  private async runPythonScript(input: {
    pythonBin: string;
    scriptPath: string;
    args: string[];
    cwd: string;
    timeout: number;
    maxBuffer: number;
    stage: "inspection" | "parser";
  }) {
    try {
      const { stdout } = await execFileAsync(
        input.pythonBin,
        ["-I", "-B", "-X", "utf8", input.scriptPath, ...input.args],
        {
          cwd: input.cwd,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            SYSTEMROOT: process.env.SYSTEMROOT ?? "",
            WINDIR: process.env.WINDIR ?? ""
          },
          killSignal: process.platform === "win32" ? "SIGTERM" : "SIGKILL",
          maxBuffer: input.maxBuffer,
          shell: false,
          timeout: input.timeout,
          windowsHide: true
        }
      );
      return stdout;
    } catch (error) {
      const failure = error as Error & {
        code?: string | number;
        killed?: boolean;
        signal?: string;
        stderr?: string | Buffer;
      };
      if (failure.code === "ENOENT") {
        throw new InternalServerErrorException("Interpretador Python da importacao nao encontrado.");
      }
      if (failure.killed || failure.signal) {
        throw new BadRequestException("A planilha excedeu o tempo limite seguro de processamento.");
      }
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new BadRequestException("A planilha produziu uma saida maior que o limite seguro.");
      }
      if (input.stage === "inspection") {
        throw new BadRequestException(`Planilha XLSX rejeitada: ${this.inspectionError(failure.stderr)}`);
      }
      throw new BadRequestException("A planilha XLSX foi validada, mas nao pode ser interpretada.");
    }
  }

  private assertInspectionResult(stdout: string) {
    try {
      const result = JSON.parse(stdout) as { valid?: unknown };
      if (result.valid !== true) throw new Error("invalid inspection result");
    } catch {
      throw new InternalServerErrorException("O inspetor XLSX produziu uma resposta invalida.");
    }
  }

  private parseImportReport(stdout: string): LegacyImportReport {
    try {
      const report = JSON.parse(stdout) as LegacyImportReport;
      if (!report || typeof report !== "object" || typeof report.file !== "string") {
        throw new Error("invalid import report");
      }
      return report;
    } catch {
      throw new InternalServerErrorException("O parser da planilha produziu uma resposta invalida.");
    }
  }

  private inspectionError(stderr: string | Buffer | undefined) {
    const raw = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : (stderr ?? "");
    const lastLine = raw.trim().split(/\r?\n/).at(-1) ?? "";
    try {
      const parsed = JSON.parse(lastLine) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.replace(/[\r\n\t]+/g, " ").slice(0, 400);
      }
    } catch {
      // Do not expose interpreter traces or local paths to the client.
    }
    return "estrutura interna invalida ou nao permitida.";
  }

  private async removeFile(filePath: string) {
    try {
      await rm(filePath, { force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      this.logger.error("Nao foi possivel remover um upload XLSX rejeitado.");
    }
  }

  private resolveScript(fileName: "inspect_workbook.py" | "import_excel.py") {
    const candidates = [
      resolve(process.cwd(), "scripts", fileName),
      resolve(process.cwd(), "../../scripts", fileName),
      resolve(__dirname, "../../../../../scripts", fileName)
    ];
    const scriptPath = candidates.find((candidate) => existsSync(candidate));
    if (!scriptPath) {
      throw new InternalServerErrorException(`Componente interno da importacao nao encontrado: ${fileName}.`);
    }
    return scriptPath;
  }
}
