import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ProductsController } from "../../apps/api/src/modules/products/products.controller";
import { ProductsService } from "../../apps/api/src/modules/products/products.service";
import { ProductionService } from "../../apps/api/src/modules/production/production.service";
import { ROLES_KEY } from "../../apps/api/src/modules/auth/roles.decorator";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const productId = "2f08e255-87dc-40ca-83f6-5697fb660224";
const priceId = "8ac21ec6-b113-4e5f-9810-b4e18587eb99";
const responsibleId = "88a61adf-9717-45ea-88de-2ab1e3bc0cc0";
const approverId = "bd8cac9d-cb50-49a6-949b-3be2b715766a";
const responsible = { id: responsibleId, email: "responsavel@nexus.local", roles: ["SUPERVISOR"] };
const approver = { id: approverId, email: "gerente@nexus.local", roles: ["MANAGER"] };

function transactionPrisma<T extends object>(transaction: T) {
  return {
    $transaction: vi.fn((operation: (client: T) => unknown) => operation(transaction))
  };
}

describe("product price governance workflow", () => {
  it("restricts approval and retirement endpoints to administration and management", () => {
    expect(Reflect.getMetadata(ROLES_KEY, ProductsController.prototype.addPricePeriod)).toEqual(["ADMIN", "MANAGER", "SUPERVISOR"]);
    expect(Reflect.getMetadata(ROLES_KEY, ProductsController.prototype.approvePricePeriod)).toEqual(["ADMIN", "MANAGER"]);
    expect(Reflect.getMetadata(ROLES_KEY, ProductsController.prototype.retirePricePeriod)).toEqual(["ADMIN", "MANAGER"]);
  });

  it("approves a draft with independent approver, optimistic lock and audit", async () => {
    const current = {
      id: priceId,
      productId,
      status: "DRAFT",
      version: 4,
      recordVersion: 1,
      responsibleBy: responsibleId,
      currency: "BRL",
      origin: "Contrato 2026",
      startsOn: new Date("2026-08-01T00:00:00.000Z"),
      endsOn: null
    };
    const approved = { ...current, status: "APPROVED", recordVersion: 2, approvedBy: approverId };
    const findFirst = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(null);
    const update = vi.fn().mockResolvedValue(approved);
    const transaction = { productPricePeriod: { findFirst, update } };
    const audit = { record: vi.fn() };
    const service = new ProductsService(transactionPrisma(transaction) as never, audit as never);

    await expect(service.approvePricePeriod(productId, priceId, {
      recordVersion: 1,
      reason: "Contrato e vigencia conferidos"
    }, approver)).resolves.toEqual(approved);

    expect(update).toHaveBeenCalledWith({
      where: { id: priceId, recordVersion: 1 },
      data: expect.objectContaining({
        status: "APPROVED",
        approvedBy: approverId,
        approvalReason: "Contrato e vigencia conferidos",
        recordVersion: { increment: 1 }
      })
    });
    expect(update.mock.calls[0][0].data).not.toHaveProperty("version");
    expect(update.mock.calls[0][0].data).not.toHaveProperty("pricePerKg");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "approve_price", before: current, after: approved }), transaction);
  });

  it("blocks self-approval", async () => {
    const current = {
      id: priceId,
      productId,
      status: "DRAFT",
      version: 1,
      recordVersion: 1,
      responsibleBy: responsibleId,
      currency: "BRL",
      origin: "Cotacao",
      startsOn: new Date("2026-08-01T00:00:00.000Z"),
      endsOn: null
    };
    const update = vi.fn();
    const transaction = { productPricePeriod: { findFirst: vi.fn().mockResolvedValue(current), update } };
    const service = new ProductsService(transactionPrisma(transaction) as never, { record: vi.fn() } as never);

    await expect(service.approvePricePeriod(productId, priceId, {
      recordVersion: 1,
      reason: "Conferencia completa"
    }, responsible)).rejects.toThrow("nao pode aprovar o proprio");
    expect(update).not.toHaveBeenCalled();
  });

  it("retires without rewriting price definition or business version", async () => {
    const current = { id: priceId, productId, status: "APPROVED", version: 7, recordVersion: 2 };
    const retired = { ...current, status: "RETIRED", recordVersion: 3, retiredBy: approverId };
    const update = vi.fn().mockResolvedValue(retired);
    const transaction = { productPricePeriod: { findFirst: vi.fn().mockResolvedValue(current), update } };
    const audit = { record: vi.fn() };
    const service = new ProductsService(transactionPrisma(transaction) as never, audit as never);

    await expect(service.retirePricePeriod(productId, priceId, {
      recordVersion: 2,
      reason: "Contrato encerrado"
    }, approver)).resolves.toEqual(retired);
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "RETIRED", retiredBy: approverId, recordVersion: { increment: 1 } });
    for (const immutable of ["version", "startsOn", "endsOn", "pricePerKg", "filmCostPerKg", "currency", "origin"]) {
      expect(data).not.toHaveProperty(immutable);
    }
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "retire_price" }), transaction);
  });
});

