import { PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import { ROLES_KEY } from "../../apps/api/src/modules/auth/roles.decorator";
import { UsersController } from "../../apps/api/src/modules/users/users.controller";
import { UsersService } from "../../apps/api/src/modules/users/users.service";

const actor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "actor@nexus.local",
  roles: ["ADMIN"]
};
const targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function safeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: targetId,
    email: "target@nexus.local",
    name: "Target Admin",
    active: true,
    lastLoginAt: null,
    createdAt: new Date("2026-07-01T10:00:00.000Z"),
    updatedAt: new Date("2026-07-01T10:00:00.000Z"),
    deletedAt: null,
    roles: [
      {
        role: {
          id: "role-admin",
          code: "ADMIN",
          name: "Administrador",
          description: null
        }
      }
    ],
    ...overrides
  };
}

function transactionPrisma(transaction: Record<string, unknown>) {
  return {
    ...transaction,
    $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction)
    )
  };
}

function serialized(value: unknown) {
  return JSON.stringify(value);
}

describe("users administration", () => {
  it("keeps every administration endpoint under ADMIN RBAC", () => {
    expect(Reflect.getMetadata(ROLES_KEY, UsersController)).toEqual(["ADMIN"]);
    expect(Reflect.getMetadata(PATH_METADATA, UsersController.prototype.get)).toBe(":id");
    expect(Reflect.getMetadata(PATH_METADATA, UsersController.prototype.update)).toBe(":id");
    expect(Reflect.getMetadata(PATH_METADATA, UsersController.prototype.updateRoles)).toBe(":id/roles");
    expect(Reflect.getMetadata(PATH_METADATA, UsersController.prototype.activate)).toBe(":id/activate");
    expect(Reflect.getMetadata(PATH_METADATA, UsersController.prototype.deactivate)).toBe(":id/deactivate");
    expect(Reflect.getMetadata(PATH_METADATA, UsersController.prototype.resetPassword)).toBe(":id/reset-password");
    expect(Reflect.getMetadata(PATH_METADATA, UsersController.prototype.revokeSessions)).toBe(":id/revoke-sessions");
    expect(Reflect.getMetadata(PATH_METADATA, UsersController.prototype.remove)).toBe(":id");
    expect(Reflect.getMetadata(PATH_METADATA, UsersController.prototype.restore)).toBe(":id/restore");
  });

  it("lists and fetches only safe user fields", async () => {
    const user = safeUser();
    const findMany = vi.fn().mockResolvedValue([user]);
    const findUnique = vi.fn().mockResolvedValue(user);
    const service = new UsersService(
      { user: { findMany, findUnique } } as never,
      { record: vi.fn() } as never
    );

    await expect(service.list()).resolves.toEqual([user]);
    await expect(service.get(targetId)).resolves.toEqual(user);

    expect(serialized(findMany.mock.calls)).not.toContain("passwordHash");
    expect(serialized(findUnique.mock.calls)).not.toContain("passwordHash");
  });

  it("creates the user and role links atomically without returning or auditing credentials", async () => {
    const password = "Strong!Password1";
    const created = safeUser({ roles: [{ role: { id: "viewer", code: "VIEWER", name: "Leitor", description: null } }] });
    const transaction = {
      user: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: targetId }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(created)
      },
      role: { findMany: vi.fn().mockResolvedValue([{ id: "viewer", code: "VIEWER" }]) },
      userRole: { createMany: vi.fn().mockResolvedValue({ count: 1 }) }
    };
    const prisma = transactionPrisma(transaction);
    const audit = { record: vi.fn() };
    const service = new UsersService(prisma as never, audit as never);

    const result = await service.create(
      { email: "TARGET@NEXUS.LOCAL", name: "Target Admin", password, roles: ["VIEWER"] },
      actor
    );

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(transaction.user.create).toHaveBeenCalledWith({
      data: {
        email: "target@nexus.local",
        name: "Target Admin",
        passwordHash: expect.any(String)
      },
      select: { id: true }
    });
    const storedHash = transaction.user.create.mock.calls[0][0].data.passwordHash;
    expect(storedHash).not.toBe(password);
    expect(result).toEqual(created);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create", entityId: targetId }),
      transaction
    );
    expect(serialized(result)).not.toContain("password");
    expect(serialized(audit.record.mock.calls)).not.toContain("password");
    expect(serialized(audit.record.mock.calls)).not.toContain(storedHash);
  });

  it("rejects weak passwords before creating or resetting credentials", async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new UsersService(prisma as never, { record: vi.fn() } as never);

    await expect(
      service.create({ email: "target@nexus.local", name: "Target", password: "password", roles: ["VIEWER"] })
    ).rejects.toThrow();
    await expect(service.resetPassword(targetId, { password: "alllowercase123!" }, actor)).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("blocks every self-deactivation, self-deletion and own ADMIN removal", async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new UsersService(prisma as never, { record: vi.fn() } as never);

    await expect(service.update(actor.id, { active: false }, actor)).rejects.toThrow("proprio usuario");
    await expect(service.deactivate(actor.id, actor)).rejects.toThrow("proprio usuario");
    await expect(service.remove(actor.id, actor)).rejects.toThrow("proprio usuario");
    await expect(service.updateRoles(actor.id, { roles: ["MANAGER"] }, actor)).rejects.toThrow("proprio papel");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("updates name/email and activates or deactivates non-admin users with sanitized audits", async () => {
    const viewerRole = [{ role: { id: "viewer", code: "VIEWER", name: "Leitor", description: null } }];
    const beforeUpdate = safeUser({ roles: viewerRole });
    const afterUpdate = safeUser({ email: "novo@nexus.local", name: "Novo Nome", roles: viewerRole });
    const updateTransaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(beforeUpdate),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue(afterUpdate)
      }
    };
    const updatePrisma = transactionPrisma(updateTransaction);
    const updateAudit = { record: vi.fn() };
    const updateService = new UsersService(updatePrisma as never, updateAudit as never);

    await expect(
      updateService.update(targetId, { email: "NOVO@NEXUS.LOCAL", name: " Novo Nome " }, actor)
    ).resolves.toEqual(afterUpdate);
    expect(updateTransaction.user.update).toHaveBeenCalledWith({
      where: { id: targetId },
      data: { email: "novo@nexus.local", name: "Novo Nome" },
      select: expect.any(Object)
    });
    expect(updateAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update", before: expect.any(Object), after: expect.any(Object) }),
      updateTransaction
    );

    const inactive = safeUser({ active: false, roles: viewerRole });
    const active = safeUser({ active: true, roles: viewerRole });
    const activateTransaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(inactive),
        update: vi.fn().mockResolvedValue(active)
      }
    };
    const activateAudit = { record: vi.fn() };
    const activateService = new UsersService(
      transactionPrisma(activateTransaction) as never,
      activateAudit as never
    );
    await expect(activateService.activate(targetId, actor)).resolves.toEqual(active);
    expect(activateTransaction.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: true, sessionVersion: { increment: 1 } } })
    );
    expect(activateAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "activate" }),
      activateTransaction
    );

    const deactivateTransaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(active),
        count: vi.fn(),
        update: vi.fn().mockResolvedValue(inactive)
      }
    };
    const deactivateAudit = { record: vi.fn() };
    const deactivateService = new UsersService(
      transactionPrisma(deactivateTransaction) as never,
      deactivateAudit as never
    );
    await expect(deactivateService.deactivate(targetId, actor)).resolves.toEqual(inactive);
    expect(deactivateTransaction.user.count).not.toHaveBeenCalled();
    expect(deactivateTransaction.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false, sessionVersion: { increment: 1 } } })
    );
    expect(deactivateAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deactivate" }),
      deactivateTransaction
    );
    expect(serialized([
      updateAudit.record.mock.calls,
      activateAudit.record.mock.calls,
      deactivateAudit.record.mock.calls
    ])).not.toContain("passwordHash");
  });

  it("protects the last active ADMIN in PATCH, deactivation, deletion and role changes", async () => {
    const current = safeUser();
    const transaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(current),
        count: vi.fn().mockResolvedValue(1),
        update: vi.fn()
      },
      role: { findMany: vi.fn() },
      userRole: { deleteMany: vi.fn(), createMany: vi.fn() }
    };
    const prisma = transactionPrisma(transaction);
    const service = new UsersService(prisma as never, { record: vi.fn() } as never);

    await expect(service.update(targetId, { active: false }, actor)).rejects.toThrow("ultimo administrador");
    await expect(service.deactivate(targetId, actor)).rejects.toThrow("ultimo administrador");
    await expect(service.remove(targetId, actor)).rejects.toThrow("ultimo administrador");
    await expect(service.updateRoles(targetId, { roles: ["MANAGER"] }, actor)).rejects.toThrow("ultimo administrador");

    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(transaction.userRole.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    for (const call of prisma.$transaction.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ isolationLevel: "Serializable" }));
    }
  });

  it("replaces roles transactionally and audits only sanitized before/after snapshots", async () => {
    const before = safeUser();
    const after = safeUser({
      roles: [{ role: { id: "manager", code: "MANAGER", name: "Gestor", description: null } }]
    });
    const transaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(before),
        count: vi.fn().mockResolvedValue(2),
        update: vi.fn().mockResolvedValue(after)
      },
      role: { findMany: vi.fn().mockResolvedValue([{ id: "manager", code: "MANAGER" }]) },
      userRole: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    };
    const prisma = transactionPrisma(transaction);
    const audit = { record: vi.fn() };
    const service = new UsersService(prisma as never, audit as never);

    await expect(service.updateRoles(targetId, { roles: ["MANAGER"] }, actor)).resolves.toEqual(after);

    expect(transaction.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: targetId } });
    expect(transaction.userRole.createMany).toHaveBeenCalledWith({
      data: [{ userId: targetId, roleId: "manager" }],
      skipDuplicates: true
    });
    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: targetId },
      data: { sessionVersion: { increment: 1 } },
      select: expect.any(Object)
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update_roles",
        before: expect.objectContaining({ roles: ["ADMIN"] }),
        after: expect.objectContaining({ roles: ["MANAGER"] })
      }),
      transaction
    );
    expect(serialized(audit.record.mock.calls)).not.toContain("password");
  });

  it("resets a strong password without returning or auditing password/hash material", async () => {
    const password = "Another!Strong2";
    const current = safeUser({ roles: [{ role: { id: "viewer", code: "VIEWER", name: "Leitor", description: null } }] });
    const transaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn().mockResolvedValue(current)
      }
    };
    const prisma = transactionPrisma(transaction);
    const audit = { record: vi.fn() };
    const service = new UsersService(prisma as never, audit as never);

    const result = await service.resetPassword(targetId, { password }, actor);
    const updateData = transaction.user.update.mock.calls[0][0].data;
    const storedHash = updateData.passwordHash;

    expect(storedHash).not.toBe(password);
    expect(updateData.sessionVersion).toEqual({ increment: 1 });
    expect(result).toMatchObject({ id: targetId, credentialReset: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "reset_password", entityId: targetId }),
      transaction
    );
    expect(serialized(result)).not.toContain(password);
    expect(serialized(result)).not.toContain(storedHash);
    expect(serialized(result)).not.toContain("passwordHash");
    expect(serialized(audit.record.mock.calls)).not.toContain(password);
    expect(serialized(audit.record.mock.calls)).not.toContain(storedHash);
    expect(serialized(audit.record.mock.calls)).not.toContain("passwordHash");
  });

  it("soft-deletes and restores users while keeping restored accounts inactive", async () => {
    const nonAdmin = safeUser({
      active: true,
      roles: [{ role: { id: "viewer", code: "VIEWER", name: "Leitor", description: null } }]
    });
    const deleted = safeUser({
      active: false,
      deletedAt: new Date("2026-07-18T12:00:00.000Z"),
      roles: nonAdmin.roles
    });
    const restored = safeUser({ active: false, deletedAt: null, roles: nonAdmin.roles });

    const deleteTransaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(nonAdmin),
        count: vi.fn(),
        update: vi.fn().mockResolvedValue(deleted)
      }
    };
    const deletePrisma = transactionPrisma(deleteTransaction);
    const deleteAudit = { record: vi.fn() };
    const deleteService = new UsersService(deletePrisma as never, deleteAudit as never);
    await expect(deleteService.remove(targetId, actor)).resolves.toEqual(deleted);
    expect(deleteTransaction.user.update).toHaveBeenCalledWith({
      where: { id: targetId },
      data: { active: false, deletedAt: expect.any(Date), sessionVersion: { increment: 1 } },
      select: expect.any(Object)
    });
    expect(deleteAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete" }),
      deleteTransaction
    );

    const restoreTransaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(deleted),
        update: vi.fn().mockResolvedValue(restored)
      }
    };
    const restorePrisma = transactionPrisma(restoreTransaction);
    const restoreAudit = { record: vi.fn() };
    const restoreService = new UsersService(restorePrisma as never, restoreAudit as never);
    await expect(restoreService.restore(targetId, actor)).resolves.toEqual(restored);
    expect(restoreTransaction.user.update).toHaveBeenCalledWith({
      where: { id: targetId },
      data: { active: false, deletedAt: null, sessionVersion: { increment: 1 } },
      select: expect.any(Object)
    });
    expect(restoreAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "restore" }),
      restoreTransaction
    );
  });

  it("revokes every session explicitly without exposing or auditing credentials", async () => {
    const current = safeUser();
    const transaction = {
      user: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn().mockResolvedValue(current)
      }
    };
    const prisma = transactionPrisma(transaction);
    const audit = { record: vi.fn() };
    const service = new UsersService(prisma as never, audit as never);

    const result = await service.revokeSessions(targetId, actor);

    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: targetId },
      data: { sessionVersion: { increment: 1 } },
      select: expect.any(Object)
    });
    expect(result).toMatchObject({ id: targetId, sessionsRevoked: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "revoke_sessions",
        entityId: targetId,
        after: expect.objectContaining({ sessionsRevoked: true })
      }),
      transaction
    );
    expect(serialized([result, audit.record.mock.calls])).not.toContain("password");
    expect(serialized([result, audit.record.mock.calls])).not.toContain("sessionVersion");
  });

  it("rolls back an administrative mutation when its audit insert fails", async () => {
    const roles = [{ role: { id: "viewer", code: "VIEWER", name: "Leitor", description: null } }];
    const before = safeUser({ name: "Nome anterior", roles });
    const after = safeUser({ name: "Nome alterado", roles });
    let persisted = before;
    const transaction = {
      user: {
        findUnique: vi.fn(async () => persisted),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(async () => {
          persisted = after;
          return persisted;
        })
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => {
        const snapshot = persisted;
        try {
          return await operation(transaction);
        } catch (error) {
          persisted = snapshot;
          throw error;
        }
      })
    };
    const auditError = new Error("audit unavailable");
    const audit = { record: vi.fn().mockRejectedValue(auditError) };
    const service = new UsersService(prisma as never, audit as never);

    await expect(service.update(targetId, { name: "Nome alterado" }, actor)).rejects.toBe(auditError);

    expect(transaction.user.update).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "update" }), transaction);
    expect(persisted).toBe(before);
  });
});
