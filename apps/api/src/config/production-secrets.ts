const MIN_PRODUCTION_SECRET_LENGTH = 32;

type RuntimeEnvironment = Record<string, unknown>;

const predictableFragments = [
  "changeme",
  "changethis",
  "replacewith",
  "placeholder",
  "example",
  "defaultsecret",
  "developmentsecret",
  "devaccesssecret",
  "insertsecret",
  "jwtaccesssecret",
  "jwtsecret",
  "nexuspassword",
  "nexussecret",
  "postgrespassword",
  "supersecret",
  "yourpassword",
  "yoursecret"
];

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function isProduction(environment: RuntimeEnvironment) {
  return optionalString(environment.NODE_ENV)?.trim().toLowerCase() === "production";
}

function isRepeatedPattern(value: string) {
  for (let patternLength = 1; patternLength <= Math.min(16, Math.floor(value.length / 2)); patternLength += 1) {
    if (value.length % patternLength !== 0) continue;
    const pattern = value.slice(0, patternLength);
    if (pattern.repeat(value.length / patternLength) === value) return true;
  }
  return false;
}

function isPredictable(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (predictableFragments.some((fragment) => normalized.includes(fragment))) return true;
  if (["0123456789", "1234567890", "abcdefghijklmnopqrstuvwxyz", "qwerty"].some((sequence) => normalized.includes(sequence))) {
    return true;
  }
  return new Set(value).size <= 4 || isRepeatedPattern(value);
}

export function requireStrongProductionSecret(name: string, rawValue: unknown) {
  const value = optionalString(rawValue);
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} must be set in production.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain leading or trailing whitespace in production.`);
  }
  if (value.length < MIN_PRODUCTION_SECRET_LENGTH) {
    throw new Error(`${name} must contain at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production.`);
  }
  if (isPredictable(value)) {
    throw new Error(`${name} must not use a predictable or placeholder value in production.`);
  }
  return value;
}

function databasePassword(databaseUrl: unknown) {
  const rawUrl = optionalString(databaseUrl);
  if (!rawUrl || rawUrl.trim().length === 0) {
    throw new Error("DATABASE_URL must be set in production.");
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
    return decodeURIComponent(parsed.password);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL in production.");
  }
}

export function validateProductionEnvironment(environment: RuntimeEnvironment) {
  if (!isProduction(environment)) return environment;

  requireStrongProductionSecret("JWT_ACCESS_SECRET", environment.JWT_ACCESS_SECRET);
  requireStrongProductionSecret("DATABASE_URL password", databasePassword(environment.DATABASE_URL));
  return environment;
}

export function resolveJwtAccessSecret(environment: RuntimeEnvironment) {
  if (isProduction(environment)) {
    return requireStrongProductionSecret("JWT_ACCESS_SECRET", environment.JWT_ACCESS_SECRET);
  }

  const configured = optionalString(environment.JWT_ACCESS_SECRET)?.trim();
  return configured || "dev-access-secret";
}
