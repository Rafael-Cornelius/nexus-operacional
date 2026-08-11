import {
  LossTypeCode,
  PrismaClient,
  ProductionFormula,
  SectorCode,
} from "@prisma/client";
import {
  bootstrapProduction,
  parseProductionBootstrapConfig,
} from "./production-bootstrap";

if (process.env.NODE_ENV === "production") {
  throw new Error("Seed de demonstracao recusado em NODE_ENV=production.");
}
if (process.env.ALLOW_DEMO_SEED !== "true") {
  throw new Error(
    "Defina ALLOW_DEMO_SEED=true para confirmar seed local de demonstracao.",
  );
}

const prisma = new PrismaClient();

async function seedDemoCatalog() {
  await prisma.$transaction(async (transaction) => {
    const p1 = await transaction.sector.upsert({
      where: { code: SectorCode.P1 },
      create: { code: SectorCode.P1, name: "P1 - Pao de Queijo" },
      update: { name: "P1 - Pao de Queijo" },
    });
    const p2 = await transaction.sector.upsert({
      where: { code: SectorCode.P2 },
      create: { code: SectorCode.P2, name: "P2 - Bolos e Churros" },
      update: { name: "P2 - Bolos e Churros" },
    });

    const p1Line = await transaction.productionLine.upsert({
      where: { sectorId_code: { sectorId: p1.id, code: "P1-L1" } },
      create: { sectorId: p1.id, code: "P1-L1", name: "Linha P1 principal" },
      update: { name: "Linha P1 principal", active: true, deletedAt: null },
    });
    const p2Line = await transaction.productionLine.upsert({
      where: { sectorId_code: { sectorId: p2.id, code: "P2-L1" } },
      create: { sectorId: p2.id, code: "P2-L1", name: "Linha P2 principal" },
      update: { name: "Linha P2 principal", active: true, deletedAt: null },
    });

    for (const shift of [
      {
        code: "T1",
        name: "Turno 1",
        startsAt: new Date("1970-01-01T06:00:00.000Z"),
        endsAt: new Date("1970-01-01T14:00:00.000Z"),
      },
      {
        code: "T2",
        name: "Turno 2",
        startsAt: new Date("1970-01-01T14:00:00.000Z"),
        endsAt: new Date("1970-01-01T22:00:00.000Z"),
      },
      {
        code: "T3",
        name: "Turno 3",
        startsAt: new Date("1970-01-01T22:00:00.000Z"),
        endsAt: new Date("1970-01-01T06:00:00.000Z"),
      },
    ]) {
      await transaction.shift.upsert({
        where: { code: shift.code },
        create: shift,
        update: {
          name: shift.name,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          active: true,
          deletedAt: null,
        },
      });
    }

    for (const equipment of [
      {
        productionLineId: p1Line.id,
        code: "M1",
        name: "Maquina 1",
        type: "PROCESSAMENTO",
      },
      {
        productionLineId: p1Line.id,
        code: "MQ",
        name: "Maquina MQ",
        type: "PROCESSAMENTO",
      },
      {
        productionLineId: p1Line.id,
        code: "GIRO",
        name: "Giro",
        type: "RESFRIAMENTO",
      },
      {
        productionLineId: p1Line.id,
        code: "FREEZER",
        name: "Freezer",
        type: "CONGELAMENTO",
      },
      {
        productionLineId: p2Line.id,
        code: "M1",
        name: "Maquina 1",
        type: "PROCESSAMENTO",
      },
      {
        productionLineId: p2Line.id,
        code: "FREEZER",
        name: "Freezer",
        type: "CONGELAMENTO",
      },
    ]) {
      await transaction.equipment.upsert({
        where: {
          productionLineId_code: {
            productionLineId: equipment.productionLineId,
            code: equipment.code,
          },
        },
        create: equipment,
        update: {
          name: equipment.name,
          type: equipment.type,
          active: true,
          deletedAt: null,
        },
      });
    }

    for (const lossType of [
      { code: LossTypeCode.PACKAGING, name: "Embalagem", defaultGoalKg: 20 },
      { code: LossTypeCode.BOX, name: "Caixa", defaultGoalKg: 10 },
      { code: LossTypeCode.ORGANIC, name: "Organico", defaultGoalKg: 50 },
      { code: LossTypeCode.MACHINE, name: "Maquina", defaultGoalKg: 10 },
      { code: LossTypeCode.WEIGHING, name: "Pesagem", defaultGoalKg: 50 },
      { code: LossTypeCode.OVERWEIGHT, name: "Sobrepeso", defaultGoalKg: null },
      { code: LossTypeCode.OTHER, name: "Outros", defaultGoalKg: 10 },
    ]) {
      await transaction.lossType.upsert({
        where: { code: lossType.code },
        create: lossType,
        update: lossType,
      });
    }

    for (const name of [
      "Aguardando massa",
      "Aguardando embalagem",
      "Aguardando silo",
      "Troca de arame",
      "Falta de materia-prima",
      "Aguardando manutencao",
      "Setup/troca de produto",
      "Limpeza",
      "Aguardando temperatura",
      "Aguardando congelar",
      "Outros",
    ]) {
      await transaction.downtimeReason.upsert({
        where: { name },
        create: { name },
        update: { active: true },
      });
    }

    const demoProduct = await transaction.product.upsert({
      where: { code: "72169" },
      create: {
        code: "72169",
        name: "PAO DE QUEIJO REI DO MATE 13g x 1kg",
        defaultSectorId: p1.id,
        unit: "kg",
      },
      update: {
        name: "PAO DE QUEIJO REI DO MATE 13g x 1kg",
        defaultSectorId: p1.id,
        unit: "kg",
        active: true,
        deletedAt: null,
      },
    });

    await transaction.productWeightConfig.upsert({
      where: { productId: demoProduct.id },
      create: {
        productId: demoProduct.id,
        packageWeightKg: 1,
        boxWeightKg: 12,
        packagesPerBox: 12,
        massWeightKg: 511,
        targetPackageWeightG: 1000,
        overweightTolerancePercent: 0.02,
        formula: ProductionFormula.BOX_WEIGHT,
      },
      update: {
        packageWeightKg: 1,
        boxWeightKg: 12,
        packagesPerBox: 12,
        massWeightKg: 511,
        targetPackageWeightG: 1000,
        overweightTolerancePercent: 0.02,
        formula: ProductionFormula.BOX_WEIGHT,
      },
    });
  });
}

async function main() {
  await bootstrapProduction(
    prisma,
    parseProductionBootstrapConfig(process.env),
  );
  await seedDemoCatalog();
  console.info("Seed local de demonstracao concluido.");
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Falha desconhecida no seed de demonstracao.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