describe("approved price financial source", () => {
  const input = {
    weekId: "11111111-1111-4111-8111-111111111111",
    sector: "P1" as const,
    date: new Date("2026-05-05T00:00:00.000Z"),
    productId,
    productionOrder: "OP-PRICE",
    plannedBatches: 10,
    realizedBatches: 10,
    usedReworkKg: 0,
    packedBoxes: 10,
    weighingLossKg: 1,
    generatedReworkKg: 0,
    averagePackageWeightG: 1000
  };

  function calculationPrisma(pricePeriod: object | null) {
    return {
      weeklyPeriod: { findUnique: vi.fn().mockResolvedValue({
        id: input.weekId,
        status: "OPEN",
        startsOn: new Date("2026-05-04T00:00:00.000Z"),
        endsOn: new Date("2026-05-10T00:00:00.000Z"),
        deletedAt: null
      }) },
      product: { findUnique: vi.fn().mockResolvedValue({
        id: productId,
        active: true,
        deletedAt: null,
        pricePerKg: 999,
        weightConfig: {
          formula: "BOX_WEIGHT",
          packageWeightKg: 1,
          boxWeightKg: 10,
          packagesPerBox: 10,
          massWeightKg: 10,
          targetPackageWeightG: 1000,
          overweightTolerancePercent: 0.02
        }
      }) },
      sector: { findUnique: vi.fn().mockResolvedValue({ id: "55555555-5555-4555-8555-555555555555", code: "P1" }) },
      productPricePeriod: { findFirst: vi.fn().mockResolvedValue(pricePeriod) }
    };
  }

  it("uses approved effective Decimal price and records its lineage", async () => {
    const pricePeriod = { id: priceId, pricePerKg: "12.3456", version: 3, origin: "Contrato 2026", currency: "BRL" };
    const prisma = calculationPrisma(pricePeriod);
    const service = new ProductionService(prisma as never, { record: vi.fn() } as never);
    const resolve = (service as unknown as { resolveEntry(value: typeof input): Promise<{ costs: { unitPricePerKg: number }; pricePeriod: typeof pricePeriod }> }).resolveEntry.bind(service);

    const result = await resolve(input);
    expect(result.costs.unitPricePerKg).toBe(12.3456);
    expect(result.pricePeriod).toBe(pricePeriod);
    expect(prisma.productPricePeriod.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ productId, status: "APPROVED" })
    }));
  });

  it("rejects calculation when only legacy product cache exists", async () => {
    const prisma = calculationPrisma(null);
    const service = new ProductionService(prisma as never, { record: vi.fn() } as never);
    const resolve = (service as unknown as { resolveEntry(value: typeof input): Promise<unknown> }).resolveEntry.bind(service);

    await expect(resolve(input)).rejects.toThrow("sem preco aprovado vigente");
  });
});

