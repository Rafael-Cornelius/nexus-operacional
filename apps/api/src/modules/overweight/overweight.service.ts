import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { calculateOverweightRanking } from "../../domain/calculations/overweight-calculations";

@Injectable()
export class OverweightService {
  constructor(private readonly prisma: PrismaService) {}

  async ranking(weekId?: string) {
    const rows = await this.prisma.productionEntry.groupBy({
      by: ["productId"],
      where: { deletedAt: null, workflowStatus: "APPROVED", weekId },
      _sum: { overweightTotalKg: true, producedKg: true },
      orderBy: { _sum: { overweightTotalKg: "desc" } },
      take: 10
    });
    const products = await this.prisma.product.findMany({
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
  }
}
