import { Prisma, PrismaClient, RoleCode } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { strongPasswordSchema } from "../apps/api/src/infrastructure/security/password-policy";

const permissions = [
  "dashboard:read",
  "production:write",
  "production:approve",
  "weeks:close",
  "weeks:reopen",
  "products:manage",
  "reports:export",
  "users:manage",
  "audit:read",
  "backups:manage",
  "imports:run",
] as const;

const roleMatrix: Record<RoleCode, readonly (typeof permissions)[number][]> = {
  ADMIN: permissions,
  MANAGER: ["dashboard:read", "weeks:close", "reports:export", "audit:read"],
  SUPERVISOR: [
    "dashboard:read",
    "production:write",
    "production:approve",
    "weeks:close",
  ],
  OPERATOR: ["production:write"],
  VIEWER: ["dashboard:read"],
};

const emailSchema = z
  .string()
  .trim()
  .email("INITIAL_ADMIN_EMAIL deve conter email valido.")
  .max(254)
  .transform((value) => value.toLowerCase());

const optionalCompanyNameSchema = z
  .string()
  .trim()
  .max(160, "COMPANY_NAME excede o tamanho permitido.")
  .transform((value) => value || undefined)
  .optional();

const optionalAdminPasswordSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  strongPasswordSchema.optional(),
);

const environmentSchema = z.object({
  INITIAL_ADMIN_EMAIL: emailSchema,
  INITIAL_ADMIN_PASSWORD: optionalAdminPasswordSchema,
  INITIAL_ADMIN_NAME: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .default("Administrador Nexus"),
  INITIAL_ADMIN_ROTATE_PASSWORD: z.enum(["true", "false"]).default("false"),
  COMPANY_NAME: optionalCompanyNameSchema,
});

export interface ProductionBootstrapConfig {
  adminEmail: string;
  adminPassword?: string;
  adminName: string;
  rotateExistingPassword: boolean;
  companyName?: string;
}

export interface ProductionBootstrapResult {
  adminCreated: boolean;
  passwordRotated: boolean;
}

type PasswordHasher = (password: string, rounds: number) => Promise<string>;

function requiredAdminPassword(
  password: string | undefined,
  operation: "criar" | "rotacionar",
) {
  if (!password) {
    throw new Error(
      `INITIAL_ADMIN_PASSWORD e obrigatoria para ${operation} a senha do administrador.`,
    );
  }
  return password;
}

export function parseProductionBootstrapConfig(
  environment: Record<string, string | undefined>,
): ProductionBootstrapConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) => `${issue.path.join(".") || "bootstrap"}: ${issue.message}`,
      )
      .join("; ");
    throw new Error(`Configuracao de bootstrap invalida. ${details}`);
  }

  return {
    adminEmail: parsed.data.INITIAL_ADMIN_EMAIL,
    adminPassword: parsed.data.INITIAL_ADMIN_PASSWORD,
    adminName: parsed.data.INITIAL_ADMIN_NAME,
    rotateExistingPassword:
      parsed.data.INITIAL_ADMIN_ROTATE_PASSWORD === "true",
    companyName: parsed.data.COMPANY_NAME,
  };
}

export async function bootstrapProduction(
  prisma: PrismaClient,
  config: ProductionBootstrapConfig,
  hashPassword: PasswordHasher = bcrypt.hash,
): Promise<ProductionBootstrapResult> {
  return prisma.$transaction(
    async (transaction) => {
      const permissionIds = new Map<string, string>();
      for (const code of permissions) {
        const permission = await transaction.permission.upsert({
          where: { code },
          create: { code, description: code.replace(":", " ") },
          update: { description: code.replace(":", " ") },
          select: { id: true },
        });
        permissionIds.set(code, permission.id);
      }

      let adminRoleId = "";
      for (const code of Object.values(RoleCode)) {
        const role = await transaction.role.upsert({
          where: { code },
          create: { code, name: code },
          update: { name: code },
          select: { id: true },
        });
        if (code === RoleCode.ADMIN) adminRoleId = role.id;

        const allowedPermissionIds = roleMatrix[code].map((permissionCode) => {
          const permissionId = permissionIds.get(permissionCode);
          if (!permissionId)
            throw new Error(`Permissao obrigatoria ausente: ${permissionCode}`);
          return permissionId;
        });

        await transaction.rolePermission.deleteMany({
          where: {
            roleId: role.id,
            permissionId: { notIn: allowedPermissionIds },
          },
        });
        await transaction.rolePermission.createMany({
          data: allowedPermissionIds.map((permissionId) => ({
            roleId: role.id,
            permissionId,
          })),
          skipDuplicates: true,
        });
      }

      const existingAdmin = await transaction.user.findFirst({
        where: { email: { equals: config.adminEmail, mode: "insensitive" } },
        select: { id: true, active: true, deletedAt: true },
      });

      let adminId: string;
      let adminCreated = false;
      let passwordRotated = false;

      if (existingAdmin) {
        if (!existingAdmin.active || existingAdmin.deletedAt) {
          throw new Error(
            "INITIAL_ADMIN_EMAIL pertence a usuario inativo ou excluido. Reative-o pelo fluxo administrativo antes do bootstrap.",
          );
        }
        adminId = existingAdmin.id;

        if (config.rotateExistingPassword) {
          const passwordHash = await hashPassword(
            requiredAdminPassword(config.adminPassword, "rotacionar"),
            12,
          );
          await transaction.user.update({
            where: { id: adminId },
            data: { passwordHash, sessionVersion: { increment: 1 } },
            select: { id: true },
          });
          passwordRotated = true;
        }
      } else {
        const passwordHash = await hashPassword(
          requiredAdminPassword(config.adminPassword, "criar"),
          12,
        );
        const admin = await transaction.user.create({
          data: {
            email: config.adminEmail,
            name: config.adminName,
            passwordHash,
          },
          select: { id: true },
        });
        adminId = admin.id;
        adminCreated = true;
      }

      if (!adminRoleId) throw new Error("Papel ADMIN nao foi criado.");
      await transaction.userRole.createMany({
        data: [{ userId: adminId, roleId: adminRoleId }],
        skipDuplicates: true,
      });

      if (config.companyName) {
        const value = { name: config.companyName };
        await transaction.systemSetting.upsert({
          where: { key: "company" },
          create: { key: "company", value },
          update: { value },
        });
      }

      return { adminCreated, passwordRotated };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