describe("product price database migration", () => {
  it("keeps legacy prices unapproved and enforces immutable history plus launch lineage", () => {
    const migration = readFileSync(join(repoRoot, "prisma/migrations/0018_product_price_governance/migration.sql"), "utf8");
    expect(migration).toContain("CREATE TYPE \"ProductPriceStatus\" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED')");
    expect(migration).toContain("Permanecem\n-- DRAFT, sem moeda, origem, responsável ou aprovação presumidos.");
    expect(migration).toContain("prevent_product_price_business_mutation");
    expect(migration).toContain("product_price_periods_approved_metadata_required");
    expect(migration).toContain("product_price_periods_workflow_metadata_consistent");
    expect(migration).toContain("production_entries_price_lineage_complete");
    expect(migration).toContain("loss_entries_price_lineage_complete");
    expect(migration).toContain('DROP CONSTRAINT "product_price_periods_no_date_overlap"');
    expect(migration).toContain('CONSTRAINT "product_price_periods_no_approved_date_overlap"');
    expect(migration).toContain('WHERE ("status" = \'APPROVED\')');
  });

  it("blocks forged price decisions outside a valid versioned transition", () => {
    const migration = readFileSync(join(repoRoot, "prisma/migrations/0018_product_price_governance/migration.sql"), "utf8");
    const triggerFunction = migration.match(
      /CREATE OR REPLACE FUNCTION prevent_product_price_business_mutation\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/
    )?.[1] ?? "";

    expect(migration).toContain('BEFORE INSERT OR UPDATE ON "product_price_periods"');
    expect(triggerFunction).toContain("TG_OP = 'INSERT'");
    expect(triggerFunction).toContain("NEW.status <> 'DRAFT'");
    expect(triggerFunction).toContain("NEW.record_version <> 1");
    expect(triggerFunction).toContain("NEW.status IS NOT DISTINCT FROM OLD.status");
    expect(triggerFunction).toContain("Metadados de decisão do preço só podem mudar durante transição válida.");
    expect(triggerFunction).toContain("Aposentadoria não pode reescrever metadados de aprovação do preço.");
    expect(triggerFunction).toContain("Aprovação não pode gravar metadados de aposentadoria do preço.");
    for (const field of ["approved_by", "approved_at", "approval_reason", "retired_by", "retired_at", "retirement_reason"]) {
      expect(triggerFunction).toContain(`OLD.${field}`);
      expect(triggerFunction).toContain(`NEW.${field}`);
    }
  });

  it("validates semantic price lineage for production and losses in PostgreSQL", () => {
    const migration = readFileSync(join(repoRoot, "prisma/migrations/0018_product_price_governance/migration.sql"), "utf8");
    const productionValidation = migration.match(
      /CREATE OR REPLACE FUNCTION validate_production_entry_price_lineage\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/
    )?.[1] ?? "";
    const lossValidation = migration.match(
      /CREATE OR REPLACE FUNCTION validate_loss_entry_price_lineage\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/
    )?.[1] ?? "";

    for (const validation of [productionValidation, lossValidation]) {
      expect(validation).toContain("FOR SHARE");
      expect(validation).toContain("linked_price.product_id IS DISTINCT FROM NEW.product_id");
      expect(validation).toContain("linked_price.status <> 'APPROVED'");
      expect(validation).toContain("NEW.date < linked_price.starts_on");
      expect(validation).toContain("NEW.date > linked_price.ends_on");
      expect(validation).toContain("NEW.price_version IS DISTINCT FROM linked_price.version");
      expect(validation).toContain("NEW.price_origin IS DISTINCT FROM linked_price.origin");
      expect(validation).toContain("NEW.price_currency IS DISTINCT FROM linked_price.currency");
    }
    expect(productionValidation).toContain("NEW.unit_price_per_kg IS DISTINCT FROM linked_price.price_per_kg");
    expect(lossValidation).not.toContain("unit_price_per_kg");
    expect(migration).toContain('BEFORE INSERT ON "production_entries"');
    expect(migration).toContain('BEFORE UPDATE OF "price_period_id", "product_id", "date", "price_version", "price_origin", "price_currency", "unit_price_per_kg"');
    expect(migration).toContain('BEFORE INSERT ON "loss_entries"');
    expect(migration).toContain('BEFORE UPDATE OF "price_period_id", "product_id", "date", "price_version", "price_origin", "price_currency"');
    expect(migration.match(/"price_period_id" IS NULL/g)?.length).toBeGreaterThanOrEqual(2);
    expect(migration.match(/"price_period_id" IS NOT NULL/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
