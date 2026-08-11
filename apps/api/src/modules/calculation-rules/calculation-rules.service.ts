import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  CALCULATION_RULES,
  type CalculationRuleDefinition,
  type CalculationRuleId
} from "../../domain/calculations/rule-registry";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";

const actorIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decisionSchema = z.object({
  reason: z.string().trim().min(10, "Motivo deve possuir ao menos 10 caracteres.").max(500)
}).strict();

const approvalInclude = {
  approver: { select: { id: true, name: true, email: true } },
  retirer: { select: { id: true, name: true, email: true } }
} satisfies Prisma.CalculationRuleApprovalInclude;

type RuleDecisionClient = Pick<
  Prisma.TransactionClient,
  "calculationRuleApproval" | "$executeRaw"
>;

interface RuleVersion {
  ruleId: CalculationRuleId;
  ruleVersion: number;
}

function registryRule(ruleId: string): CalculationRuleDefinition | undefined {
  return (CALCULATION_RULES as Readonly<Record<string, CalculationRuleDefinition>>)[ruleId];
}

function requiredReviewRules(snapshot: Prisma.JsonValue): RuleVersion[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new ConflictException(
      "Snapshot de regras ausente ou inválido; aprovação operacional bloqueada."
    );
  }

  const snapshotEntries = Object.entries(snapshot);
  if (!snapshotEntries.length) {
    throw new ConflictException(
      "Snapshot não identifica regra conhecida; aprovação operacional bloqueada."
    );
  }
  const unknownRules = snapshotEntries
    .map(([ruleId]) => ruleId)
    .filter((ruleId) => !registryRule(ruleId));
  if (unknownRules.length) {
    throw new ConflictException(
      `Snapshot contém regra(s) não reconhecida(s): ${unknownRules.join(", ")}.`
    );
  }

  return snapshotEntries.flatMap(([ruleId, rawVersion]) => {
    const rule = registryRule(ruleId)!;
    if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion <= 0) {
      throw new ConflictException(
        `Snapshot inválido para ${ruleId}; aprovação operacional bloqueada.`
      );
    }
    if (rule.status !== "REVIEW_REQUIRED") return [];
    return [{ ruleId: rule.id, ruleVersion: rawVersion }];
  });
}

async function lockRuleVersion(
  transaction: Pick<Prisma.TransactionClient, "$executeRaw">,
  ruleId: string,
  ruleVersion: number
) {
  const lockKey = `nexus:calculation-rule:${ruleId}:${ruleVersion}`;
  await transaction.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
  );
}

export async function assertReviewRequiredCalculationRulesApproved(
  transaction: RuleDecisionClient,
  snapshot: Prisma.JsonValue
) {
  const required = requiredReviewRules(snapshot)
    .sort((left, right) => `${left.ruleId}:${left.ruleVersion}`.localeCompare(`${right.ruleId}:${right.ruleVersion}`));
  if (!required.length) return;

  for (const rule of required) {
    await lockRuleVersion(transaction, rule.ruleId, rule.ruleVersion);
  }

  const approvals = await transaction.calculationRuleApproval.findMany({
    where: {
      status: "APPROVED",
      OR: required.map((rule) => ({
        ruleId: rule.ruleId,
        ruleVersion: rule.ruleVersion
      }))
    },
    select: { ruleId: true, ruleVersion: true }
  });
  const approved = new Set(approvals.map((item) => `${item.ruleId}:${item.ruleVersion}`));
  const missing = required.filter((item) => !approved.has(`${item.ruleId}:${item.ruleVersion}`));

  if (missing.length) {
    const details = missing.map((item) => `${item.ruleId}@${item.ruleVersion}`).join(", ");
    throw new ConflictException(
      `Aprovação bloqueada: regra(s) REVIEW_REQUIRED sem aprovação vigente: ${details}.`
    );
  }
}

@Injectable()
export class CalculationRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list() {
    const decisions = await this.prisma.calculationRuleApproval.findMany({
      include: approvalInclude,
      orderBy: [{ ruleId: "asc" }, { ruleVersion: "desc" }]
    });
    const byVersion = new Map(
      decisions.map((decision) => [`${decision.ruleId}:${decision.ruleVersion}`, decision])
    );

