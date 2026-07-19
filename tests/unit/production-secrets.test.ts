import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  requireStrongProductionSecret,
  resolveJwtAccessSecret,
  validateProductionEnvironment
} from "../../apps/api/src/config/production-secrets";

const strongJwtSecret = () => randomBytes(48).toString("base64");
const strongDatabasePassword = () => randomBytes(32).toString("hex");

function productionEnvironment(overrides: Record<string, unknown> = {}) {
  const password = strongDatabasePassword();
  return {
    NODE_ENV: "production",
    JWT_ACCESS_SECRET: strongJwtSecret(),
    DATABASE_URL: `postgresql://nexus:${password}@postgres:5432/nexus_operacional?schema=public`,
    ...overrides
  };
}

describe("production secret validation", () => {
  it("accepts independent strong JWT and PostgreSQL secrets", () => {
    const environment = productionEnvironment();
    expect(validateProductionEnvironment(environment)).toBe(environment);
    expect(resolveJwtAccessSecret(environment)).toBe(environment.JWT_ACCESS_SECRET);
  });

  it("keeps the development fallback isolated from production", () => {
    expect(validateProductionEnvironment({ NODE_ENV: "development" })).toEqual({ NODE_ENV: "development" });
    expect(resolveJwtAccessSecret({ NODE_ENV: "development" })).toBe("dev-access-secret");
  });

  it("rejects a missing or short JWT secret in production", () => {
    expect(() => validateProductionEnvironment(productionEnvironment({ JWT_ACCESS_SECRET: undefined }))).toThrow(
      "JWT_ACCESS_SECRET must be set"
    );
    expect(() => validateProductionEnvironment(productionEnvironment({ JWT_ACCESS_SECRET: "short-secret" }))).toThrow(
      "JWT_ACCESS_SECRET must contain at least 32 characters"
    );
  });

  it("rejects known placeholders and repeated secrets without echoing their value", () => {
    const placeholder = "replace-with-a-long-random-access-secret";
    let thrown: Error | undefined;
    try {
      requireStrongProductionSecret("JWT_ACCESS_SECRET", placeholder);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain("predictable or placeholder");
    expect(thrown?.message).not.toContain(placeholder);
    expect(() => requireStrongProductionSecret("JWT_ACCESS_SECRET", "Ab1!".repeat(12))).toThrow(
      "predictable or placeholder"
    );
  });

  it("requires a valid PostgreSQL URL with a strong non-placeholder password", () => {
    const jwt = strongJwtSecret();
    expect(() => validateProductionEnvironment({ NODE_ENV: "production", JWT_ACCESS_SECRET: jwt })).toThrow(
      "DATABASE_URL must be set"
    );
    expect(() =>
      validateProductionEnvironment({
        NODE_ENV: "production",
        JWT_ACCESS_SECRET: jwt,
        DATABASE_URL: "postgresql://nexus:short@postgres:5432/nexus"
      })
    ).toThrow("DATABASE_URL password must contain at least 32 characters");
    expect(() =>
      validateProductionEnvironment({
        NODE_ENV: "production",
        JWT_ACCESS_SECRET: jwt,
        DATABASE_URL: "postgresql://nexus:change-this-postgres-password-please-now@postgres:5432/nexus"
      })
    ).toThrow("predictable or placeholder");
    expect(() =>
      validateProductionEnvironment({
        NODE_ENV: "production",
        JWT_ACCESS_SECRET: jwt,
        DATABASE_URL: `mysql://nexus:${strongDatabasePassword()}@database:3306/nexus`
      })
    ).toThrow("valid PostgreSQL URL");
  });

  it("validates URL-encoded PostgreSQL passwords after decoding", () => {
    const rawPassword = `${strongDatabasePassword()}!@`;
    const environment = productionEnvironment({
      DATABASE_URL: `postgresql://nexus:${encodeURIComponent(rawPassword)}@postgres:5432/nexus_operacional`
    });
    expect(validateProductionEnvironment(environment)).toBe(environment);
  });
});

describe("production secret deployment wiring", () => {
  const root = process.cwd();
  const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
  const dockerfile = readFileSync(resolve(root, "apps/api/Dockerfile"), "utf8");
  const environmentExample = readFileSync(resolve(root, ".env.example"), "utf8");
  const appModule = readFileSync(resolve(root, "apps/api/src/app.module.ts"), "utf8");

  it("makes both Compose secrets mandatory without known defaults", () => {
    expect(compose).toContain('POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?');
    expect(compose).toContain('JWT_ACCESS_SECRET: "${JWT_ACCESS_SECRET:?');
    expect(compose).toContain("${POSTGRES_PASSWORD:?POSTGRES_PASSWORD obrigatoria}@postgres");
    expect(compose).not.toContain("change-this-postgres-password");
    expect(compose).not.toContain("replace-with-a-long-random-access-secret");
  });

  it("keeps examples blank and removes the build-time known database credential", () => {
    expect(environmentExample).toMatch(/^POSTGRES_PASSWORD=$/m);
    expect(environmentExample).toMatch(/^JWT_ACCESS_SECRET=$/m);
    expect(environmentExample).toMatch(/^DATABASE_URL=$/m);
    expect(dockerfile).not.toContain("postgresql://nexus:nexus@");
  });

  it("runs production validation through ConfigModule at API startup", () => {
    expect(appModule).toContain("validate: validateProductionEnvironment");
  });
});
