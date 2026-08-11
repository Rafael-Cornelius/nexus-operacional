import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import {
  calculateOverweightRanking,
  OVERWEIGHT_RANKING_CALCULATION_RULE_VERSIONS
} from "../../domain/calculations/overweight-calculations";
import { assertReviewRequiredCalculationRulesApproved } from "../calculation-rules/calculation-rules.service";

@Injectable()
export class OverweightService {
  constructor(private readonly prisma: PrismaService) {}

  async ranking(weekId?: string) {
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.productionEntry.groupBy({
        by: ["productId"],
        where: { deletedAt: null, workflowStatus: "APPROVED", weekId },
        _sum: { overweightTotalKg: true, producedKg: true },
        orderBy: { _sum: { overweightTotalKg: "desc" } },
        take: 10
      });
      if (rows.length) {
        await assertReviewRequiredCalculationRulesApproved(
          transaction,
          OVERWEIGHT_RANKING_CALCULATION_RULE_VERSIONS as Prisma.JsonObject
        );
      }
      const products = await transaction.product.findMany({
        where: { id: { in: rows.map((row) => row.productId) } },
        include: { defaultSector: true, weightConfig: true }
      });
      return rows.map((row) => ({
        productId: row.productId,
        code: products.find((product) => product.id === row.productId)?.code ?? row.productId,
        product: products.find((product) => product.id === row.productId)?.name ?? row.productId,
        sector: products.find((product) => product.id === row.productId)?.defaultSector.code ?? "-",
        ...calculateOverweightRanking(
          Number(row._sum.overweightTotalKg ?? 0),
          Number(row._sum.producedKg ?? 0),
          Number(products.find((product) => product.id === row.productId)?.weightConfig?.overweightTolerancePercent ?? 0)
        )
      }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
