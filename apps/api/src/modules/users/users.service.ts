import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roleCodes = ["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER"] as const;
const roleCodeSchema = z.enum(roleCodes);
type UserRoleCode = z.infer<typeof roleCodeSchema>;

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const strongPasswordSchema = z.string()
  .min(12, "A senha deve ter pelo menos 12 caracteres.")
  .max(128, "A senha excede o tamanho permitido.")
  .regex(/[a-z]/, "A senha deve conter letra minuscula.")
  .regex(/[A-Z]/, "A senha deve conter letra maiuscula.")
  .regex(/[0-9]/, "A senha deve conter numero.")
  .regex(/[^A-Za-z0-9\s]/, "A senha deve conter simbolo.")
  .refine((value) => value === value.trim(), "A senha nao pode iniciar ou terminar com espacos.")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "A senha excede o limite seguro do bcrypt.");
const rolesSchema = z.array(roleCodeSchema)
  .min(1, "Selecione pelo menos um papel.")
  .max(roleCodes.length)
  .transform((roles) => [...new Set(roles)] as UserRoleCode[]);

const createUserSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(2).max(120),
  password: strongPasswordSchema,
  roles: rolesSchema.default(["VIEWER"])
}).strict();

const updateUserSchema = z.object({
  email: emailSchema.optional(),
  name: z.string().trim().min(2).max(120).optional(),
  active: z.boolean().optional()
}).strict().refine(
  (input) => Object.values(input).some((value) => value !== undefined),
  "Informe ao menos um campo para atualizar."
);

const updateRolesSchema = z.object({ roles: rolesSchema }).strict();
const resetPasswordSchema = z.object({ password: strongPasswordSchema }).strict();

const safeUserSelect = {
  id: true,
  email: true,
  name: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  roles: {
    select: {
      role: {
        select: { id: true, code: true, name: true, description: true }
      }
    }
  }
} satisfies Prisma.UserSelect;

