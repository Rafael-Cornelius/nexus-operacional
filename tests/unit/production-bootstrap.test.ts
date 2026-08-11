import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { strongPasswordSchema } from "../../apps/api/src/infrastructure/security/password-policy";
import {
  bootstrapProduction,
  parseProductionBootstrapConfig,
  type ProductionBootstrapConfig,
} from "../../prisma/production-bootstrap";

const repoRoot = join(import.meta.dirname, "../..");

const baseConfig: ProductionBootstrapConfig = {
  adminEmail: "responsavel@empresa.com.br",
  adminPassword: "Unica!Operacao9274",
  adminName: "Responsavel Operacional",
  rotateExistingPassword: false,
};

function bootstrapDatabase(
  existingAdmin: {
    id: string;
    active: boolean;
    deletedAt: Date | null;
  } | null = null,
) {
  const transaction = {
    permission: {
      upsert: vi.fn(async ({ where }: { where: { code: string } }) => ({
        id: `permission-${where.code}`,
      })),
    },
    role: {
      upsert: vi.fn(async ({ where }: { where: { code: string } }) => ({
        id: `role-${where.code}`,
      })),
    },
    rolePermission: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(existingAdmin),
      create: vi.fn().mockResolvedValue({ id: "admin-created" }),
      update: vi
        .fn()
        .mockResolvedValue({ id: existingAdmin?.id ?? "admin-created" }),
    },
    userRole: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    systemSetting: {
      upsert: vi.fn().mockResolvedValue({ id: "company" }),
    },
  };
  const prisma = {
    $transaction: vi.fn(
      async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  };
  return { prisma, transaction };
}

