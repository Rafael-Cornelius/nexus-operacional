import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { promisify } from "node:util";
import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, Logger, NotFoundException, Optional } from "@nestjs/common";
import { ImportStagingClassification, ImportStagingDomain, Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { calculateProductionEntry } from "../../domain/calculations/production-calculations";
import {
  importUploadLimitBytes,
  workbookProcessLimits,
  workbookSecurityLimits
} from "./import-security.config";
import { ImportPromotionService } from "./import-promotion.service";
import { xlsxImporterVersion } from "./import-version";

const execFileAsync = promisify(execFile);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const xlsxMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "application/octet-stream"
]);
const importerVersion = xlsxImporterVersion;

export interface UploadedWorkbookFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
}

interface LegacyImportProduct {
  code: string;
  name: string | null;
  defaultSector: "P1" | "P2" | null;
  packageWeightKg: number | null;
  boxWeightKg: number | null;
  packagesPerBox: number | null;
  massWeightKg: number | null;
  targetPackageWeightG: number | null;
  unit: string | null;
  overweightTolerancePercent: number | null;
  formula: "BOX_WEIGHT" | "PACKAGE_WEIGHT" | null;
  active: boolean | null;
  source?: unknown;
}

interface LegacyUnresolvedProductRow {
  sheetName: string;
  rowNumber: number;
  code: string | null;
  name: string | null;
  sourceCells: Record<string, unknown>;
  [key: string]: unknown;
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
  legacyWeekNumber: number | null;
  date: string | null;
  productCode: string | null;
  productionOrder: string | null;
  plannedBatches: number | null;
  realizedBatches: number | null;
  usedReworkKg: number | null;
  packedBoxes: number | null;
  weighingLossKg: number | null;
  generatedReworkKg: number | null;
  averagePackageWeightG?: number | null;
  notes?: string | null;
  pricePerKg?: number | null;
  sourceCells?: Record<string, unknown>;
}

interface LegacyLossEntry {
  sheetName: string;
  rowNumber: number;
  date: string | null;
  quantityKg: number | null;
  filmShift1Kg: number | null;
  filmShift2Kg: number | null;
  boxLossUnits: number | null;
  boxLossShift1Units: number | null;
  boxLossShift2Units: number | null;
  sector: null;
  productCode: null;
  legacyLine: string | null;
  lossType: "PACKAGING";
  notes?: string | null;
  sourceCells: Record<string, {
    cell: string;
    value: string | null;
    type: string | null;
    formula: string | null;
    formulaAttributes: Record<string, string> | null;
  }>;
}

interface LegacyDosageSample {
  sheetName: string;
  cell: string;
  rowNumber: number;
  columnNumber: number;
  rawValue: string | null;
  weightG: number | null;
  missingContext: string[];
}

interface LegacyHistoricalEntry {
  sheetName: string;
  tableName: string;
  tableRange: string;
  rowNumber: number;
  firstCell: string;
  recordId: string | null;
  recordKey: string | null;
  version: number | null;
  activeRaw: string | null;
  sourceHash: string | null;
  rawValues: Record<string, string | null>;
  sourceCells: Record<string, unknown>;
}

interface LegacyDowntimeEntry {
  sheetName: string;
  rowNumber: number;
  date: string | null;
  productionStart: string | null;
  productionEnd: string | null;
  downtimeStart: string | null;
  downtimeEnd: string | null;
  reason: string | null;
  legacyLine: string | null;
  legacyWeekNumber?: number | null;
  sourceCells?: Record<string, unknown>;
}

interface LegacyFormulaError {
  sheetName: string;
  cell: string | null;
  formula: string | null;
  formulaAttributes: Record<string, string> | null;
  calculatedValue: string | null;
  cellType: string | null;
  errorType: string;
  context: string;
}