type SafeUser = Prisma.UserGetPayload<{ select: typeof safeUserSelect }>;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  list() {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
      select: safeUserSelect
    });
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: safeUserSelect });
    if (!user) throw new NotFoundException("Usuario nao encontrado.");
    return user;
  }

  async create(payload: unknown, currentUser?: CurrentUser) {
    const input = createUserSchema.parse(payload);
    const passwordHash = await bcrypt.hash(input.password, 12);
    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const duplicate = await transaction.user.findFirst({
          where: { email: { equals: input.email, mode: "insensitive" } },
          select: { id: true }
        });
        if (duplicate) throw new ConflictException("Ja existe usuario com este email.");

        const roles = await this.findRoles(transaction, input.roles);
        const user = await transaction.user.create({
          data: { email: input.email, name: input.name, passwordHash },
          select: { id: true }
        });
        await transaction.userRole.createMany({
          data: roles.map((role) => ({ userId: user.id, roleId: role.id })),
          skipDuplicates: true
        });
        return transaction.user.findUniqueOrThrow({ where: { id: user.id }, select: safeUserSelect });
      });

      await this.recordAudit("create", created, currentUser, undefined, created);
      return created;
    } catch (error) {
      this.rethrowKnownWriteError(error);
    }
  }

  async update(id: string, payload: unknown, currentUser?: CurrentUser) {
    const input = updateUserSchema.parse(payload);
    if (input.active === false) this.assertNotSelf(id, currentUser, "Voce nao pode desativar o proprio usuario.");

    try {
      const { before, after } = await this.serializable(async (transaction) => {
        const current = await this.findUser(transaction, id, false);
        if (input.active === false) await this.assertNotLastActiveAdmin(transaction, current);
        if (input.email && input.email !== current.email.toLowerCase()) {
          const duplicate = await transaction.user.findFirst({
            where: { id: { not: id }, email: { equals: input.email, mode: "insensitive" } },
            select: { id: true }
          });
          if (duplicate) throw new ConflictException("Ja existe usuario com este email.");
        }
        const updated = await transaction.user.update({
          where: { id },
          data: {
            ...input,
            ...(input.active !== undefined && input.active !== current.active
              ? { sessionVersion: { increment: 1 } }
              : {})
          },
          select: safeUserSelect
        });
        return { before: current, after: updated };
      });

      await this.recordAudit("update", after, currentUser, before, after);
      return after;
    } catch (error) {
      this.rethrowKnownWriteError(error);
    }
  }

  async updateRoles(id: string, payload: unknown, currentUser?: CurrentUser) {
    const input = updateRolesSchema.parse(payload);
    if (currentUser?.id === id && !input.roles.includes("ADMIN")) {
      throw new ForbiddenException("Voce nao pode remover o proprio papel de administrador.");
    }

    const { before, after } = await this.serializable(async (transaction) => {
      const current = await this.findUser(transaction, id, false);
      if (this.hasAdminRole(current) && !input.roles.includes("ADMIN")) {
        await this.assertNotLastActiveAdmin(transaction, current);
      }
      const roles = await this.findRoles(transaction, input.roles);
      await transaction.userRole.deleteMany({ where: { userId: id } });
      await transaction.userRole.createMany({
        data: roles.map((role) => ({ userId: id, roleId: role.id })),
        skipDuplicates: true
      });
      const updated = await transaction.user.update({
        where: { id },
        data: { sessionVersion: { increment: 1 } },
        select: safeUserSelect
      });
      return { before: current, after: updated };
    });

    await this.recordAudit("update_roles", after, currentUser, before, after);
    return after;
  }

  async activate(id: string, currentUser?: CurrentUser) {
    const { before, after } = await this.serializable(async (transaction) => {
      const current = await this.findUser(transaction, id, false);
      if (current.active) throw new ConflictException("Usuario ja esta ativo.");
      const updated = await transaction.user.update({
        where: { id },
        data: { active: true, sessionVersion: { increment: 1 } },
        select: safeUserSelect
      });
      return { before: current, after: updated };
    });
    await this.recordAudit("activate", after, currentUser, before, after);
    return after;
  }

  async deactivate(id: string, currentUser?: CurrentUser) {
    this.assertNotSelf(id, currentUser, "Voce nao pode desativar o proprio usuario.");
    const { before, after } = await this.serializable(async (transaction) => {
      const current = await this.findUser(transaction, id, false);
      if (!current.active) throw new ConflictException("Usuario ja esta inativo.");
      await this.assertNotLastActiveAdmin(transaction, current);
      const updated = await transaction.user.update({
        where: { id },
        data: { active: false, sessionVersion: { increment: 1 } },
        select: safeUserSelect
      });
      return { before: current, after: updated };
    });
    await this.recordAudit("deactivate", after, currentUser, before, after);
    return after;
  }

  async resetPassword(id: string, payload: unknown, currentUser?: CurrentUser) {
    const input = resetPasswordSchema.parse(payload);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const { before, after } = await this.prisma.$transaction(async (transaction) => {
      const current = await this.findUser(transaction, id, false);
      const updated = await transaction.user.update({
        where: { id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
        select: safeUserSelect
      });
      return { before: current, after: updated };
    });

    await this.audit.record({
      userId: this.safeUserId(currentUser),
      module: "users",
      action: "reset_password",
      entity: "User",
      entityId: id,
      before: this.auditSnapshot(before),
      after: { ...this.auditSnapshot(after), credentialReset: true }
    });
    return { ...after, credentialReset: true };
  }

  async remove(id: string, currentUser?: CurrentUser) {
    this.assertNotSelf(id, currentUser, "Voce nao pode excluir o proprio usuario.");
    const { before, after } = await this.serializable(async (transaction) => {
      const current = await this.findUser(transaction, id, false);
      await this.assertNotLastActiveAdmin(transaction, current);
      const updated = await transaction.user.update({
        where: { id },
        data: { active: false, deletedAt: new Date(), sessionVersion: { increment: 1 } },
        select: safeUserSelect
      });
      return { before: current, after: updated };
    });
    await this.recordAudit("delete", after, currentUser, before, after);
    return after;
  }

  async restore(id: string, currentUser?: CurrentUser) {
    const { before, after } = await this.serializable(async (transaction) => {
      const current = await this.findUser(transaction, id, true);
      if (!current.deletedAt) throw new ConflictException("Usuario nao esta excluido.");
      const updated = await transaction.user.update({
        where: { id },
        data: { active: false, deletedAt: null, sessionVersion: { increment: 1 } },
        select: safeUserSelect
      });
      return { before: current, after: updated };
    });
    await this.recordAudit("restore", after, currentUser, before, after);
    return after;
  }

  async revokeSessions(id: string, currentUser?: CurrentUser) {
    const { before, after } = await this.serializable(async (transaction) => {
      const current = await this.findUser(transaction, id, true);
      const updated = await transaction.user.update({
        where: { id },
        data: { sessionVersion: { increment: 1 } },
        select: safeUserSelect
      });
      return { before: current, after: updated };
    });

    await this.audit.record({
      userId: this.safeUserId(currentUser),
      module: "users",
      action: "revoke_sessions",
      entity: "User",
      entityId: id,
      before: this.auditSnapshot(before),
      after: { ...this.auditSnapshot(after), sessionsRevoked: true }
    });
    return { ...after, sessionsRevoked: true };
  }

  private async findUser(transaction: Prisma.TransactionClient, id: string, includeDeleted: boolean) {
    const user = await transaction.user.findUnique({ where: { id }, select: safeUserSelect });
    if (!user || (!includeDeleted && user.deletedAt)) throw new NotFoundException("Usuario nao encontrado.");
    return user;
  }

  private async findRoles(transaction: Prisma.TransactionClient, codes: UserRoleCode[]) {
    const roles = await transaction.role.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true }
    });
    if (roles.length !== codes.length) {
      throw new BadRequestException("Um ou mais papeis de usuario nao estao configurados.");
    }
    return roles;
  }

  private async assertNotLastActiveAdmin(transaction: Prisma.TransactionClient, user: SafeUser) {
    if (!user.active || user.deletedAt || !this.hasAdminRole(user)) return;
    const activeAdmins = await transaction.user.count({
      where: {
        active: true,
        deletedAt: null,
        roles: { some: { role: { code: "ADMIN" } } }
      }
    });
    if (activeAdmins <= 1) {
      throw new ConflictException("A operacao removeria o ultimo administrador ativo.");
    }
  }

  private hasAdminRole(user: SafeUser) {
    return user.roles.some((item) => item.role.code === "ADMIN");
  }

  private assertNotSelf(id: string, currentUser: CurrentUser | undefined, message: string) {
    if (currentUser?.id === id) throw new ForbiddenException(message);
  }

  private async serializable<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) {
    try {
      return await this.prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === "P2034") {
        throw new ConflictException("A administracao de usuarios sofreu uma alteracao concorrente. Tente novamente.");
      }
      throw error;
    }
  }

  private auditSnapshot(user: SafeUser) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      active: user.active,
      deletedAt: user.deletedAt,
      roles: user.roles.map((item) => item.role.code).sort()
    };
  }

  private async recordAudit(
    action: string,
    entity: SafeUser,
    currentUser: CurrentUser | undefined,
    before?: SafeUser,
    after?: SafeUser
  ) {
    await this.audit.record({
      userId: this.safeUserId(currentUser),
      module: "users",
      action,
      entity: "User",
      entityId: entity.id,
      before: before ? this.auditSnapshot(before) : undefined,
      after: after ? this.auditSnapshot(after) : undefined
    });
  }

  private rethrowKnownWriteError(error: unknown): never {
    if (error instanceof ConflictException) throw error;
    if (this.prismaErrorCode(error) === "P2002") {
      throw new ConflictException("Ja existe usuario com este email.");
    }
    throw error;
  }

  private prismaErrorCode(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
