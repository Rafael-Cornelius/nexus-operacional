import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { calculateAverageKgPerDay } from "../../domain/calculations/productivity-calculations";

@Injectable()
export class ProductivityService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(weekId?: string) {
    const production = await this.prisma.productionEntry.aggregate({
      where: { deletedAt: null, workflowStatus: "APPROVED", weekId },
      _sum: { producedKg: true },
      _avg: { realYieldPercent: true },
      _count: true
    });
    const days = await this.prisma.productionEntry.groupBy({
      by: ["date"],
      where: { deletedAt: null, workflowStatus: "APPROVED", weekId },
      _sum: { producedKg: true },
      _avg: { realYieldPercent: true },
      orderBy: { date: "asc" }
    });
    const producedKg = Number(production._sum.producedKg ?? 0);
    return {
      producedKg,
      averageYield: Number(production._avg.realYieldPercent ?? 0),
      workedDays: days.length,
      averageKgPerDay: calculateAverageKgPerDay(producedKg, days.length),
      records: production._count,
      daily: days.map((day) => ({
        date: day.date,
        producedKg: Number(day._sum.producedKg ?? 0),
        averageYield: Number(day._avg.realYieldPercent ?? 0)
      }))
    };
  }
}
