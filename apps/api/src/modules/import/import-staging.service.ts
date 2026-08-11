import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ImportReviewDecision,
  ImportStagingClassification,
  ImportStagingDomain,
  Prisma
} from "@prisma/client";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";
import { promotionBlockerWhere } from "./import-staging-policy";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const editableBatchStatuses = ["STAGED", "FAILED"] as const;
const classifications = new Set(Object.values(ImportStagingClassification));
const decisions = new Set(Object.values(ImportReviewDecision));
const domains = new Set(Object.values(ImportStagingDomain));

export type StagingReviewAction = "APPROVE" | "IGNORE" | "REJECT";

@Injectable()
export class ImportStagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(
    batchId: string,
    query: { domain?: string; classification?: string; decision?: string; take?: string; skip?: string }
  ) {
    this.assertUuid(batchId, "Lote de importacao invalido.");
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { id: true, status: true, originalFileName: true, sourceFile: true }
    });
    if (!batch) throw new NotFoundException("Lote de importacao nao encontrado.");

    const domain = this.optionalEnum(query.domain, domains, "Dominio de staging invalido.");
    const classification = this.optionalEnum(
      query.classification,
      classifications,
      "Classificacao de staging invalida."
    );
    const decision = this.optionalEnum(query.decision, decisions, "Decisao de staging invalida.");
    const take = this.boundedInteger(query.take, 100, 1, 500);
    const skip = this.boundedInteger(query.skip, 0, 0, 100_000);

    const [records, total] = await Promise.all([
      this.prisma.importStagingRecord.findMany({
        where: {
          batchId,
          domain: domain as ImportStagingDomain | undefined,
          classification: classification as ImportStagingClassification | undefined,
          decision: decision as ImportReviewDecision | undefined
        },
        orderBy: [{ sheetName: "asc" }, { rowNumber: "asc" }, { createdAt: "asc" }],
        take,
        skip
      }),
      this.prisma.importStagingRecord.count({
        where: {
          batchId,
          domain: domain as ImportStagingDomain | undefined,
          classification: classification as ImportStagingClassification | undefined,
          decision: decision as ImportReviewDecision | undefined
        }
      })
    ]);

    return {
      batch,
      pagination: { total, take, skip, hasMore: skip + records.length < total },
      records
    };
  }

  async summary(batchId: string) {
    this.assertUuid(batchId, "Lote de importacao invalido.");
    const batch = await this.prisma.importBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        status: true,
        originalFileName: true,
        sourceFile: true,
        fileHash: true,
        importerVersion: true,
        promotedAt: true
      }
    });
    if (!batch) throw new NotFoundException("Lote de importacao nao encontrado.");
    const [byDomain, byClassification, byDecision, promotionBlockers] = await Promise.all([
      this.prisma.importStagingRecord.groupBy({ by: ["domain"], where: { batchId }, _count: { _all: true } }),
      this.prisma.importStagingRecord.groupBy({ by: ["classification"], where: { batchId }, _count: { _all: true } }),
      this.prisma.importStagingRecord.groupBy({ by: ["decision"], where: { batchId }, _count: { _all: true } }),
      this.prisma.importStagingRecord.count({
        where: promotionBlockerWhere(batchId)
      })
    ]);
    return {
      batch,
      totals: {
        records: byDomain.reduce((sum, row) => sum + row._count._all, 0),
        promotionBlockers,
        byDomain: Object.fromEntries(byDomain.map((row) => [row.domain, row._count._all])),
        byClassification: Object.fromEntries(byClassification.map((row) => [row.classification, row._count._all])),
        byDecision: Object.fromEntries(byDecision.map((row) => [row.decision, row._count._all]))
      }
    };
  }

  async correct(
    batchId: string,
    recordId: string,
    body: { value?: unknown; reason?: string; version?: number },
    user?: CurrentUser
  ) {
    const reason = this.reason(body.reason, "correcao");
    const version = this.version(body.version);
    const userId = this.requireUserId(user);
    return this.prisma.$transaction(async (tx) => {
      const record = await this.editableRecord(batchId, recordId, tx);
      const correctedValue = this.assertDomainValue(record.domain, body.value);
      const classification = this.correctionClassification(record.domain, correctedValue);
      const changed = await tx.importStagingRecord.updateMany({
        where: { id: recordId, batchId, version, promotedAt: null },
        data: {
          correctedValue: correctedValue as Prisma.InputJsonValue,
          classification,
          decision: "CORRECTED",
          resolutionReason: reason,
          resolvedBy: userId,
          resolvedAt: new Date(),
          version: { increment: 1 }
        }
      });
      if (changed.count !== 1) throw new ConflictException("Registro alterado por outro usuario. Recarregue o staging.");
      await this.resolveMatchingErrors(record, "CORRECTED", reason, userId, tx);
      const updated = await tx.importStagingRecord.findUniqueOrThrow({ where: { id: recordId } });
      await this.audit.record({
        userId,
        module: "import",
        action: "correct_staging_record",
        entity: "ImportStagingRecord",
        entityId: recordId,
        reason,
        before: this.auditSnapshot(record),
        after: this.auditSnapshot(updated)
      }, tx);
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async review(
    batchId: string,
    recordId: string,
    body: { action?: StagingReviewAction; reason?: string; version?: number },
    user?: CurrentUser
  ) {
    const action = body.action;
    if (!action || !["APPROVE", "IGNORE", "REJECT"].includes(action)) {
      throw new BadRequestException("Acao deve ser APPROVE, IGNORE ou REJECT.");
    }
    const reason = this.reason(body.reason, "revisao");
    const version = this.version(body.version);
    const decision: ImportReviewDecision =
      action === "APPROVE" ? "APPROVED" : action === "IGNORE" ? "IGNORED" : "REJECTED";
    const userId = this.requireUserId(user);
    return this.prisma.$transaction(async (tx) => {
      const record = await this.editableRecord(batchId, recordId, tx);
      if (action === "APPROVE" && ["DOSAGE", "HISTORY"].includes(record.domain)) {
        throw new ConflictException(
          "Registro em quarentena nao possui chave operacional suficiente; use rejeicao ou descarte justificado."
        );
      }
      if (action === "APPROVE" && ["ERROR", "DUPLICATE"].includes(record.classification)) {
        throw new ConflictException("Registro com erro ou duplicidade exige correcao, rejeicao ou descarte.");
      }
      if (action === "APPROVE") {
        this.assertDomainValue(record.domain, record.correctedValue ?? record.interpretedValue);
      }
      const changed = await tx.importStagingRecord.updateMany({
        where: { id: recordId, batchId, version, promotedAt: null },
        data: {
          decision,
          resolutionReason: reason,
          resolvedBy: userId,
          resolvedAt: new Date(),
          version: { increment: 1 }
        }
      });
      if (changed.count !== 1) throw new ConflictException("Registro alterado por outro usuario. Recarregue o staging.");
      await this.resolveMatchingErrors(
        record,
        decision === "APPROVED" ? "CORRECTED" : "IGNORED",
        reason,
        userId,
        tx
      );
      const updated = await tx.importStagingRecord.findUniqueOrThrow({ where: { id: recordId } });
      await this.audit.record({
        userId,
        module: "import",
        action: `${action.toLowerCase()}_staging_record`,
        entity: "ImportStagingRecord",
        entityId: recordId,
        reason,
        before: this.auditSnapshot(record),
        after: this.auditSnapshot(updated)
      }, tx);
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  assertDomainValue(domain: ImportStagingDomain, value: unknown): Record<string, unknown> {
    if (domain === "UNKNOWN") {
      throw new BadRequestException("Inconsistencia sem dominio exige rejeicao ou descarte; nao pode ser promovida.");
    }
    if (["DOSAGE", "HISTORY"].includes(domain)) {
      throw new BadRequestException(
        "Registro em quarentena preserva a fonte, mas nao pode ser corrigido ou promovido sem fluxo operacional dedicado."
      );
    }
    const row = this.object(value, "Valor interpretado deve ser um objeto JSON.");
    if (domain === "PRODUCT") {
      this.text(row, "code");
      this.text(row, "name");
      this.text(row, "unit");
      if (typeof row.active !== "boolean") throw new BadRequestException("Campo active deve ser booleano.");
      this.oneOf(row, "defaultSector", ["P1", "P2"]);
      this.number(row, "packageWeightKg", Number.EPSILON);
      this.number(row, "boxWeightKg", Number.EPSILON);
      this.integer(row, "packagesPerBox", 1);
      this.number(row, "massWeightKg", Number.EPSILON);
      this.number(row, "targetPackageWeightG", Number.EPSILON);
      this.number(row, "overweightTolerancePercent", 0, 1);
      this.optionalNumber(row, "pricePerKg", Number.EPSILON);
      this.oneOf(row, "formula", ["BOX_WEIGHT", "PACKAGE_WEIGHT"]);
    } else if (domain === "PRODUCTION") {
      this.oneOf(row, "sector", ["P1", "P2"]);
      this.date(row, "date");
      this.text(row, "productCode");
      this.text(row, "productionOrder");
      this.integer(row, "legacyWeekNumber", 1, 6);
      for (const field of ["plannedBatches", "realizedBatches", "usedReworkKg", "packedBoxes", "weighingLossKg", "generatedReworkKg"]) {
        this.number(row, field, 0);
      }
      this.optionalNumber(row, "averagePackageWeightG", 0);
      this.optionalNumber(row, "pricePerKg", 0);
    } else if (domain === "LOSS") {
      this.date(row, "date");
      this.oneOf(row, "sector", ["P1", "P2"]);
      this.text(row, "productCode");
      this.number(row, "quantityKg", 0);
      for (const field of [
        "filmShift1Kg",
        "filmShift2Kg",
        "boxLossUnits",
        "boxLossShift1Units",
        "boxLossShift2Units"
      ]) {
        this.number(row, field, 0);
      }
      for (const field of ["boxLossUnits", "boxLossShift1Units", "boxLossShift2Units"]) {
        if (!Number.isSafeInteger(row[field])) {
          throw new BadRequestException(`Campo ${field} deve preservar caixas em unidades inteiras.`);
        }
      }
      const filmParts = Number(row.filmShift1Kg) + Number(row.filmShift2Kg);
      const boxParts = Number(row.boxLossShift1Units) + Number(row.boxLossShift2Units);
      if (Number(row.quantityKg) <= 0 && Number(row.boxLossUnits) <= 0) {
        throw new BadRequestException("Perda deve possuir filme em kg ou caixas em unidades.");
      }
      if (Math.abs(Number(row.quantityKg) - filmParts) > 0.001) {
        throw new BadRequestException("Total de filme deve conferir com T1 + T2.");
      }
      if (Math.abs(Number(row.boxLossUnits ?? 0) - boxParts) > 0.001) {
        throw new BadRequestException("Total de caixas deve conferir com T1 + T2, sem conversao para kg.");
      }
      this.text(row, "legacyLine");
      this.oneOf(row, "lossType", ["PACKAGING"]);
    } else if (domain === "DOWNTIME") {
      this.oneOf(row, "sector", ["P1", "P2"]);
      this.uuid(row, "lineId");
      this.uuid(row, "downtimeReasonId");
      this.date(row, "date");
      this.time(row, "productionStart");
      this.time(row, "productionEnd");
      this.time(row, "downtimeStart");
      this.time(row, "downtimeEnd");
      this.number(row, "producedMassKg", 0);
      for (const field of ["productionStartDate", "productionEndDate", "downtimeStartDate", "downtimeEndDate"]) {
        if (row[field] !== null && row[field] !== undefined) this.date(row, field);
      }
      this.text(row, "reason");
      this.text(row, "legacyLine");
      if (row.legacyWeekNumber !== null && row.legacyWeekNumber !== undefined) {
        this.integer(row, "legacyWeekNumber", 1, 6);
      }
      const startDate = typeof row.productionStartDate === "string" ? row.productionStartDate : row.date as string;
      const endDate = typeof row.productionEndDate === "string" ? row.productionEndDate : row.date as string;
      const stopStartDate = typeof row.downtimeStartDate === "string" ? row.downtimeStartDate : row.date as string;
      const stopEndDate = typeof row.downtimeEndDate === "string" ? row.downtimeEndDate : row.date as string;
      const productionStart = new Date(startDate + "T" + row.productionStart + ".000Z");
      const productionEnd = new Date(endDate + "T" + row.productionEnd + ".000Z");
      const downtimeStart = new Date(stopStartDate + "T" + row.downtimeStart + ".000Z");
      const downtimeEnd = new Date(stopEndDate + "T" + row.downtimeEnd + ".000Z");
      if (productionEnd <= productionStart) {
        throw new BadRequestException("Termino da producao exige data posterior explicita; nao presuma virada da meia-noite.");
      }
      if (downtimeEnd <= downtimeStart) {
        throw new BadRequestException("Termino da parada exige data posterior explicita; nao presuma virada da meia-noite.");
      }
    }
    return row;
  }

  private correctionClassification(domain: ImportStagingDomain, row: Record<string, unknown>): ImportStagingClassification {
    if (domain === "PRODUCT" && (row.pricePerKg === null || row.pricePerKg === undefined)) {
      return "REQUIRES_REVIEW";
    }
    if (domain === "PRODUCTION") {
      if (row.sector === "P1") return "REQUIRES_REVIEW";
      const planned = Number(row.plannedBatches);
      const realized = Number(row.realizedBatches);
      if ((planned === 0 && realized > 0) || (planned > 0 && realized > planned * 1.1)) return "REQUIRES_REVIEW";
    }
    if (domain === "DOWNTIME") {
      const date = row.date as string;
      const stamp = (timeField: string, dateField: string) => new Date(
        String(row[dateField] ?? date) + "T" + String(row[timeField]) + ".000Z"
      );
      if (stamp("downtimeStart", "downtimeStartDate") < stamp("productionStart", "productionStartDate") ||
          stamp("downtimeEnd", "downtimeEndDate") > stamp("productionEnd", "productionEndDate")) {
        return "REQUIRES_REVIEW";
      }
    }
    return "VALID";
  }

  private async editableRecord(batchId: string, recordId: string, client: Prisma.TransactionClient | PrismaService = this.prisma) {
    this.assertUuid(batchId, "Lote de importacao invalido.");
    this.assertUuid(recordId, "Registro de staging invalido.");
    const record = await client.importStagingRecord.findFirst({
      where: { id: recordId, batchId },
      include: { batch: { select: { status: true } } }
    });
    if (!record) throw new NotFoundException("Registro de staging nao encontrado.");
    if (!editableBatchStatuses.includes(record.batch.status as (typeof editableBatchStatuses)[number])) {
      throw new ConflictException("Lote nao permite revisao neste estado.");
    }
    if (record.promotedAt) throw new ConflictException("Registro ja promovido e imutavel no staging.");
    return record;
  }

  private async resolveMatchingErrors(
    record: { batchId: string; sheetName: string | null; rowNumber: number | null },
    status: "CORRECTED" | "IGNORED",
    reason: string,
    userId?: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    await client.importError.updateMany({
      where: { batchId: record.batchId, sheetName: record.sheetName, rowNumber: record.rowNumber, status: "PENDING" },
      data: { status, resolutionNotes: reason, resolvedBy: userId, resolvedAt: new Date() }
    });
  }

  private auditSnapshot(record: {
    batchId: string;
    domain: ImportStagingDomain;
    classification: ImportStagingClassification;
    decision: ImportReviewDecision;
    version: number;
    sourceFingerprint: string;
    interpretedValue?: Prisma.JsonValue | null;
    correctedValue?: Prisma.JsonValue | null;
    validationIssues?: Prisma.JsonValue | null;
    resolutionReason?: string | null;
    resolvedBy?: string | null;
    resolvedAt?: Date | null;
  }) {
    return {
      batchId: record.batchId,
      domain: record.domain,
      classification: record.classification,
      decision: record.decision,
      version: record.version,
      sourceFingerprint: record.sourceFingerprint,
      interpretedValue: record.interpretedValue ?? null,
      correctedValue: record.correctedValue ?? null,
      validationIssues: record.validationIssues ?? null,
      resolutionReason: record.resolutionReason ?? null,
      resolvedBy: record.resolvedBy ?? null,
      resolvedAt: record.resolvedAt ?? null
    };
  }

  private reason(value: string | undefined, action: string) {
    const normalized = value?.trim() ?? "";
    if (normalized.length < 10 || normalized.length > 1_000) {
      throw new BadRequestException(`Informe justificativa de ${action} entre 10 e 1000 caracteres.`);
    }
    return normalized;
  }

  private version(value: number | undefined) {
    if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
      throw new BadRequestException("Versao do registro de staging invalida.");
    }
    return value as number;
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }

  private requireUserId(user?: CurrentUser) {
    const userId = this.safeUserId(user);
    if (!userId) throw new BadRequestException("Usuario autenticado invalido para revisar staging.");
    return userId;
  }

  private assertUuid(value: string, message: string) {
    if (!uuidPattern.test(value)) throw new BadRequestException(message);
  }

  private optionalEnum(value: string | undefined, allowed: Set<string>, message: string) {
    if (!value) return undefined;
    if (!allowed.has(value)) throw new BadRequestException(message);
    return value;
  }

  private boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new BadRequestException(`Valor deve ser inteiro entre ${minimum} e ${maximum}.`);
    }
    return parsed;
  }

  private object(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(message);
    return value as Record<string, unknown>;
  }

  private text(row: Record<string, unknown>, field: string) {
    if (typeof row[field] !== "string" || !(row[field] as string).trim()) {
      throw new BadRequestException(`Campo ${field} deve ser texto nao vazio.`);
    }
  }

  private number(row: Record<string, unknown>, field: string, minimum?: number, maximum?: number) {
    const value = row[field];
    if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
      throw new BadRequestException(`Campo ${field} possui numero invalido.`);
    }
  }

  private optionalNumber(row: Record<string, unknown>, field: string, minimum?: number) {
    if (row[field] === null || row[field] === undefined) return;
    this.number(row, field, minimum);
  }

  private integer(row: Record<string, unknown>, field: string, minimum?: number, maximum?: number) {
    this.number(row, field, minimum, maximum);
    if (!Number.isSafeInteger(row[field])) throw new BadRequestException(`Campo ${field} deve ser inteiro.`);
  }

  private oneOf(row: Record<string, unknown>, field: string, allowed: string[]) {
    if (typeof row[field] !== "string" || !allowed.includes(row[field] as string)) {
      throw new BadRequestException(`Campo ${field} possui valor nao permitido.`);
    }
  }

  private uuid(row: Record<string, unknown>, field: string) {
    if (typeof row[field] !== "string" || !uuidPattern.test(row[field] as string)) {
      throw new BadRequestException(`Campo ${field} deve conter um UUID oficial valido.`);
    }
  }

  private date(row: Record<string, unknown>, field: string) {
    const value = row[field];
    const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00.000Z`)
      : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException(`Campo ${field} possui data invalida.`);
    }
  }

  private time(row: Record<string, unknown>, field: string) {
    const value = row[field];
    if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
      throw new BadRequestException(`Campo ${field} possui horario invalido.`);
    }
  }
}
