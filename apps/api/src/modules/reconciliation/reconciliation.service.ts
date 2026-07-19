import { createHash } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";

interface SourceTotals {
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
  unknownMetrics?: Record<string, number>;
  bySector?: Record<string, unknown>;
}

interface MetricDefinition {
  key: keyof Omit<SourceTotals, "bySector">;
  label: string;
  unit: "rows" | "kg" | "min" | "batches" | "boxes";
}

const metrics: MetricDefinition[] = [
  { key: "productionRows", label: "Lançamentos de produção", unit: "rows" },
  { key: "plannedBatches", label: "Bateladas planejadas", unit: "batches" },
  { key: "realizedBatches", label: "Bateladas realizadas", unit: "batches" },
  { key: "packedBoxes", label: "Caixas embaladas", unit: "boxes" },
  { key: "usedReworkKg", label: "Reprocesso usado", unit: "kg" },
  { key: "generatedReworkKg", label: "Reprocesso gerado", unit: "kg" },
  { key: "productionKg", label: "Produção", unit: "kg" },
  { key: "weighingLossKg", label: "Perda de pesagem", unit: "kg" },
  { key: "overweightKg", label: "Sobrepeso", unit: "kg" },
  { key: "lossRows", label: "Lançamentos de perdas", unit: "rows" },
  { key: "registeredLossKg", label: "Perdas registradas", unit: "kg" },
  { key: "filmShift1Kg", label: "Perda de filme T1", unit: "kg" },
  { key: "filmShift2Kg", label: "Perda de filme T2", unit: "kg" },
  { key: "boxLossUnits", label: "Perda de caixas", unit: "boxes" },
  { key: "boxLossShift1Units", label: "Perda de caixas T1", unit: "boxes" },
  { key: "boxLossShift2Units", label: "Perda de caixas T2", unit: "boxes" },
  { key: "downtimeRows", label: "Lançamentos de parada", unit: "rows" },
  { key: "downtimeMinutes", label: "Tempo parado", unit: "min" }
];
const requiredFullScopeMetricKeys = [
  ...metrics.map((metric) => String(metric.key)),
  "packedPackages",
  "productionCost",
  "registeredLossCost",
  "overweightCost",
  "productivityRows",
  "productivityKgPerHour",
  "dosageRows",
  "dosageSampleCount",
  "historicalRows",
  "p1ProductionKg",
  "p2ProductionKg"
] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function numeric(value: unknown) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function rounded(value: number, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async report(batchId: string, user?: CurrentUser) {
    if (!uuidPattern.test(batchId)) throw new BadRequestException("Lote de importacao invalido.");
    const result = await this.buildReport(this.prisma, batchId);
    await this.audit.record({
      userId: user?.id && uuidPattern.test(user.id) ? user.id : undefined,
      module: "import",
      action: "reconcile",
      entity: "ImportBatch",
      entityId: batchId,
      after: {
        status: result.status,
        certified: result.certified,
        pendingErrors: result.pendingErrors ?? null,
        pendingOperationalApprovals: result.pendingOperationalApprovals ?? null,
        datasetHash: result.datasetHash ?? null,
        metrics: result.metrics
      }
    });
    return result;
  }

  private async buildReport(client: Prisma.TransactionClient | PrismaService, batchId: string) {
    const batch = await client.importBatch.findUnique({
      where: { id: batchId },
      include: {
        errors: { where: { status: "PENDING" }, select: { id: true } },
        stagingRecords: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            domain: true,
            sourceFingerprint: true,
            classification: true,
            decision: true,
            version: true,
            rawOriginal: true,
            interpretedValue: true,
            correctedValue: true,
            validationIssues: true,
            resolutionReason: true,
            resolvedBy: true,
            resolvedAt: true,
            promotedEntityId: true,
            promotedAt: true
          }
        }
      }
    });
    if (!batch) throw new NotFoundException("Lote de importacao nao encontrado.");
    const excel = this.sourceTotals(batch.summary, "excelTotals") ?? this.sourceTotals(batch.summary, "sourceTotals");
    const staging = this.sourceTotals(batch.summary, "stagingTotals") ?? excel;
    if (!excel || !staging) {
      return {
        batchId,
        sourceFile: batch.originalFileName ?? batch.sourceFile,
        fileHash: batch.fileHash,
        batchStatus: batch.status,
        status: "SOURCE_TOTALS_UNAVAILABLE",
        certified: false,
        datasetHash: null,
        certificationIntegrity: batch.status === "LEGACY_CERTIFIED"
          ? "LEGACY_CONTRACT"
          : batch.status === "CERTIFIED" ? "STALE" : "NOT_CERTIFIED",
        eligibleForCertification: false,
        pendingErrors: batch.errors.length,
        pendingStagingReviews: 0,
        pendingOperationalApprovals: null,
        sourceIntegrity: this.sourceIntegrity(batch.summary),
        message: "Reprocesse este lote com o inspetor atual para gerar os totais de origem.",
        metrics: []
      };
    }

    const [production, losses, downtime, productionRows, lossRows, downtimeRows] = await Promise.all([
      client.productionEntry.aggregate({
        where: { importBatchId: batchId, deletedAt: null },
        _count: true,
        _sum: {
          plannedBatches: true,
          realizedBatches: true,
          packedBoxes: true,
          usedReworkKg: true,
          generatedReworkKg: true,
          producedKg: true,
          weighingLossKg: true,
          overweightTotalKg: true
        }
      }),
      client.lossEntry.aggregate({
        where: { importBatchId: batchId, deletedAt: null },
        _count: true,
        _sum: {
          quantityKg: true,
          filmShift1Kg: true,
          filmShift2Kg: true,
          boxLossUnits: true,
          boxLossShift1Units: true,
          boxLossShift2Units: true
        }
      }),
      client.downtimeEntry.aggregate({
        where: { importBatchId: batchId, deletedAt: null },
        _count: true,
        _sum: { stoppedMinutes: true }
      }),
      client.productionEntry.findMany({
        where: { importBatchId: batchId },
        orderBy: { id: "asc" },
        select: {
          id: true, version: true, updatedAt: true, deletedAt: true, workflowStatus: true,
          weekId: true, sectorId: true, productId: true, date: true, productionOrder: true,
          pricePeriodId: true, priceVersion: true, priceOrigin: true, priceCurrency: true,
          plannedBatches: true, realizedBatches: true, usedReworkKg: true, packedBoxes: true,
          producedKg: true, weighingLossKg: true, generatedReworkKg: true, expectedYieldKg: true,
          realYieldPercent: true, massWeightKg: true, boxWeightKg: true, targetPackageWeightG: true,
          averagePackageWeightG: true, overweightGPerPackage: true, overweightTotalKg: true,
          overweightPercent: true, unitPricePerKg: true, productionCost: true, lossesCost: true,
          overweightCost: true, calculationRuleVersions: true
        }
      }),
      client.lossEntry.findMany({
        where: { importBatchId: batchId },
        orderBy: { id: "asc" },
        select: {
          id: true, version: true, updatedAt: true, deletedAt: true, workflowStatus: true,
          weekId: true, date: true, sectorId: true, productId: true, lossTypeId: true,
          pricePeriodId: true, priceVersion: true, priceOrigin: true, priceCurrency: true,
          quantityKg: true, filmShift1Kg: true, filmShift2Kg: true,
          boxLossUnits: true, boxLossShift1Units: true, boxLossShift2Units: true,
          unitCost: true, lossCost: true, calculationRuleVersions: true
        }
      }),
      client.downtimeEntry.findMany({
        where: { importBatchId: batchId },
        orderBy: { id: "asc" },
        select: {
          id: true, version: true, updatedAt: true, deletedAt: true, workflowStatus: true,
          weekId: true, date: true, sectorId: true, lineId: true, equipmentId: true,
          shiftId: true, downtimeReasonId: true, productionStart: true, productionEnd: true,
          producedMassKg: true, downtimeStart: true, downtimeEnd: true, stoppedMinutes: true,
          stoppedPercent: true, realKgHour: true, possibleKgHour: true, calculationRuleVersions: true
        }
      })
    ]);
    const database: Omit<SourceTotals, "bySector"> = {
      productionRows: production._count,
      plannedBatches: numeric(production._sum.plannedBatches),
      realizedBatches: numeric(production._sum.realizedBatches),
      packedBoxes: numeric(production._sum.packedBoxes),
      usedReworkKg: numeric(production._sum.usedReworkKg),
      generatedReworkKg: numeric(production._sum.generatedReworkKg),
      productionKg: numeric(production._sum.producedKg),
      weighingLossKg: numeric(production._sum.weighingLossKg),
      overweightKg: numeric(production._sum.overweightTotalKg),
      lossRows: losses._count,
      registeredLossKg: numeric(losses._sum.quantityKg),
      filmShift1Kg: numeric(losses._sum.filmShift1Kg),
      filmShift2Kg: numeric(losses._sum.filmShift2Kg),
      boxLossUnits: numeric(losses._sum.boxLossUnits),
      boxLossShift1Units: numeric(losses._sum.boxLossShift1Units),
      boxLossShift2Units: numeric(losses._sum.boxLossShift2Units),
      downtimeRows: downtime._count,
      downtimeMinutes: numeric(downtime._sum.stoppedMinutes)
    };
    const kgTolerance = this.tolerance("RECONCILIATION_KG_TOLERANCE", 0.01);
    const minuteTolerance = this.tolerance("RECONCILIATION_MINUTE_TOLERANCE", 0.01);
    const comparisons = metrics.map((metric) => {
      const excelKnownSubtotal = numeric(excel[metric.key]);
      const stagingKnownSubtotal = numeric(staging[metric.key]);
      const stored = numeric(database[metric.key]);
      const excelUnknownValues = numeric(excel.unknownMetrics?.[metric.key]);
      const stagingUnknownValues = numeric(staging.unknownMetrics?.[metric.key]);
      const excelComplete = excelUnknownValues === 0;
      const stagingComplete = stagingUnknownValues === 0;
      const stagingDifference = excelComplete && stagingComplete
        ? rounded(stagingKnownSubtotal - excelKnownSubtotal)
        : null;
      const databaseDifference = stagingComplete ? rounded(stored - stagingKnownSubtotal) : null;
      const tolerance = metric.unit === "rows" || metric.unit === "boxes"
        ? 0
        : metric.unit === "min" ? minuteTolerance : kgTolerance;
      return {
        key: metric.key,
        metric: metric.label,
        unit: metric.unit,
        excel: excelComplete ? rounded(excelKnownSubtotal) : null,
        excelKnownSubtotal: rounded(excelKnownSubtotal),
        excelUnknownValues,
        staging: stagingComplete ? rounded(stagingKnownSubtotal) : null,
        stagingKnownSubtotal: rounded(stagingKnownSubtotal),
        stagingUnknownValues,
        database: rounded(stored),
        difference: excelComplete ? rounded(stored - excelKnownSubtotal) : null,
        stagingDifference,
        databaseDifference,
        tolerance,
        stagingStatus: !excelComplete || !stagingComplete
          ? "INCOMPLETE"
          : Math.abs(stagingDifference ?? 0) <= tolerance ? "MATCH" : "DIVERGENT",
        status: !stagingComplete
          ? "INCOMPLETE"
          : Math.abs(databaseDifference ?? 0) <= tolerance ? "MATCH" : "DIVERGENT"
      };
    });
    const pendingErrors = batch.errors.length;
    const pendingStagingReviews = (batch.stagingRecords ?? []).filter((record) => {
      if (["IGNORED", "REJECTED"].includes(record.decision)) return false;
      if (["DOSAGE", "HISTORY"].includes(record.domain)) return true;
      if (record.decision === "CORRECTED" && record.classification === "VALID") return false;
      if (record.classification === "VALID") return false;
      if (["WARNING", "REQUIRES_REVIEW"].includes(record.classification)) return record.decision !== "APPROVED";
      return true;
    }).length;
    const flowStatus = (values: string[]) => values.includes("INCOMPLETE")
      ? "INCOMPLETE"
      : values.every((value) => value === "MATCH") ? "MATCH" : "DIVERGENT";
    const excelToStagingStatus = flowStatus(comparisons.map((metric) => metric.stagingStatus));
    const stagingToDatabaseStatus = flowStatus(comparisons.map((metric) => metric.status));
    const status = excelToStagingStatus === "MATCH" && stagingToDatabaseStatus === "MATCH"
      ? "MATCH"
      : [excelToStagingStatus, stagingToDatabaseStatus].includes("INCOMPLETE") ? "INCOMPLETE" : "DIVERGENT";
    const activeOperationalRows = [
      ...productionRows.filter((row) => row.deletedAt === null),
      ...lossRows.filter((row) => row.deletedAt === null),
      ...downtimeRows.filter((row) => row.deletedAt === null)
    ];
    const pendingOperationalApprovals = activeOperationalRows.filter((row) => row.workflowStatus !== "APPROVED").length;
    const sourceIntegrity = this.sourceIntegrity(batch.summary);
    const datasetHash = this.datasetHash({
      batch: {
        id: batch.id,
        fileHash: batch.fileHash,
        importerVersion: batch.importerVersion,
        stagingRecords: batch.stagingRecords
      },
      productionRows,
      lossRows,
      downtimeRows,
      metrics: comparisons
    });
    const certifiedHash = this.certifiedHash(batch.summary);
    const dataEligible = status === "MATCH" && pendingErrors === 0 && pendingStagingReviews === 0 &&
      pendingOperationalApprovals === 0 &&
      sourceIntegrity.independentDerivedMetrics && sourceIntegrity.completeReconciliationScope;
    const eligibleForCertification = dataEligible && ["IMPORTED", "IMPORTED_WITH_ERRORS"].includes(batch.status);
    const certified = dataEligible && batch.status === "CERTIFIED" && certifiedHash === datasetHash;
    const result = {
      batchId,
      sourceFile: batch.originalFileName ?? batch.sourceFile,
      fileHash: batch.fileHash,
      batchStatus: batch.status,
      status,
      excelToStagingStatus,
      stagingToDatabaseStatus,
      certified,
      datasetHash,
      certificationIntegrity: batch.status === "LEGACY_CERTIFIED"
        ? "LEGACY_CONTRACT"
        : batch.status !== "CERTIFIED" ? "NOT_CERTIFIED" : certified ? "MATCH" : "STALE",
      eligibleForCertification,
      pendingErrors,
      pendingStagingReviews,
      pendingOperationalApprovals,
      sourceIntegrity,
      sourceBySector: excel.bySector ?? null,
      excelBySector: excel.bySector ?? null,
      stagingBySector: staging.bySector ?? null,
      metrics: comparisons,
      generatedAt: new Date().toISOString()
    };
    return result;
  }

  async certify(batchId: string, reason: string | undefined, user?: CurrentUser) {
    const normalizedReason = reason?.trim() ?? "";
    if (normalizedReason.length < 10) {
      throw new BadRequestException("Informe um motivo de certificacao com pelo menos 10 caracteres.");
    }
    if (!uuidPattern.test(batchId)) throw new BadRequestException("Lote de importacao invalido.");
    const userId = user?.id && uuidPattern.test(user.id) ? user.id : undefined;
    if (!userId) throw new BadRequestException("Administrador autenticado invalido para certificar o lote.");
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "import_batches" WHERE "id" = CAST(${batchId} AS uuid) FOR UPDATE`);
        const report = await this.buildReport(transaction, batchId);
        if (!report.eligibleForCertification || !report.datasetHash) {
          throw new BadRequestException("O lote possui divergencias, fonte circular ou inconsistencias pendentes e nao pode ser certificado.");
        }
        const current = await transaction.importBatch.findUnique({ where: { id: batchId }, select: { status: true, summary: true } });
        if (!current) throw new NotFoundException("Lote de importacao nao encontrado.");
        const certifiedAt = new Date();
        const summary = this.summaryWithCertification(current.summary, {
          reconciliationVersion: "excel-postgresql-v2",
          datasetHash: report.datasetHash,
          certifiedAt: certifiedAt.toISOString(),
          certifiedBy: userId,
          reason: normalizedReason
        });
        await transaction.importBatch.update({
          where: { id: batchId },
          data: { status: "CERTIFIED", completedAt: certifiedAt, summary }
        });
        const result = {
          ...report,
          batchStatus: "CERTIFIED",
          certified: true,
          certificationIntegrity: "MATCH",
          certificationReason: normalizedReason
        };
        await this.audit.record({
          userId,
          module: "import",
          action: "certify_reconciliation",
          entity: "ImportBatch",
          entityId: batchId,
          reason: normalizedReason,
          before: { status: current.status },
          after: { status: "CERTIFIED", datasetHash: report.datasetHash, metrics: report.metrics }
        }, transaction);
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 }
    );
  }

  private sourceTotals(summary: unknown, key: "excelTotals" | "stagingTotals" | "sourceTotals"): SourceTotals | null {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
    const raw = (summary as Record<string, unknown>)[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    return {
      productionRows: numeric(value.productionRows),
      plannedBatches: numeric(value.plannedBatches),
      realizedBatches: numeric(value.realizedBatches),
      packedBoxes: numeric(value.packedBoxes),
      usedReworkKg: numeric(value.usedReworkKg),
      generatedReworkKg: numeric(value.generatedReworkKg),
      productionKg: numeric(value.productionKg),
      weighingLossKg: numeric(value.weighingLossKg),
      overweightKg: numeric(value.overweightKg),
      lossRows: numeric(value.lossRows),
      registeredLossKg: numeric(value.registeredLossKg),
      filmShift1Kg: numeric(value.filmShift1Kg),
      filmShift2Kg: numeric(value.filmShift2Kg),
      boxLossUnits: numeric(value.boxLossUnits),
      boxLossShift1Units: numeric(value.boxLossShift1Units),
      boxLossShift2Units: numeric(value.boxLossShift2Units),
      downtimeRows: numeric(value.downtimeRows),
      downtimeMinutes: numeric(value.downtimeMinutes),
      unknownMetrics: value.unknownMetrics && typeof value.unknownMetrics === "object" && !Array.isArray(value.unknownMetrics)
        ? Object.fromEntries(Object.entries(value.unknownMetrics as Record<string, unknown>).map(([metric, count]) => [metric, numeric(count)]))
        : undefined,
      bySector: value.bySector && typeof value.bySector === "object" && !Array.isArray(value.bySector)
        ? value.bySector as Record<string, unknown>
        : undefined
    };
  }

  private tolerance(key: string, fallback: number) {
    const configured = Number(process.env[key] ?? fallback);
    return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
  }

  private sourceIntegrity(summary: unknown) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
      return { independentDerivedMetrics: false, completeReconciliationScope: false, reason: "Resumo de origem indisponivel." };
    }
    const integrity = (summary as Record<string, unknown>).sourceIntegrity;
    if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) {
      return {
        independentDerivedMetrics: false,
        completeReconciliationScope: false,
        reason: "Lote anterior ao contrato explicito de integridade; reprocesse para certificacao segura."
      };
    }
    const value = integrity as Record<string, unknown>;
    const declaredMetrics = Array.isArray(value.reconciledMetrics)
      ? value.reconciledMetrics.filter((item): item is string => typeof item === "string")
      : [];
    const implementedMetrics = new Set(metrics.map((metric) => String(metric.key)));
    const implementationCoversFullScope = requiredFullScopeMetricKeys.every((key) => implementedMetrics.has(key));
    const sourceDeclaresFullScope = requiredFullScopeMetricKeys.every((key) => declaredMetrics.includes(key));
    return {
      ...value,
      independentDerivedMetrics: value.independentDerivedMetrics === true,
      completeReconciliationScope: value.completeReconciliationScope === true && implementationCoversFullScope && sourceDeclaresFullScope,
      requiredFullScopeMetricKeys,
      implementationCoversFullScope,
      sourceDeclaresFullScope
    };
  }

  private datasetHash(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Prisma.Decimal) return item.toFixed();
      return item;
    })).digest("hex");
  }

  private certifiedHash(summary: unknown) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
    const certification = (summary as Record<string, unknown>).certification;
    if (!certification || typeof certification !== "object" || Array.isArray(certification)) return null;
    const hash = (certification as Record<string, unknown>).datasetHash;
    return typeof hash === "string" ? hash : null;
  }

  private summaryWithCertification(summary: unknown, certification: Prisma.InputJsonObject): Prisma.InputJsonObject {
    const current = summary && typeof summary === "object" && !Array.isArray(summary)
      ? JSON.parse(JSON.stringify(summary)) as Prisma.InputJsonObject
      : {};
    return { ...current, certification };
  }
}