describe("clean production bootstrap", () => {
  it("requires explicit valid admin credentials and normalizes the email", () => {
    expect(() => parseProductionBootstrapConfig({})).toThrow(
      "INITIAL_ADMIN_EMAIL",
    );
    expect(() =>
      parseProductionBootstrapConfig({
        INITIAL_ADMIN_EMAIL: "admin@empresa.com.br",
        INITIAL_ADMIN_PASSWORD: "NexusDemo@2026",
      }),
    ).toThrow("credencial de demonstracao");

    expect(
      parseProductionBootstrapConfig({
        INITIAL_ADMIN_EMAIL: " RESPONSAVEL@EMPRESA.COM.BR ",
        INITIAL_ADMIN_PASSWORD: "Unica!Operacao9274",
        COMPANY_NAME: "  Industria Exemplo  ",
      }),
    ).toEqual({
      adminEmail: "responsavel@empresa.com.br",
      adminPassword: "Unica!Operacao9274",
      adminName: "Administrador Nexus",
      rotateExistingPassword: false,
      companyName: "Industria Exemplo",
    });
  });

  it("uses exactly the same strong password policy as user administration", () => {
    expect(strongPasswordSchema.safeParse("Unica!Operacao9274").success).toBe(
      true,
    );
    for (const password of [
      "curta!A1",
      "somente-minuscula!123",
      "SEM-MINUSCULA!123",
      "SemNumero!Senha",
      "SemSimboloSenha123",
      "NexusAdmin@2026",
    ]) {
      expect(strongPasswordSchema.safeParse(password).success).toBe(false);
      expect(() =>
        parseProductionBootstrapConfig({
          INITIAL_ADMIN_EMAIL: "admin@empresa.com.br",
          INITIAL_ADMIN_PASSWORD: password,
        }),
      ).toThrow();
    }
  });

  it("creates only access control, admin and explicitly supplied company setting", async () => {
    const { prisma, transaction } = bootstrapDatabase();
    const hashPassword = vi.fn().mockResolvedValue("hash-seguro");

    await expect(
      bootstrapProduction(
        prisma as never,
        { ...baseConfig, companyName: "Industria Real" },
        hashPassword,
      ),
    ).resolves.toEqual({ adminCreated: true, passwordRotated: false });

    expect(hashPassword).toHaveBeenCalledWith(baseConfig.adminPassword, 12);
    expect(transaction.user.create).toHaveBeenCalledWith({
      data: {
        email: baseConfig.adminEmail,
        name: baseConfig.adminName,
        passwordHash: "hash-seguro",
      },
      select: { id: true },
    });
    expect(transaction.userRole.createMany).toHaveBeenCalledWith({
      data: [{ userId: "admin-created", roleId: "role-ADMIN" }],
      skipDuplicates: true,
    });
    expect(transaction.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: "company" },
      create: { key: "company", value: { name: "Industria Real" } },
      update: { value: { name: "Industria Real" } },
    });
  });

  it("preserves an existing password unless rotation is explicit", async () => {
    const existing = { id: "admin-existing", active: true, deletedAt: null };
    const { prisma, transaction } = bootstrapDatabase(existing);
    const hashPassword = vi.fn().mockResolvedValue("novo-hash");

    await expect(
      bootstrapProduction(
        prisma as never,
        { ...baseConfig, adminPassword: undefined },
        hashPassword,
      ),
    ).resolves.toEqual({
      adminCreated: false,
      passwordRotated: false,
    });

    expect(hashPassword).not.toHaveBeenCalled();
    expect(transaction.user.create).not.toHaveBeenCalled();
    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(transaction.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("requires the password only when creating or intentionally rotating the administrator", async () => {
    expect(
      parseProductionBootstrapConfig({
        INITIAL_ADMIN_EMAIL: "admin@empresa.com.br",
        INITIAL_ADMIN_PASSWORD: "",
      }).adminPassword,
    ).toBeUndefined();

    const creation = bootstrapDatabase();
    await expect(
      bootstrapProduction(
        creation.prisma as never,
        { ...baseConfig, adminPassword: undefined },
        vi.fn(),
      ),
    ).rejects.toThrow("INITIAL_ADMIN_PASSWORD e obrigatoria para criar");
    expect(creation.transaction.user.create).not.toHaveBeenCalled();

    const existing = { id: "admin-existing", active: true, deletedAt: null };
    const rotation = bootstrapDatabase(existing);
    await expect(
      bootstrapProduction(
        rotation.prisma as never,
        {
          ...baseConfig,
          adminPassword: undefined,
          rotateExistingPassword: true,
        },
        vi.fn(),
      ),
    ).rejects.toThrow("INITIAL_ADMIN_PASSWORD e obrigatoria para rotacionar");
    expect(rotation.transaction.user.update).not.toHaveBeenCalled();
  });

  it("rotates intentionally and revokes existing sessions", async () => {
    const existing = { id: "admin-existing", active: true, deletedAt: null };
    const { prisma, transaction } = bootstrapDatabase(existing);
    const hashPassword = vi.fn().mockResolvedValue("novo-hash");

    await expect(
      bootstrapProduction(
        prisma as never,
        { ...baseConfig, rotateExistingPassword: true },
        hashPassword,
      ),
    ).resolves.toEqual({ adminCreated: false, passwordRotated: true });

    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { passwordHash: "novo-hash", sessionVersion: { increment: 1 } },
      select: { id: true },
    });
  });

  it("refuses to silently resurrect an inactive or deleted administrator", async () => {
    const { prisma, transaction } = bootstrapDatabase({
      id: "admin-inactive",
      active: false,
      deletedAt: null,
    });

    await expect(
      bootstrapProduction(prisma as never, baseConfig, vi.fn()),
    ).rejects.toThrow("usuario inativo ou excluido");
    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(transaction.userRole.createMany).not.toHaveBeenCalled();
  });

  it("keeps all demo and operational rows outside the default seed", () => {
    const productionSeed = ["prisma/seed.ts", "prisma/production-bootstrap.ts"]
      .map((path) => readFileSync(join(repoRoot, path), "utf8"))
      .join("\n");
    const demoSeed = readFileSync(
      join(repoRoot, "prisma/seed-demo.ts"),
      "utf8",
    );

    expect(productionSeed).not.toContain("72169");
    expect(productionSeed).not.toMatch(
      /transaction\.(?:product|productWeightConfig|goal|weeklyPeriod|productionEntry|lossEntry|downtimeEntry|equipment|shift|sector)\./,
    );
    expect(productionSeed).not.toContain("defaultGoalKg");
    expect(demoSeed).toContain("ALLOW_DEMO_SEED");
    expect(demoSeed).toContain('NODE_ENV === "production"');
    expect(demoSeed).toContain("72169");
  });

  it("proves a clean bootstrap without deleting application data", () => {
    const cleanProof = readFileSync(
      join(repoRoot, "scripts/assert_clean_operational_bootstrap.ts"),
      "utf8",
    );

    expect(cleanProof).toContain("information_schema.tables");
    expect(cleanProof).toContain("exclusivamente o papel ADMIN");
    expect(cleanProof).toContain("Banco não está zerado");
    expect(cleanProof).not.toMatch(/\b(?:DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i);
  });
});
