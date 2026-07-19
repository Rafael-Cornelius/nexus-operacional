import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
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
  downtimeRows: number;
  downtimeMinutes: number;
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
  { key: "downtimeRows", label: "Lançamentos de parada", unit: "rows" },
  { key: "downtimeMinutes", label: "Tempo parado", unit: "min" }
];
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
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      include: { errors: { where: { status: "PENDING" }, select: { id: true } } }
    });
    if (!batch) throw new NotFoundException("Lote de importacao nao encontrado.");
    const source = this.sourceTotals(batch.summary);
    if (!source) {
      return {
        batchId,
        sourceFile: batch.originalFileName ?? batch.sourceFile,
        batchStatus: batch.status,
        status: "SOURCE_TOTALS_UNAVAILABLE",
        certified: false,
        eligibleForCertification: false,
        message: "Reprocesse este lote com o inspetor atual para gerar os totais de origem.",
        metrics: []
      };
    }

    const [production, losses, downtime] = await Promise.all([
      this.prisma.productionEntry.aggregate({
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
      this.prisma.lossEntry.aggregate({
        where: { importBatchId: batchId, deletedAt: null },
        _count: true,
        _sum: { quantityKg: true }
      }),
      this.prisma.downtimeEntry.aggregate({
        where: { importBatchId: batchId, deletedAt: null },
        _count: true,
        _sum: { stoppedMinutes: true }
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
      downtimeRows: downtime._count,
      downtimeMinutes: numeric(downtime._sum.stoppedMinutes)
    };
    const kgTolerance = this.tolerance("RECONCILIATION_KG_TOLERANCE", 0.01);
    const minuteTolerance = this.tolerance("RECONCILIATION_MINUTE_TOLERANCE", 0.01);
    const comparisons = metrics.map((metric) => {
      const excel = numeric(source[metric.key]);
      const stored = numeric(database[metric.key]);
      const difference = rounded(stored - excel);
      const tolerance = metric.unit === "rows" ? 0 : metric.unit === "min" ? minuteTolerance : kgTolerance;
      return {
        key: metric.key,
        metric: metric.label,
        unit: metric.unit,
        excel: rounded(excel),
        database: rounded(stored),
        difference,
        tolerance,
        status: Math.abs(difference) <= tolerance ? "MATCH" : "DIVERGENT"
      };
    });
    const pendingErrors = batch.errors.length;
    const status = comparisons.every((metric) => metric.status === "MATCH") ? "MATCH" : "DIVERGENT";
    const eligibleForCertification = status === "MATCH" && pendingErrors === 0 && ["IMPORTED", "IMPORTED_WITH_ERRORS", "CERTIFIED"].includes(batch.status);
    const certified = eligibleForCertification && batch.status === "CERTIFIED";
    const result = {
      batchId,
      sourceFile: batch.originalFileName ?? batch.sourceFile,
      fileHash: batch.fileHash,
      batchStatus: batch.status,
      status,
      certified,
      eligibleForCertification,
      pendingErrors,
      sourceBySector: source.bySector ?? null,
      metrics: comparisons,
      generatedAt: new Date().toISOString()
    };
    await this.audit.record({
      userId: user?.id && uuidPattern.test(user.id) ? user.id : undefined,
      module: "import",
      action: "reconcile",
      entity: "ImportBatch",
      entityId: batchId,
      after: { status, certified, pendingErrors, metrics: comparisons }
    });
    return result;
  }

  async certify(batchId: string, reason: string | undefined, user?: CurrentUser) {
    const normalizedReason = reason?.trim() ?? "";
    if (normalizedReason.length < 10) {
      throw new BadRequestException("Informe um motivo de certificacao com pelo menos 10 caracteres.");
    }
    const report = await this.report(batchId, user);
    if (!report.eligibleForCertification) {
      throw new BadRequestException("O lote possui divergencias ou inconsistencias pendentes e nao pode ser certificado.");
    }
    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: { status: "CERTIFIED", completedAt: new Date() }
    });
    const result = { ...report, batchStatus: "CERTIFIED", certified: true, certificationReason: normalizedReason };
    await this.audit.record({
      userId: user?.id && uuidPattern.test(user.id) ? user.id : undefined,
      module: "import",
      action: "certify_reconciliation",
      entity: "ImportBatch",
      entityId: batchId,
      reason: normalizedReason,
      before: { status: report.batchStatus },
      after: { status: "CERTIFIED", metrics: report.metrics }
    });
    return result;
  }

  private sourceTotals(summary: unknown): SourceTotals | null {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
    const raw = (summary as Record<string, unknown>).sourceTotals;
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
      downtimeRows: numeric(value.downtimeRows),
      downtimeMinutes: numeric(value.downtimeMinutes),
      bySector: value.bySector && typeof value.bySector === "object" && !Array.isArray(value.bySector)
        ? value.bySector as Record<string, unknown>
        : undefined
    };
  }

  private tolerance(key: string, fallback: number) {
    const configured = Number(process.env[key] ?? fallback);
    return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
  }
}