interface LegacyImportReport {
  file: string;
  sheetCount?: number;
  formulaCount?: number;
  tableCount?: number;
  chartCount?: number;
  errors?: Record<string, number>;
  formulaErrors?: LegacyFormulaError[];
  formulaErrorCount?: number;
  legacyData?: {
    products?: LegacyImportProduct[];
    productCount?: number;
    duplicateProductCodes?: string[];
    duplicateWeightCodes?: string[];
    unresolvedProductRows?: LegacyUnresolvedProductRow[];
    importErrors?: LegacyImportError[];
    importErrorCount?: number;
    productionEntries?: LegacyProductionEntry[];
    productionEntryCount?: number;
    lossEntries?: LegacyLossEntry[];
    lossEntryCount?: number;
    downtimeEntries?: LegacyDowntimeEntry[];
    downtimeEntryCount?: number;
    dosageSamples?: LegacyDosageSample[];
    dosageSampleCount?: number;
    historicalEntries?: LegacyHistoricalEntry[];
    historicalEntryCount?: number;
    historicalCountsByTable?: Record<string, number>;
    operationalImportErrors?: LegacyImportError[];
  };
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly promotion?: ImportPromotionService
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
      report = await this.runLegacyWorkbookImport(storedPath, file.originalname);
    } catch (error) {
      await this.removeFile(storedPath);
      throw error;
    }
    const importErrors = [
      ...(report.legacyData?.importErrors ?? []),
      ...(report.legacyData?.operationalImportErrors ?? [])
    ];
    const stagingRecords = this.buildStagingRecords(report);
    const createdBy = this.safeUserId(user);

    let batch;
    try {
      batch = await this.prisma.$transaction(async (tx) => {
        const created = await tx.importBatch.create({
          data: {
          sourceFile: file.originalname,
          originalFileName: file.originalname,
          storedFilePath: storedPath,
          fileHash,
          fileSizeBytes: BigInt(file.size),
          status: "STAGED",
          importerVersion,
          summary: {
            ...this.reportSummary(report),
            staging: this.stagingSummary(stagingRecords),
            excelTotals: this.stagingTotals(stagingRecords),
            sourceIntegrity: {
              independentDerivedMetrics: false,
              completeReconciliationScope: false,
              reason: "Parser preserva celulas dos dominios mapeados e erros de formula individualmente, mas ainda nao cobre todos os dominios nem recalcula todas as metricas de forma independente.",
              missingReconciliationDomains: ["productivity", "dosage", "costs", "historical-materialized-records", "sector-level-certification"],
              directMetrics: [
                "productionRows",
                "plannedBatches",
                "realizedBatches",
                "packedBoxes",
                "usedReworkKg",
                "generatedReworkKg",
                "weighingLossKg",
                "lossRows",
                "registeredLossKg",
                "filmShift1Kg",
                "filmShift2Kg",
                "boxLossUnits",
                "boxLossShift1Units",
                "boxLossShift2Units",
                "downtimeRows"
              ],
              interpretedMetrics: ["productionKg", "overweightKg", "downtimeMinutes"]
            }
          },
          createdBy,
          errors: importErrors.length ? { create: importErrors.map((error) => this.importErrorData(error)) } : undefined,
          stagingRecords: stagingRecords.length ? { create: stagingRecords } : undefined
          },
          include: {
            errors: { take: 100, orderBy: { createdAt: "asc" } },
            _count: { select: { stagingRecords: true } }
          }
        });

        await this.audit.record({
          userId: createdBy,
          module: "import",
          action: "upload",
          entity: "ImportBatch",
          entityId: created.id,
          after: {
            originalFileName: created.originalFileName,
            fileHash: created.fileHash,
            fileSizeBytes: created.fileSizeBytes?.toString(),
            status: created.status,
            stagedRecords: created._count.stagingRecords,
            importerVersion
          }
        }, tx);
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      await this.removeFile(storedPath);
      throw error;
    }

    return {
      id: batch.id,
      status: batch.status,
      sourceFile: batch.sourceFile,
      originalFileName: batch.originalFileName,
      fileHash: batch.fileHash,
      fileSizeBytes: batch.fileSizeBytes?.toString() ?? null,
      summary: batch.summary,
      errors: batch.errors,
      stagedRecords: batch._count.stagingRecords,
      importerVersion
    };
  }

  async importProducts(batchId: string | undefined, user?: CurrentUser) {
    if (!batchId || !uuidPattern.test(batchId)) {
      throw new BadRequestException("Informe o lote de importacao criado por upload.");
    }
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { _count: { select: { stagingRecords: true } } }
    });
    if (!batch) throw new NotFoundException("Lote de importacao nao encontrado.");
    if (["PROMOTING", "CERTIFIED", "LEGACY_CERTIFIED"].includes(batch.status)) {
      throw new ConflictException("Lote em promocao ou certificado nao permite nova preparacao.");
    }
    if (!batch._count.stagingRecords) {
      throw new ConflictException("Lote antigo sem staging. Reenvie o XLSX para inspecao profissional.");
    }
    await this.audit.record({
      userId: this.safeUserId(user),
      module: "import",
      action: "prepare_staging_products",
      entity: "ImportBatch",
      entityId: batchId,
      after: { status: batch.status, stagedRecords: batch._count.stagingRecords }
    });
    return {
      id: batch.id,
      status: batch.status,
      summary: batch.summary,
      stagedRecords: batch._count.stagingRecords,
      message: "Produtos permanecem no staging ate a promocao atomica do lote."
    };
  }

  async importOperationalData(batchId: string | undefined, user?: CurrentUser) {
    if (!batchId) throw new BadRequestException("Informe o lote de importacao criado por upload.");
    return this.promote(batchId, user);
  }

  promote(batchId: string, user?: CurrentUser) {
    if (!this.promotion) throw new InternalServerErrorException("Servico de promocao indisponivel.");
    return this.promotion.promote(batchId, user);
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

  private buildStagingRecords(report: LegacyImportReport): Prisma.ImportStagingRecordCreateWithoutBatchInput[] {
    const data = report.legacyData;
    const parserIssues = [...(data?.importErrors ?? []), ...(data?.operationalImportErrors ?? [])];
    const usedIssues = new Set<number>();
    const records: Prisma.ImportStagingRecordCreateWithoutBatchInput[] = [];
    const products = data?.products ?? [];
    const productsByCode = new Map(products.map((product) => [product.code, product]));
    const duplicateCodes = new Set([...(data?.duplicateProductCodes ?? []), ...(data?.duplicateWeightCodes ?? [])]);

    const addRecord = (
      domain: ImportStagingDomain,
      value: Record<string, unknown>,
      raw: unknown,
      sheetName: string | null,
      rowNumber: number | null,
      identity: string,
      extraIssues: Array<Record<string, unknown>> = [],
      cell: string | null = null
    ) => {
      const matchingIssues = parserIssues.flatMap((issue, index) => {
        const issueDomain = this.issueDomain(issue);
        const match = issue.sheetName === sheetName && issue.rowNumber === rowNumber &&
          (issueDomain === domain || issueDomain === "UNKNOWN");
        if (!match) return [];
        usedIssues.add(index);
        return [{
          source: "parser",
          field: issue.field ?? null,
          cell: issue.cell ?? null,
          message: issue.message,
          rawValue: issue.rawValue ?? null,
          classification: this.issueClassification(issue.message)
        }];
      });
      const issues = [...matchingIssues, ...extraIssues];
      const classification = this.highestClassification(issues);
      const rawOriginal = this.jsonValue(raw);
      const interpretedValue = this.jsonValue(value);
      const sourceFingerprint = this.fingerprint(rawOriginal);
      const sourceKey = this.fingerprint({ domain, sheetName, rowNumber, identity }).slice(0, 48);
      records.push({
        domain,
        sourceKey,
        sourceFingerprint,
        sheetName,
        cell,
        rowNumber,
        rawOriginal,
        interpretedValue,
        validationIssues: issues.length ? this.jsonValue(issues) : undefined,
        classification,
        decision: "PENDING"
      });
    };

    products.forEach((product, index) => {
      const source = product.source && typeof product.source === "object" && !Array.isArray(product.source)
        ? product.source as Record<string, unknown>
        : {};
      const sourceRows = [
        ...(Array.isArray(source.productRows) ? source.productRows : []),
        ...(Array.isArray(source.weightRows) ? source.weightRows : [])
      ] as Array<{ sheet?: unknown; row?: unknown }>;
      const firstSource = sourceRows[0];
      const inferredIssues: Array<Record<string, unknown>> = [];
      const sourcePrices = [...new Set((data?.productionEntries ?? [])
        .filter((row) => row.productCode === product.code && typeof row.pricePerKg === "number" && row.pricePerKg > 0)
        .map((row) => row.pricePerKg as number))];
      const interpretedProduct = {
        ...product,
        pricePerKg: sourcePrices.length === 1 ? sourcePrices[0] : null
      };
      if (sourcePrices.length === 0) {
        inferredIssues.push({
          source: "validation",
          field: "pricePerKg",
          message: "Preco por kg nao foi encontrado na fonte; produto novo exige correcao e produto existente preserva preco oficial.",
          classification: "REQUIRES_REVIEW"
        });
      } else if (sourcePrices.length > 1) {
        inferredIssues.push({
          source: "validation",
          field: "pricePerKg",
          message: "Mais de um preco por kg foi encontrado; nenhum valor foi escolhido silenciosamente.",
          values: sourcePrices,
          classification: "REQUIRES_REVIEW"
        });
      }
      for (const field of ["packageWeightKg", "boxWeightKg", "packagesPerBox", "massWeightKg", "targetPackageWeightG"] as const) {
        if (typeof product[field] !== "number" || product[field] <= 0) {
          inferredIssues.push({
            source: "validation",
            field,
            message: "Configuracao de peso ausente ou nao positiva exige correcao.",
            classification: "ERROR"
          });
        }
      }
      for (const field of ["name", "defaultSector", "unit", "overweightTolerancePercent", "formula", "active"] as const) {
        if (product[field] === null || product[field] === undefined || product[field] === "") {
          inferredIssues.push({
            source: "missing-source",
            field,
            message: "Campo nao existe de forma inequivoca na fonte; exige decisao humana documentada e nenhum padrao foi presumido.",
            classification: "ERROR"
          });
        }
      }
      if (typeof product.name === "string" && product.name.startsWith("Produto legado ")) {
        inferredIssues.push({
          source: "inference",
          field: "name",
          message: "Nome de produto foi criado como rotulo tecnico pelo parser e exige correcao para nome de fonte.",
          classification: "ERROR"
        });
      }
      if (duplicateCodes.has(product.code)) {
        inferredIssues.push({
          source: "parser",
          field: "code",
          message: "Codigo duplicado encontrado nas fontes de cadastro ou pesagem.",
          classification: "DUPLICATE"
        });
      }
      addRecord(
        "PRODUCT",
        interpretedProduct as unknown as Record<string, unknown>,
        source,
        typeof firstSource?.sheet === "string" ? firstSource.sheet : null,
        typeof firstSource?.row === "number" ? firstSource.row : null,
        product.code + ":" + index,
        inferredIssues
      );
    });

    (data?.unresolvedProductRows ?? []).forEach((row, index) => addRecord(
      "PRODUCT",
      row as Record<string, unknown>,
      row,
      row.sheetName,
      row.rowNumber,
      "unresolved:" + (row.code ?? "missing-code") + ":" + index,
      [{
        source: "validation",
        field: row.code ? "name" : "code",
        message: "Linha de cadastro incompleta foi preservada integralmente; exige correcao humana antes de qualquer promocao.",
        classification: "ERROR"
      }]
    ));

    (data?.productionEntries ?? []).forEach((row, index) => {
      const product = productsByCode.get(row.productCode ?? "");
      const calculationIssues: Array<Record<string, unknown>> = [];
      if (row.sector === "P1") {
        calculationIssues.push({
          source: "rule-registry",
          field: "expectedYieldKg/realYieldPercent/totalLossesKg",
          message: "Regras de rendimento e perdas derivadas do P1 aguardam homologacao; linha exige aprovacao humana.",
          classification: "REQUIRES_REVIEW"
        });
      }
      for (const field of ["plannedBatches", "realizedBatches", "usedReworkKg", "packedBoxes", "weighingLossKg", "generatedReworkKg"] as const) {
        if (typeof row[field] !== "number") {
          calculationIssues.push({
            source: "source-cell",
            field,
            message: "Celula ausente, com erro ou nao numerica foi preservada como nula; zero nao foi presumido.",
            classification: "ERROR"
          });
        } else if (row[field] < 0) {
          calculationIssues.push({
            source: "validation",
            field,
            message: "Valor negativo nao pode ser normalizado silenciosamente.",
            classification: "ERROR"
          });
        }
      }
      for (const field of ["legacyWeekNumber", "date", "productCode", "productionOrder"] as const) {
        if (row[field] === null || row[field] === undefined || row[field] === "") {
          calculationIssues.push({
            source: "source-cell",
            field,
            message: "Campo obrigatorio ausente ou invalido; a linha foi preservada e exige correcao humana.",
            classification: "ERROR"
          });
        }
      }
      let interpreted: Record<string, unknown> = row as unknown as Record<string, unknown>;
      if (!product) {
        calculationIssues.push({
          source: "validation",
          field: "productCode",
          message: "Produto referenciado nao existe no staging de produtos.",
          classification: "ERROR"
        });
      } else if (
        typeof row.plannedBatches === "number" &&
        typeof row.realizedBatches === "number" &&
        typeof row.usedReworkKg === "number" &&
        typeof row.packedBoxes === "number" &&
        typeof row.weighingLossKg === "number" &&
        typeof row.generatedReworkKg === "number" &&
        (product.formula === "BOX_WEIGHT" || product.formula === "PACKAGE_WEIGHT") &&
        typeof product.packageWeightKg === "number" &&
        typeof product.boxWeightKg === "number" &&
        typeof product.packagesPerBox === "number" &&
        typeof product.massWeightKg === "number" &&
        typeof product.targetPackageWeightG === "number" &&
        typeof product.overweightTolerancePercent === "number"
      ) {
        const calculation = calculateProductionEntry({
          sector: row.sector,
          plannedBatches: row.plannedBatches,
          realizedBatches: row.realizedBatches,
          usedReworkKg: row.usedReworkKg,
          packedBoxes: row.packedBoxes,
          weighingLossKg: row.weighingLossKg,
          generatedReworkKg: row.generatedReworkKg,
          averagePackageWeightG: row.averagePackageWeightG,
          weightConfig: {
            formula: product.formula,
            packageWeightKg: product.packageWeightKg,
            boxWeightKg: product.boxWeightKg,
            packagesPerBox: product.packagesPerBox,
            massWeightKg: product.massWeightKg,
            targetPackageWeightG: product.targetPackageWeightG,
            overweightTolerancePercent: product.overweightTolerancePercent
          }
        });
        const rawRealYieldPercent = calculation.expectedYieldKg > 0
          ? calculation.producedKg / calculation.expectedYieldKg
          : null;
        const calculationMessages = [...calculation.inconsistencies];
        if (rawRealYieldPercent !== null && rawRealYieldPercent > 1) {
          calculationMessages.push("Rendimento acima de 100%; registro exige revisao humana antes da promocao.");
        }
        interpreted = {
          ...row,
          calculationPreview: {
            producedKg: calculation.producedKg,
            expectedYieldKg: calculation.expectedYieldKg,
            rawRealYieldPercent,
            storedRealYieldPercent: calculation.realYieldPercent,
            overweightTotalKg: calculation.overweightTotalKg,
            inconsistencies: calculationMessages,
            calculationRuleVersions: calculation.calculationRuleVersions
          }
        };
        calculationIssues.push(...calculationMessages.map((message) => ({
          source: "calculation",
          field: "yield",
          message,
          classification: "REQUIRES_REVIEW"
        })));
      } else {
        calculationIssues.push({
          source: "calculation",
          field: "calculationPreview",
          message: "Calculo nao executado porque a linha ou a configuracao do produto possui valor desconhecido; nenhum zero foi presumido.",
          classification: "ERROR"
        });
      }
      addRecord(
        "PRODUCTION",
        interpreted,
        row,
        row.sheetName,
        row.rowNumber,
        (row.productionOrder ?? "missing-op") + ":" + (row.productCode ?? "missing-product") + ":" + index,
        calculationIssues
      );
    });

    (data?.lossEntries ?? []).forEach((row, index) => {
      const filmParts = row.filmShift1Kg !== null && row.filmShift2Kg !== null
        ? row.filmShift1Kg + row.filmShift2Kg
        : null;
      const boxParts = row.boxLossShift1Units !== null && row.boxLossShift2Units !== null
        ? row.boxLossShift1Units + row.boxLossShift2Units
        : null;
      const issues: Array<Record<string, unknown>> = [];
      if (!row.date || !row.legacyLine) {
        issues.push({
          source: "source-cell",
          field: !row.date ? "date" : "legacyLine",
          message: "Data ou maquina ausente/invalida; linha fonte preservada e promocao bloqueada.",
          classification: "ERROR"
        });
      }
      if ((row.quantityKg ?? 0) <= 0 && (row.boxLossUnits ?? 0) <= 0) {
        issues.push({
          source: "validation",
          field: "quantityKg/boxLossUnits",
          message: "Perda deve possuir filme em kg ou caixa em unidades; valor exige correcao.",
          classification: "ERROR"
        });
      }
      for (const field of ["quantityKg", "filmShift1Kg", "filmShift2Kg", "boxLossUnits", "boxLossShift1Units", "boxLossShift2Units"] as const) {
        if (row[field] === null) {
          issues.push({
            source: "source-cell",
            field,
            message: "Celula ausente, com erro ou nao numerica foi preservada como nula; zero nao foi presumido.",
            classification: "ERROR"
          });
        }
      }
      if (row.quantityKg !== null && filmParts !== null && Math.abs(row.quantityKg - filmParts) > 0.001) {
        issues.push({
          source: "validation",
          field: "filmShift1Kg/filmShift2Kg",
          message: "Total de filme nao confere com a soma T1 + T2; nenhuma parcela foi ajustada.",
          classification: "ERROR"
        });
      }
      if (row.boxLossUnits !== null && boxParts !== null && Math.abs(row.boxLossUnits - boxParts) > 0.001) {
        issues.push({
          source: "validation",
          field: "boxLossShift1Units/boxLossShift2Units",
          message: "Total de caixas nao confere com a soma T1 + T2; nenhuma parcela foi ajustada.",
          classification: "ERROR"
        });
      }
      if ((row.boxLossUnits ?? 0) > 0) {
        issues.push({
          source: "unit-semantics",
          field: "boxLossUnits",
          message: "Caixas foram preservadas em unidades e nao foram somadas nem convertidas para quilogramas.",
          classification: "REQUIRES_REVIEW"
        });
      }
      issues.push({
        source: "validation",
        field: "sector/productCode",
        message: "Setor e produto nao existem na fonte de perdas; ambos exigem identificacao humana e preco aprovado vigente.",
        classification: "ERROR"
      });
      addRecord(
        "LOSS",
        { ...row, unitCost: null } as unknown as Record<string, unknown>,
        {
          sheetName: row.sheetName,
          rowNumber: row.rowNumber,
          sourceCells: row.sourceCells
        },
        row.sheetName,
        row.rowNumber,
        (row.date ?? "missing-date") + ":" + (row.legacyLine ?? "missing-line") + ":" + index,
        issues
      );
    });
    (data?.downtimeEntries ?? []).forEach((row, index) => {
      const requiredFields = ["date", "productionStart", "productionEnd", "downtimeStart", "downtimeEnd", "reason", "legacyLine"] as const;
      const missingFields = requiredFields.filter((field) => !row[field]);
      const messages: string[] = [];
      let calculationPreview: Record<string, unknown> | null = null;
      if (missingFields.length === 0) {
        const timestamp = (time: string | null) => new Date(row.date + "T" + time + ".000Z");
        const productionStart = timestamp(row.productionStart);
        const productionEnd = timestamp(row.productionEnd);
        const downtimeStart = timestamp(row.downtimeStart);
        const downtimeEnd = timestamp(row.downtimeEnd);
        const availableMinutes = (productionEnd.getTime() - productionStart.getTime()) / 60_000;
        const stoppedMinutes = (downtimeEnd.getTime() - downtimeStart.getTime()) / 60_000;
        if (availableMinutes <= 0) messages.push("Janela de producao possui duracao nula ou negativa.");
        if (stoppedMinutes < 0) messages.push("Termino da parada menor que inicio da parada.");
        if (downtimeStart < productionStart || downtimeEnd > productionEnd) {
          messages.push("Intervalo de parada esta fora da janela de producao e exige revisao.");
        }
        calculationPreview = {
          stoppedMinutes: stoppedMinutes >= 0 ? stoppedMinutes : null,
          stoppedPercent: availableMinutes > 0 && stoppedMinutes >= 0 ? stoppedMinutes / availableMinutes : null,
          inconsistencies: messages
        };
      } else {
        messages.push("Calculo de parada nao executado: campos obrigatorios ausentes ou invalidos.");
      }
      addRecord(
        "DOWNTIME",
        {
          ...row,
          sector: null,
          producedMassKg: null,
          calculationPreview
        },
        row,
        row.sheetName,
        row.rowNumber,
        (row.date ?? "missing-date") + ":" + (row.legacyLine ?? "missing-line") + ":" + (row.downtimeStart ?? "missing-start") + ":" + index,
        [...messages.map((message) => ({
          source: "calculation",
          field: "downtime",
          message,
          classification: /menor que inicio|zerado/i.test(message) ? "ERROR" : "REQUIRES_REVIEW"
        })), ...missingFields.map((field) => ({
          source: "source-cell",
          field,
          message: "Campo obrigatorio ausente ou invalido; linha fonte preservada.",
          classification: "ERROR"
        })), {
          source: "validation",
          field: "producedMassKg",
          message: "Massa produzida nao existe na fonte parseada e exige correcao; zero nao sera presumido.",
          classification: "ERROR"
        }, {
          source: "validation",
          field: "sector",
          message: "Setor nao esta explicito na fonte de paradas e exige confirmacao humana; P1 nao sera presumido.",
          classification: "ERROR"
        }]
      );
    });

    (data?.dosageSamples ?? []).forEach((sample, index) => addRecord(
      "DOSAGE",
      {
        weightG: sample.weightG,
        sourceCell: sample.cell,
        missingContext: sample.missingContext,
        promotable: false
      },
      sample,
      sample.sheetName,
      sample.rowNumber,
      sample.cell + ":" + index,
      [{
        source: "quarantine",
        field: "operationalContext",
        message: sample.weightG === null
          ? "Amostra de dosagem nao numerica foi preservada e exige correcao humana."
          : "Amostra preservada sem produto, OP, data, semana, setor, equipamento, turno ou operador; promocao automatica proibida.",
        classification: sample.weightG === null ? "ERROR" : "REQUIRES_REVIEW"
      }],
      sample.cell
    ));

    (data?.historicalEntries ?? []).forEach((history, index) => addRecord(
      "HISTORY",
      {
        tableName: history.tableName,
        tableRange: history.tableRange,
        recordId: history.recordId,
        recordKey: history.recordKey,
        version: history.version,
        activeRaw: history.activeRaw,
        sourceHash: history.sourceHash,
        promotable: false
      },
      history,
      history.sheetName,
      history.rowNumber,
      history.tableName + ":" + (history.recordId ?? history.recordKey ?? history.rowNumber) + ":" + index,
      [{
        source: "quarantine",
        field: "historicalRecord",
        message: "Registro materializado do arquivo morto preservado com valores, celulas, chave, versao e hash; exige reconciliacao antes de qualquer promocao operacional.",
        classification: "REQUIRES_REVIEW"
      }],
      history.firstCell
    ));

    (report.formulaErrors ?? []).forEach((formulaError, index) => addRecord(
      "UNKNOWN",
      {
        errorType: formulaError.errorType,
        formula: formulaError.formula,
        calculatedValue: formulaError.calculatedValue,
        promotable: false
      },
      formulaError,
      formulaError.sheetName,
      formulaError.cell ? Number.parseInt(formulaError.cell.replace(/\D/g, ""), 10) || null : null,
      "formula-error:" + (formulaError.cell ?? index),
      [{
        source: "workbook-inspection",
        field: "formula",
        cell: formulaError.cell,
        message: "Celula com erro ou referencia quebrada foi preservada com formula, cache, tipo e contexto; conversao para zero proibida.",
        classification: "ERROR"
      }],
      formulaError.cell
    ));

    parserIssues.forEach((issue, index) => {
      if (usedIssues.has(index)) return;
      const domain = this.issueDomain(issue);
      const rawOriginal = this.jsonValue({
        sheetName: issue.sheetName ?? null,
        cell: issue.cell ?? null,
        rowNumber: issue.rowNumber ?? null,
        field: issue.field ?? null,
        rawValue: issue.rawValue ?? null,
        message: issue.message
      });
      records.push({
        domain,
        sourceKey: this.fingerprint({ domain, issue, index }).slice(0, 48),
        sourceFingerprint: this.fingerprint(rawOriginal),
        sheetName: issue.sheetName ?? null,
        cell: issue.cell ?? null,
        rowNumber: issue.rowNumber ?? null,
        rawOriginal,
        validationIssues: this.jsonValue([{
          source: "parser",
          field: issue.field ?? null,
          message: issue.message,
          rawValue: issue.rawValue ?? null,
          classification: this.issueClassification(issue.message)
        }]),
        classification: this.issueClassification(issue.message),
        decision: "PENDING"
      });
    });
    Object.entries((report.formulaErrors?.length ?? 0) > 0 ? {} : (report.errors ?? {})).forEach(([errorType, count]) => {
      if (!Number.isFinite(count) || count <= 0) return;
      const rawOriginal = this.jsonValue({
        errorType,
        count,
        scope: "workbook",
        detailUnavailableFromLegacyParser: true
      });
      records.push({
        domain: "UNKNOWN",
        sourceKey: this.fingerprint({ errorType, count, scope: "workbook" }).slice(0, 48),
        sourceFingerprint: this.fingerprint(rawOriginal),
        rawOriginal,
        validationIssues: this.jsonValue([{
          source: "workbook-inspection",
          field: "formula",
          message: "Planilha contem " + count + " ocorrencias de " + errorType + "; nenhuma foi convertida para zero.",
          classification: "ERROR"
        }]),
        classification: "ERROR",
        decision: "PENDING"
      });
    });
    return records;
  }

  private stagingSummary(records: Prisma.ImportStagingRecordCreateWithoutBatchInput[]) {
    return {
      importerVersion,
      records: records.length,
      byDomain: Object.fromEntries(Object.values(ImportStagingDomain).map((domain) => [
        domain,
        records.filter((record) => record.domain === domain).length
      ])),
      byClassification: Object.fromEntries(Object.values(ImportStagingClassification).map((classification) => [
        classification,
        records.filter((record) => record.classification === classification).length
      ]))
    };
  }

  private stagingTotals(records: Prisma.ImportStagingRecordCreateWithoutBatchInput[]): Prisma.InputJsonObject {
    type MetricKey =
      | "productionRows" | "plannedBatches" | "realizedBatches" | "packedBoxes"
      | "usedReworkKg" | "generatedReworkKg" | "productionKg" | "weighingLossKg" | "overweightKg"
      | "lossRows" | "registeredLossKg" | "filmShift1Kg" | "filmShift2Kg"
      | "boxLossUnits" | "boxLossShift1Units" | "boxLossShift2Units"
      | "downtimeRows" | "downtimeMinutes";
    type TotalsBucket = Record<MetricKey, number> & { unknownMetrics: Record<string, number> };
    const empty = (): TotalsBucket => ({
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
      downtimeMinutes: 0,
      unknownMetrics: {}
    });
    const totals = { ...empty(), bySector: { P1: empty(), P2: empty() } };
    const asObject = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const add = (target: TotalsBucket, key: MetricKey, value: unknown) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        target[key] += value;
        return;
      }
      target.unknownMetrics[key] = (target.unknownMetrics[key] ?? 0) + 1;
    };
    for (const record of records) {
      const row = asObject(record.interpretedValue);
      if (!row) continue;
      if (record.domain === "PRODUCTION") {
        const sector = row.sector === "P1" || row.sector === "P2" ? row.sector : null;
        const preview = asObject(row.calculationPreview);
        const targets = sector ? [totals, totals.bySector[sector]] : [totals];
        if (!sector) totals.unknownMetrics.productionSector = (totals.unknownMetrics.productionSector ?? 0) + 1;
        for (const target of targets) {
          target.productionRows += 1;
          add(target, "plannedBatches", row.plannedBatches);
          add(target, "realizedBatches", row.realizedBatches);
          add(target, "packedBoxes", row.packedBoxes);
          add(target, "usedReworkKg", row.usedReworkKg);
          add(target, "generatedReworkKg", row.generatedReworkKg);
          add(target, "productionKg", preview?.producedKg);
          add(target, "weighingLossKg", row.weighingLossKg);
          add(target, "overweightKg", preview?.overweightTotalKg);
        }
      } else if (record.domain === "LOSS") {
        totals.lossRows += 1;
        add(totals, "registeredLossKg", row.quantityKg);
        add(totals, "filmShift1Kg", row.filmShift1Kg);
        add(totals, "filmShift2Kg", row.filmShift2Kg);
        add(totals, "boxLossUnits", row.boxLossUnits);
        add(totals, "boxLossShift1Units", row.boxLossShift1Units);
        add(totals, "boxLossShift2Units", row.boxLossShift2Units);
        const sector = row.sector === "P1" || row.sector === "P2" ? row.sector : null;
        if (sector) {
          totals.bySector[sector].lossRows += 1;
          add(totals.bySector[sector], "registeredLossKg", row.quantityKg);
          add(totals.bySector[sector], "filmShift1Kg", row.filmShift1Kg);
          add(totals.bySector[sector], "filmShift2Kg", row.filmShift2Kg);
          add(totals.bySector[sector], "boxLossUnits", row.boxLossUnits);
          add(totals.bySector[sector], "boxLossShift1Units", row.boxLossShift1Units);
          add(totals.bySector[sector], "boxLossShift2Units", row.boxLossShift2Units);
        } else {
          totals.unknownMetrics.lossSector = (totals.unknownMetrics.lossSector ?? 0) + 1;
        }
      } else if (record.domain === "DOWNTIME") {
        const preview = asObject(row.calculationPreview);
        const start = typeof row.downtimeStart === "string" && typeof row.date === "string"
          ? new Date(row.date + "T" + row.downtimeStart + ".000Z")
          : null;
        const end = typeof row.downtimeEnd === "string" && typeof row.date === "string"
          ? new Date(row.date + "T" + row.downtimeEnd + ".000Z")
          : null;
        const minutes = preview && typeof preview.stoppedMinutes === "number" && Number.isFinite(preview.stoppedMinutes)
          ? preview.stoppedMinutes
          : start && end && end > start ? (end.getTime() - start.getTime()) / 60_000 : undefined;
        totals.downtimeRows += 1;
        add(totals, "downtimeMinutes", minutes);
        const sector = row.sector === "P1" || row.sector === "P2" ? row.sector : null;
        if (sector) {
          totals.bySector[sector].downtimeRows += 1;
          add(totals.bySector[sector], "downtimeMinutes", minutes);
        } else {
          totals.unknownMetrics.downtimeSector = (totals.unknownMetrics.downtimeSector ?? 0) + 1;
        }
      }
    }
    const rounded = JSON.parse(JSON.stringify(totals), (_key, value) =>
      typeof value === "number" ? Math.round((value + Number.EPSILON) * 1_000) / 1_000 : value
    );
    return rounded as Prisma.InputJsonObject;
  }

  private issueDomain(issue: LegacyImportError): ImportStagingDomain {
    const sheet = (issue.sheetName ?? "").toLowerCase();
    if (/pacotes-caixas|banco de dados pesagen/.test(sheet)) return "PRODUCT";
    if (/plan x real/.test(sheet)) return "PRODUCTION";
    if (/controle de perdas/.test(sheet)) return "LOSS";
    if (/relatorios de paradas/.test(sheet)) return "DOWNTIME";
    const text = [issue.field, issue.message].filter(Boolean).join(" ").toLowerCase();
    if (/parada|downtime/.test(text)) return "DOWNTIME";
    if (/dosag|amostra|sample/.test(text)) return "DOSAGE";
    if (/arquivo morto|histor|legacy archive/.test(text)) return "HISTORY";
    if (/perda|loss|embalagem/.test(text)) return "LOSS";
    if (/produ[cç][aã]o|planned|batelada|production/.test(text)) return "PRODUCTION";
    if (/produto|\bproduct\b|pacote|caixa|pesagen|peso|code/.test(text)) return "PRODUCT";
    return "UNKNOWN";
  }

  private issueClassification(message: string): ImportStagingClassification {
    const normalized = message.toLowerCase();
    if (/duplic|already exists|ja existe/.test(normalized)) return "DUPLICATE";
    if (/requires review|exige revis|ambig|outside the period|fora do periodo|incompat/.test(normalized)) {
      return "REQUIRES_REVIEW";
    }
    if (/warning|aviso|atencao/.test(normalized)) return "WARNING";
    return "ERROR";
  }

  private highestClassification(issues: Array<Record<string, unknown>>): ImportStagingClassification {
    const priorities: ImportStagingClassification[] = ["ERROR", "DUPLICATE", "REQUIRES_REVIEW", "WARNING"];
    return priorities.find((candidate) => issues.some((issue) => issue.classification === candidate)) ?? "VALID";
  }

  private jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private fingerprint(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private reportSummary(report: LegacyImportReport) {
    return {
      sourceFile: report.file,
      sheetCount: report.sheetCount ?? 0,
      formulaCount: report.formulaCount ?? 0,
      tableCount: report.tableCount ?? 0,
      chartCount: report.chartCount ?? 0,
      errors: report.errors ?? {},
      formulaErrorCount: report.formulaErrorCount ?? report.formulaErrors?.length ?? 0,
      productCount: report.legacyData?.productCount ?? 0,
      unresolvedProductRowCount: report.legacyData?.unresolvedProductRows?.length ?? 0,
      importErrorCount: (report.legacyData?.importErrors?.length ?? report.legacyData?.importErrorCount ?? 0) +
        (report.legacyData?.operationalImportErrors?.length ?? 0),
      duplicateProductCodes: report.legacyData?.duplicateProductCodes ?? [],
      duplicateWeightCodes: report.legacyData?.duplicateWeightCodes ?? [],
      productionEntryCount: report.legacyData?.productionEntryCount ?? 0,
      lossEntryCount: report.legacyData?.lossEntryCount ?? 0,
      downtimeEntryCount: report.legacyData?.downtimeEntryCount ?? 0,
      dosageSampleCount: report.legacyData?.dosageSampleCount ?? 0,
      historicalEntryCount: report.legacyData?.historicalEntryCount ?? 0,
      historicalCountsByTable: report.legacyData?.historicalCountsByTable ?? {}
    };
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }

  private uploadDir() {
    return resolve(process.cwd(), process.env.IMPORT_UPLOAD_DIR ?? "uploads/imports");
  }

  private async runLegacyWorkbookImport(sourceFile: string, sourceName?: string): Promise<LegacyImportReport> {
    const inspectorPath = this.resolveScript("inspect_workbook.py");
    const parserPath = this.resolveScript("import_excel.py");
    const pythonBin = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
    const securityLimits = workbookSecurityLimits();
    const processLimits = workbookProcessLimits();
    const temporaryRoot = resolve(process.env.IMPORT_TEMP_DIR ?? tmpdir());
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const workingDirectory = await mkdtemp(resolve(temporaryRoot, "nexus-import-"));
    const originalBaseName = basename(sourceName ?? sourceFile).normalize("NFKC");
    const safeBaseName = originalBaseName
      .replace(/[^\p{L}\p{N} ._-]/gu, "_")
      .slice(0, 180);
    const isolatedWorkbook = resolve(
      workingDirectory,
      safeBaseName.toLowerCase().endsWith(".xlsx") ? safeBaseName : "workbook.xlsx"
    );

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
