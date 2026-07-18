import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { calculateProductionEntry } from "../../domain/calculations/production-calculations";
import { calculateProductionCosts } from "../../domain/calculations/financial-calculations";
import { calculateDowntime } from "../../domain/calculations/downtime-calculations";
import { assertWeekWritable } from "../../domain/weeks/week-rules";

const execFileAsync = promisify(execFile);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxUploadBytes = Number(process.env.IMPORT_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);
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
    await mkdir(uploadDir, { recursive: true });

    const fileHash = createHash("sha256").update(file.buffer).digest("hex");
    const storedName = `${randomUUID()}.xlsx`;
    const storedPath = resolve(uploadDir, storedName);
    await writeFile(storedPath, file.buffer);

    const report = await this.runLegacyWorkbookImport(storedPath);
    const importErrors = report.legacyData?.importErrors ?? [];
    const createdBy = this.safeUserId(user);

    const batch = await this.prisma.importBatch.create({
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

  async importProducts(batchId: string | undefined, user?: CurrentUser) {
    if (!batchId || !uuidPattern.test(batchId)) {
      throw new BadRequestException("Informe o lote de importacao criado por upload.");
    }

    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch?.storedFilePath) {
      throw new NotFoundException("Lote de importacao com arquivo armazenado nao encontrado.");
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
          status: importErrors.length ? "IMPORTED_WITH_ERRORS" : "IMPORTED",
          summary,
          completedAt: new Date()
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
    const userId = this.safeUserId(user);

    try {
      await this.importProducts(batchId, user);
      const report = await this.runLegacyWorkbookImport(batch.storedFilePath);
      const data = report.legacyData;
      const [p1, p2, products, packagingType] = await Promise.all([
        this.prisma.sector.findUniqueOrThrow({ where: { code: "P1" } }),
        this.prisma.sector.findUniqueOrThrow({ where: { code: "P2" } }),
        this.prisma.product.findMany({ include: { weightConfig: true } }),
        this.prisma.lossType.upsert({ where: { code: "PACKAGING" }, create: { code: "PACKAGING", name: "Embalagem" }, update: {} })
      ]);
      const productsByCode = new Map(products.map((product) => [product.code, product]));
      const operationalErrors: LegacyImportError[] = [...(data?.operationalImportErrors ?? [])];
      let importedProduction = 0;
      let importedLosses = 0;
      let importedDowntime = 0;

      for (const row of data?.productionEntries ?? []) {
        const product = productsByCode.get(row.productCode);
        if (!product?.weightConfig) {
          operationalErrors.push({ sheetName: row.sheetName, rowNumber: row.rowNumber, field: "productCode", message: `Produto ${row.productCode} não encontrado ou sem configuração de peso.` });
          continue;
        }
        const week = await this.ensureImportedWeek(row.date, row.legacyWeekNumber);
        const exists = await this.prisma.productionEntry.findFirst({ where: { weekId: week.id, productId: product.id, productionOrder: row.productionOrder, date: new Date(`${row.date}T00:00:00.000Z`), deletedAt: null } });
        if (exists) continue;
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
        const unitPrice = row.pricePerKg && row.pricePerKg > 0 ? row.pricePerKg : Number(product.pricePerKg);
        const costs = calculateProductionCosts({ producedKg: calculated.producedKg, weighingLossKg: row.weighingLossKg, overweightKg: calculated.overweightTotalKg, pricePerKg: unitPrice });
        const sector = row.sector === "P2" ? p2 : p1;
        const order = await this.prisma.productionOrder.upsert({
          where: { weekId_orderNumber_productId: { weekId: week.id, orderNumber: row.productionOrder, productId: product.id } },
          create: { weekId: week.id, productId: product.id, sectorCode: row.sector, orderNumber: row.productionOrder },
          update: {}
        });
        await this.prisma.productionEntry.create({ data: {
          weekId: week.id, sectorId: sector.id, productId: product.id, productionOrderId: order.id, date: new Date(`${row.date}T00:00:00.000Z`), productionOrder: row.productionOrder,
          plannedBatches: row.plannedBatches, realizedBatches: row.realizedBatches, usedReworkKg: row.usedReworkKg, packedBoxes: row.packedBoxes,
          producedKg: calculated.producedKg, weighingLossKg: row.weighingLossKg, generatedReworkKg: row.generatedReworkKg, expectedYieldKg: calculated.expectedYieldKg,
          realYieldPercent: calculated.realYieldPercent, massWeightKg: config.massWeightKg, boxWeightKg: config.boxWeightKg, targetPackageWeightG: config.targetPackageWeightG,
          averagePackageWeightG: row.averagePackageWeightG, overweightGPerPackage: calculated.overweightGPerPackage, overweightTotalKg: calculated.overweightTotalKg,
          overweightPercent: calculated.overweightPercent, unitPricePerKg: costs.unitPricePerKg, productionCost: costs.productionCost, lossesCost: costs.lossesCost,
          overweightCost: costs.overweightCost, status: "OK", notes: [row.notes, "Importação da planilha legada."].filter(Boolean).join("\n"), createdBy: userId, updatedBy: userId
        } });
        importedProduction += 1;
      }

      for (const row of data?.lossEntries ?? []) {
        const week = await this.ensureImportedWeek(row.date, 1);
        const exists = await this.prisma.lossEntry.findFirst({ where: { weekId: week.id, date: new Date(`${row.date}T00:00:00.000Z`), lossTypeId: packagingType.id, reason: row.legacyLine, deletedAt: null } });
        if (exists) continue;
        await this.prisma.lossEntry.create({ data: { weekId: week.id, date: new Date(`${row.date}T00:00:00.000Z`), sectorId: p1.id, lossTypeId: packagingType.id, quantityKg: row.quantityKg, reason: row.legacyLine, notes: row.notes ?? "Importação da planilha legada.", createdBy: userId, updatedBy: userId } });
        importedLosses += 1;
      }

      for (const row of data?.downtimeEntries ?? []) {
        const week = await this.ensureImportedWeek(row.date, row.legacyWeekNumber ?? 1);
        const lineCode = row.legacyLine.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 45) || "LEGADO";
        const line = await this.prisma.productionLine.upsert({ where: { sectorId_code: { sectorId: p1.id, code: lineCode } }, create: { sectorId: p1.id, code: lineCode, name: row.legacyLine }, update: {} });
        const reason = await this.prisma.downtimeReason.upsert({ where: { name: row.reason }, create: { name: row.reason }, update: {} });
        const timestamp = (time: string) => new Date(`${row.date}T${time}.000Z`);
        const calculated = calculateDowntime({ productionStart: timestamp(row.productionStart), productionEnd: timestamp(row.productionEnd), downtimeStart: timestamp(row.downtimeStart), downtimeEnd: timestamp(row.downtimeEnd), producedMassKg: 0 });
        const exists = await this.prisma.downtimeEntry.findFirst({ where: { weekId: week.id, lineId: line.id, downtimeReasonId: reason.id, downtimeStart: timestamp(row.downtimeStart), deletedAt: null } });
        if (exists) continue;
        await this.prisma.downtimeEntry.create({ data: { weekId: week.id, date: new Date(`${row.date}T00:00:00.000Z`), sectorId: p1.id, lineId: line.id, productionStart: timestamp(row.productionStart), productionEnd: timestamp(row.productionEnd), producedMassKg: 0, downtimeStart: timestamp(row.downtimeStart), downtimeEnd: timestamp(row.downtimeEnd), stoppedMinutes: calculated.stoppedMinutes, stoppedPercent: calculated.stoppedPercent, realKgHour: calculated.realKgHour, possibleKgHour: calculated.possibleKgHour, status: calculated.status, downtimeReasonId: reason.id, notes: `Importado da planilha legada (${row.legacyLine}).`, createdBy: userId, updatedBy: userId } });
        importedDowntime += 1;
      }

      const summary = { ...this.reportSummary(report), importedProduction, importedLosses, importedDowntime, operationalImportErrorCount: operationalErrors.length };
      await this.prisma.importError.deleteMany({ where: { batchId } });
      if (operationalErrors.length) await this.prisma.importError.createMany({ data: operationalErrors.map((error) => ({ batchId, ...this.importErrorData(error) })) });
      const updated = await this.prisma.importBatch.update({ where: { id: batchId }, data: { status: operationalErrors.length ? "IMPORTED_WITH_ERRORS" : "IMPORTED", summary, completedAt: new Date() }, include: { errors: { take: 100, orderBy: { createdAt: "asc" } } } });
      await this.audit.record({ userId, module: "import", action: "import_operational_data", entity: "ImportBatch", entityId: batchId, after: { importedProduction, importedLosses, importedDowntime, operationalImportErrorCount: operationalErrors.length } });
      return updated;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(error instanceof Error ? error.message : "Falha ao importar dados operacionais.");
    }
  }

  private assertSafeWorkbook(file: UploadedWorkbookFile) {
    const extension = extname(file.originalname).toLowerCase();
    if (extension !== ".xlsx") {
      throw new BadRequestException("Somente arquivos .xlsx sao aceitos.");
    }
    if (file.size > maxUploadBytes) {
      throw new BadRequestException("Arquivo excede o limite permitido para importacao.");
    }
    if (!xlsxMimeTypes.has(file.mimetype)) {
      throw new BadRequestException("Tipo MIME do arquivo nao permitido para importacao.");
    }
    if (!file.buffer?.subarray(0, 2).equals(Buffer.from("PK"))) {
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
    const scriptPath = this.resolveImportScript();
    const pythonBin = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
    const { stdout } = await execFileAsync(pythonBin, [scriptPath, "--file", sourceFile], {
      maxBuffer: 20 * 1024 * 1024,
      cwd: resolve(__dirname, "../../../../..")
    });

    return JSON.parse(stdout) as LegacyImportReport;
  }

  private resolveImportScript() {
    const candidates = [
      resolve(process.cwd(), "scripts/import_excel.py"),
      resolve(process.cwd(), "../../scripts/import_excel.py"),
      resolve(__dirname, "../../../../../scripts/import_excel.py")
    ];
    const scriptPath = candidates.find((candidate) => existsSync(candidate));
    if (!scriptPath) {
      throw new BadRequestException(`Script de importacao nao encontrado. Procurado em: ${candidates.join(", ")}`);
    }
    return scriptPath;
  }
}
