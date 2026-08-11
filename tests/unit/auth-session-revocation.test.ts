import { readFileSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../../apps/api/src/modules/auth/auth.service";

describe("JWT session revocation", () => {
  it("issues a JWT with the current session version and no role claims", async () => {
    const password = "Strong!Password1";
    const passwordHash = await bcrypt.hash(password, 4);
    const findUnique = vi.fn().mockResolvedValue({
      id: "user-1",
      email: "admin@nexus.local",
      name: "Admin",
      passwordHash,
      active: true,
      deletedAt: null,
      sessionVersion: 7,
      roles: [{ role: { code: "ADMIN" } }]
    });
    const update = vi.fn().mockResolvedValue({ id: "user-1" });
    const transaction = { user: { update } };
    const prisma = {
      user: { findUnique },
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction)
      )
    };
    const recordAudit = vi.fn().mockResolvedValue({ id: "audit-1" });
    const signAsync = vi.fn().mockResolvedValue("signed-jwt");
    const service = new AuthService(
      prisma as never,
      { signAsync } as never,
      { record: recordAudit } as never
    );

    const result = await service.login({ email: " ADMIN@NEXUS.LOCAL ", password });

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "admin@nexus.local" } })
    );
    expect(signAsync).toHaveBeenCalledWith({
      sub: "user-1",
      email: "admin@nexus.local",
      sv: 7
    });
    expect(signAsync.mock.calls[0][0]).not.toHaveProperty("roles");
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { lastLoginAt: expect.any(Date) }
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "login", userId: "user-1" }),
      transaction
    );
    expect(result).toEqual({
      accessToken: "signed-jwt",
      user: {
        id: "user-1",
        email: "admin@nexus.local",
        name: "Admin",
        roles: ["ADMIN"]
      }
    });

    const serializedAudit = JSON.stringify(recordAudit.mock.calls);
    expect(serializedAudit).not.toContain(password);
    expect(serializedAudit).not.toContain(passwordHash);
    expect(serializedAudit).not.toContain("passwordHash");
  });

  it("rolls back lastLoginAt when the successful-login audit insert fails", async () => {
    const password = "Strong!Password1";
    const passwordHash = await bcrypt.hash(password, 4);
    let lastLoginAt: Date | null = null;
    const user = {
      id: "user-1",
      email: "admin@nexus.local",
      name: "Admin",
      passwordHash,
      active: true,
      deletedAt: null,
      sessionVersion: 7,
      roles: [{ role: { code: "ADMIN" } }]
    };
    const transaction = {
      user: {
        update: vi.fn(async ({ data }: { data: { lastLoginAt: Date } }) => {
          lastLoginAt = data.lastLoginAt;
          return { id: user.id };
        })
      }
    };
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue(user) },
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => {
        const snapshot = lastLoginAt;
        try {
          return await operation(transaction);
        } catch (error) {
          lastLoginAt = snapshot;
          throw error;
        }
      })
    };
    const auditError = new Error("audit unavailable");
    const recordAudit = vi.fn().mockRejectedValue(auditError);
    const service = new AuthService(
      prisma as never,
      { signAsync: vi.fn().mockResolvedValue("signed-jwt") } as never,
      { record: recordAudit } as never
    );

    await expect(service.login({ email: user.email, password })).rejects.toBe(auditError);

    expect(transaction.user.update).toHaveBeenCalledOnce();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "login" }), transaction);
    expect(lastLoginAt).toBeNull();
  });

  it("audits unknown email and wrong password identically without exposing account existence", async () => {
    const passwordHash = await bcrypt.hash("Correct!Password1", 4);
    const existing = {
      id: "user-1",
      email: "admin@nexus.local",
      name: "Admin",
      passwordHash,
      active: true,
      deletedAt: null,
      sessionVersion: 7,
      roles: [{ role: { code: "ADMIN" } }]
    };
    const recordAudit = vi.fn().mockResolvedValue({ id: "audit-1" });
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existing) },
      $transaction: vi.fn()
    };
    const service = new AuthService(
      prisma as never,
      { signAsync: vi.fn() } as never,
      { record: recordAudit } as never
    );
    const attempt = { email: "admin@nexus.local", password: "Wrong!Password2" };

    await expect(service.login(attempt)).rejects.toThrow("Credenciais invalidas.");
    await expect(service.login(attempt)).rejects.toThrow("Credenciais invalidas.");

    expect(recordAudit).toHaveBeenCalledTimes(2);
    expect(recordAudit.mock.calls[0]).toEqual(recordAudit.mock.calls[1]);
    expect(recordAudit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      action: "login_failed",
      userId: undefined,
      entityId: undefined,
      after: { email: "admin@nexus.local" }
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("keeps the Prisma model and migration aligned on a positive session version", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      join(process.cwd(), "prisma/migrations/0009_user_session_revocation/migration.sql"),
      "utf8"
    );

    expect(schema).toMatch(/sessionVersion\s+Int\s+@default\(1\)\s+@map\("session_version"\)/);
    expect(migration).toContain('ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 1');
    expect(migration).toContain('CHECK ("session_version" >= 1)');
  });
});
