import { describe, expect, it, vi } from "vitest";
import { JwtAuthGuard } from "../../apps/api/src/modules/auth/jwt-auth.guard";
import { RolesGuard } from "../../apps/api/src/modules/auth/roles.guard";
import { IS_PUBLIC_KEY } from "../../apps/api/src/modules/auth/public.decorator";
import { ROLES_KEY } from "../../apps/api/src/modules/auth/roles.decorator";

function httpContext(request: Record<string, unknown>) {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as never;
}

describe("auth guards", () => {
  it("allows public routes without a bearer token", async () => {
    const findUnique = vi.fn();
    const guard = new JwtAuthGuard(
      { getAllAndOverride: (key: string) => key === IS_PUBLIC_KEY } as never,
      { verifyAsync: async () => ({}) } as never,
      { user: { findUnique } } as never
    );

    await expect(guard.canActivate(httpContext({ headers: {} }))).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("attaches current database identity and roles from a valid versioned JWT", async () => {
    const request: Record<string, unknown> = { headers: { authorization: "Bearer token" } };
    const findUnique = vi.fn().mockResolvedValue({
      id: "user-1",
      email: "current@nexus.local",
      active: true,
      deletedAt: null,
      sessionVersion: 3,
      roles: [{ role: { code: "MANAGER" } }]
    });
    const guard = new JwtAuthGuard(
      { getAllAndOverride: () => false } as never,
      {
        verifyAsync: async () => ({
          sub: "user-1",
          sv: 3,
          email: "stale@nexus.local",
          roles: ["ADMIN"]
        })
      } as never,
      { user: { findUnique } } as never
    );

    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true);
    expect(request.user).toEqual({ id: "user-1", email: "current@nexus.local", roles: ["MANAGER"] });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "user-1" } }));
  });

  it("attaches the current user from the HTTP-only session cookie", async () => {
    const request: Record<string, unknown> = { headers: { cookie: "nexus_session=token" } };
    const guard = new JwtAuthGuard(
      { getAllAndOverride: () => false } as never,
      { verifyAsync: async () => ({ sub: "user-1", sv: 2 }) } as never,
      {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-1",
            email: "admin@nexus.local",
            active: true,
            deletedAt: null,
            sessionVersion: 2,
            roles: [{ role: { code: "ADMIN" } }]
          })
        }
      } as never
    );

    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true);
    expect(request.user).toEqual({ id: "user-1", email: "admin@nexus.local", roles: ["ADMIN"] });
  });

  it("rejects legacy JWTs without a session version before querying the database", async () => {
    const findUnique = vi.fn();
    const guard = new JwtAuthGuard(
      { getAllAndOverride: () => false } as never,
      { verifyAsync: async () => ({ sub: "user-1" }) } as never,
      { user: { findUnique } } as never
    );

    await expect(
      guard.canActivate(httpContext({ headers: { authorization: "Bearer legacy-token" } }))
    ).rejects.toThrow("Sessao invalida");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["version mismatch", { active: true, deletedAt: null, sessionVersion: 4 }],
    ["inactive user", { active: false, deletedAt: null, sessionVersion: 3 }],
    ["soft-deleted user", { active: true, deletedAt: new Date(), sessionVersion: 3 }]
  ])("rejects a validly signed JWT for a %s", async (_label, state) => {
    const guard = new JwtAuthGuard(
      { getAllAndOverride: () => false } as never,
      { verifyAsync: async () => ({ sub: "user-1", sv: 3 }) } as never,
      {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-1",
            email: "admin@nexus.local",
            roles: [{ role: { code: "ADMIN" } }],
            ...state
          })
        }
      } as never
    );

    await expect(
      guard.canActivate(httpContext({ headers: { authorization: "Bearer revoked-token" } }))
    ).rejects.toThrow("Sessao invalida");
  });

  it("rejects a validly signed JWT when the user no longer exists", async () => {
    const guard = new JwtAuthGuard(
      { getAllAndOverride: () => false } as never,
      { verifyAsync: async () => ({ sub: "user-1", sv: 3 }) } as never,
      { user: { findUnique: vi.fn().mockResolvedValue(null) } } as never
    );

    await expect(
      guard.canActivate(httpContext({ headers: { authorization: "Bearer orphan-token" } }))
    ).rejects.toThrow("Sessao invalida");
  });

  it("blocks users outside the required role set", () => {
    const guard = new RolesGuard({
      getAllAndOverride: (key: string) => (key === ROLES_KEY ? ["MANAGER"] : false)
    } as never);

    expect(() =>
      guard.canActivate(httpContext({ headers: {}, user: { id: "1", email: "op@nexus.local", roles: ["OPERATOR"] } }))
    ).toThrow("Perfil sem permissao");
  });
});
