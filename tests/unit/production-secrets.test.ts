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
    BACKUP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    DATABASE_URL: `postgresql://nexus:${password}@postgres:5432/nexus_operacional?schema=public`,
    WEB_ORIGIN: "https://nexus.example.com",
    AUTH_COOKIE_SAMESITE: "lax",
    ...overrides
  };
}

describe("production secret validation", () => {
  it("accepts independent strong JWT and PostgreSQL secrets", () => {
    const environment = productionEnvironment();
    expect(validateProductionEnvironment(environment)).toBe(environment);
    expect(resolveJwtAccessSecret(environment)).toBe(environment.JWT_ACCESS_SECRET);
  });

  it("requires a valid independent backup encryption key", () => {
    expect(() =>
      validateProductionEnvironment(
        productionEnvironment({ BACKUP_ENCRYPTION_KEY: undefined }),
      ),
    ).toThrow("BACKUP_ENCRYPTION_KEY must be set");
    expect(() =>
      validateProductionEnvironment(
        productionEnvironment({
          BACKUP_ENCRYPTION_KEY: "replace-with-32-byte-base64-or-64-hex",
        }),
      ),
    ).toThrow("predictable or placeholder");
    expect(() =>
      validateProductionEnvironment(
        productionEnvironment({
          BACKUP_ENCRYPTION_KEY: Buffer.alloc(31, 7).toString("base64"),
        }),
      ),
    ).toThrow("exactly 32 bytes");
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

  it("requires an explicit secure web origin and rejects cross-site cookies", () => {
    expect(() =>
      validateProductionEnvironment(productionEnvironment({ WEB_ORIGIN: undefined })),
    ).toThrow("WEB_ORIGIN must be set");
    expect(() =>
      validateProductionEnvironment(productionEnvironment({ WEB_ORIGIN: "http://nexus.example.com" })),
    ).toThrow("HTTPS origin");
    expect(() =>
      validateProductionEnvironment(productionEnvironment({ AUTH_COOKIE_SAMESITE: "none" })),
    ).toThrow("must be lax or strict");
    expect(
      validateProductionEnvironment(
        productionEnvironment({ WEB_ORIGIN: "http://127.0.0.1:3000" }),
      ),
    ).toBeTruthy();
  });
});

describe("production secret deployment wiring", () => {
  const root = process.cwd();
  const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
  const dockerfile = readFileSync(resolve(root, "apps/api/Dockerfile"), "utf8");
  const dockerIgnore = readFileSync(resolve(root, ".dockerignore"), "utf8");
  const environmentExample = readFileSync(resolve(root, ".env.example"), "utf8");
  const appModule = readFileSync(resolve(root, "apps/api/src/app.module.ts"), "utf8");

  it("makes all Compose secrets mandatory without known defaults", () => {
    expect(compose).toContain('POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?');
    expect(compose).toContain('JWT_ACCESS_SECRET: "${JWT_ACCESS_SECRET:?');
    expect(compose).toContain("BACKUP_ENCRYPTION_KEY: ${BACKUP_ENCRYPTION_KEY:?");
    expect(compose).toContain('source: "${BACKUP_EXTERNAL_HOST_DIR:?');
    expect(compose).toContain("target: /app/backups-external");
    expect(compose).toContain("${POSTGRES_PASSWORD:?POSTGRES_PASSWORD obrigatoria}@postgres");
    expect(compose).not.toContain("change-this-postgres-password");
    expect(compose).not.toContain("replace-with-a-long-random-access-secret");
    expect(compose).toContain('WEB_ORIGIN: "${WEB_ORIGIN:?');
    expect(compose).not.toContain("INITIAL_ADMIN_PASSWORD:");
  });

  it("keeps examples blank and removes the build-time known database credential", () => {
    expect(environmentExample).toMatch(/^POSTGRES_PASSWORD=$/m);
    expect(environmentExample).toMatch(/^JWT_ACCESS_SECRET=$/m);
    expect(environmentExample).toMatch(/^BACKUP_ENCRYPTION_KEY=$/m);
    expect(environmentExample).toMatch(/^DATABASE_URL=$/m);
    expect(dockerfile).not.toContain("postgresql://nexus:nexus@");
  });

  it("runs production validation through ConfigModule at API startup", () => {
    expect(appModule).toContain("validate: validateProductionEnvironment");
  });

  it("uses a PostgreSQL 16 client and excludes local environment files from Docker builds", () => {
    expect(dockerfile).toContain("FROM node:22-alpine3.22");
    expect(dockerfile).toMatch(/FROM node:22-alpine3\.22@sha256:[0-9a-f]{64}/);
    expect(compose).toMatch(/image: postgres:16-alpine@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain("postgresql16-client");
    expect(dockerfile).not.toMatch(/apk add --no-cache postgresql-client(?:\s|$)/);
    expect(dockerIgnore).toContain(".env*");
    expect(dockerIgnore).toContain("**/.env*");
    expect(dockerIgnore).toContain("!.env.example");
  });

  it("preserves workspace-local build tools in the API builder stage", () => {
    expect(dockerfile).toContain(
      "COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules",
    );
    expect(dockerfile.indexOf("/app/apps/api/node_modules")).toBeLessThan(
      dockerfile.indexOf("npm run build --workspace=@nexus/api"),
    );
  });
});