    return Object.values(CALCULATION_RULES)
      .map((rule) => {
        const approval = byVersion.get(`${rule.id}:${rule.version}`) ?? null;
        const governanceStatus = rule.status === "ACTIVE"
          ? "NOT_REQUIRED"
          : approval?.status ?? "PENDING_REVIEW";
        return { ...rule, governanceStatus, approval };
      })
      .sort((left, right) => {
        const reviewOrder = Number(right.status === "REVIEW_REQUIRED") - Number(left.status === "REVIEW_REQUIRED");
        return reviewOrder || left.id.localeCompare(right.id);
      });
  }

  async approve(ruleId: string, ruleVersion: number, payload: unknown, user?: CurrentUser) {
    const { reason } = decisionSchema.parse(payload);
    const actorId = this.actorId(user);
    const rule = this.currentReviewRule(ruleId, ruleVersion);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await lockRuleVersion(transaction, rule.id, rule.version);
        const current = await transaction.calculationRuleApproval.findUnique({
          where: { ruleId_ruleVersion: { ruleId: rule.id, ruleVersion: rule.version } },
          include: approvalInclude
        });
        if (current?.status === "APPROVED") {
          throw new ConflictException("Esta versão da regra já está aprovada.");
        }
        if (current?.status === "RETIRED") {
          throw new ConflictException(
            "Versão retirada não pode ser reativada. Publique nova versão no registry."
          );
        }

        const approved = await transaction.calculationRuleApproval.create({
          data: {
            ruleId: rule.id,
            ruleVersion: rule.version,
            status: "APPROVED",
            approvedAt: new Date(),
            approvedBy: actorId,
            approvalReason: reason
          },
          include: approvalInclude
        });
        await this.audit.record({
          userId: actorId,
          module: "calculation-rules",
          action: "approve",
          entity: "CalculationRuleApproval",
          entityId: approved.id,
          after: approved,
          reason
        }, transaction);
        return approved;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  async retire(ruleId: string, ruleVersion: number, payload: unknown, user?: CurrentUser) {
    const { reason } = decisionSchema.parse(payload);
    const actorId = this.actorId(user);
    if (!registryRule(ruleId)) throw new NotFoundException("Regra de cálculo não encontrada no registry.");
    if (!Number.isInteger(ruleVersion) || ruleVersion <= 0) {
      throw new BadRequestException("Versão da regra deve ser inteiro positivo.");
    }

    return this.prisma.$transaction(async (transaction) => {
      await lockRuleVersion(transaction, ruleId, ruleVersion);
      const current = await transaction.calculationRuleApproval.findUnique({
        where: { ruleId_ruleVersion: { ruleId, ruleVersion } },
        include: approvalInclude
      });
      if (!current) throw new NotFoundException("Aprovação desta versão não encontrada.");
      if (current.status !== "APPROVED") {
        throw new ConflictException("Esta versão da regra já está retirada.");
      }

      const retired = await transaction.calculationRuleApproval.update({
        where: { id: current.id },
        data: {
          status: "RETIRED",
          retiredAt: new Date(),
          retiredBy: actorId,
          retirementReason: reason
        },
        include: approvalInclude
      });
      await this.audit.record({
        userId: actorId,
        module: "calculation-rules",
        action: "retire",
        entity: "CalculationRuleApproval",
        entityId: retired.id,
        before: current,
        after: retired,
        reason
      }, transaction);
      return retired;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private currentReviewRule(ruleId: string, ruleVersion: number) {
    const rule = registryRule(ruleId);
    if (!rule) throw new NotFoundException("Regra de cálculo não encontrada no registry.");
    if (rule.status !== "REVIEW_REQUIRED") {
      throw new BadRequestException("Regra ACTIVE não exige decisão humana adicional.");
    }
    if (rule.version !== ruleVersion) {
      throw new ConflictException(
        `Versão ${ruleVersion} não é versão atual ${rule.version} do registry.`
      );
    }
    return rule;
  }

  private actorId(user?: CurrentUser) {
    if (!user?.id || !actorIdPattern.test(user.id)) {
      throw new BadRequestException("Administrador autenticado inválido para decisão da regra.");
    }
    return user.id;
  }

  private rethrowConflict(error: unknown): never {
    if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException) {
      throw error;
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && (error.code === "P2002" || error.code === "P2034")
    ) {
      throw new ConflictException("Decisão concorrente detectada. Atualize lista e tente novamente.");
    }
    throw error;
  }
}
