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
    const recordAudit = vi.fn().mockResolvedValue({ id: "audit-1" });
    const signAsync = vi.fn().mockResolvedValue("signed-jwt");
    const service = new AuthService(
      { user: { findUnique, update } } as never,
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
