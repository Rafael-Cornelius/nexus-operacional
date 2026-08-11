import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  link,
  mkdtemp,
  open,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { BadRequestException } from "@nestjs/common";

export const NATIVE_BACKUP_FORMAT = "nexus-encrypted-pgdump-v1" as const;
export const NATIVE_MANIFEST_FORMAT = "nexus-pgdump-manifest-v1" as const;

const algorithm = "aes-256-gcm";
const outerMagic = Buffer.from("NEXUS_NATIVE_BACKUP_V1\n", "ascii");
const bundleMagic = Buffer.from("NEXUS_PGDUMP_BUNDLE_V1\n", "ascii");
const customDumpMagic = Buffer.from("PGDMP", "ascii");
const authTagBytes = 16;
const maxHeaderBytes = 64 * 1024;
const maxManifestBytes = 16 * 1024 * 1024;

export interface NativeTableProof {
  rows: string;
  sha256: string;
}

export interface NativeMigrationProof {
  migrationName: string;
  checksum: string;
  finishedAt: string | null;
  rolledBackAt: string | null;
}

export interface NativeSequenceProof {
  dataType: string;
  startValue: string;
  minValue: string;
  maxValue: string;
  incrementBy: string;
  cacheSize: string;
  cycle: boolean;
  lastValue: string;
  isCalled: boolean;
}

export interface NativeStructureProof {
  sha256: string;
  objects: Record<string, string>;
}

export interface NativeBackupManifest {
  format: typeof NATIVE_MANIFEST_FORMAT;
  generatedAt: string;
  pgDumpFormat: "custom";
  postgresVersion: string;
  tables: Record<string, NativeTableProof>;
  structure: NativeStructureProof;
  sequences: Record<string, NativeSequenceProof>;
  migrations: NativeMigrationProof[];
}

interface NativeBackupHeader {
  format: typeof NATIVE_BACKUP_FORMAT;
  algorithm: typeof algorithm;
  keyId: string;
  iv: string;
}

export interface PostgreSqlConnection {
  databaseName: string;
  host: string;
  port: string;
  environment: Record<string, string>;
}

export interface DecryptedNativeBackup {
  directory: string;
  dumpPath: string;
  keyId: string;
  manifest: NativeBackupManifest;
  cleanup(): Promise<void>;
}

const libpqParameters: Record<string, string> = {
  application_name: "PGAPPNAME",
  channel_binding: "PGCHANNELBINDING",
  connect_timeout: "PGCONNECT_TIMEOUT",
  gssencmode: "PGGSSENCMODE",
  keepalives: "PGKEEPALIVES",
  keepalives_count: "PGKEEPALIVESCOUNT",
  keepalives_idle: "PGKEEPALIVESIDLE",
  keepalives_interval: "PGKEEPALIVESINTERVAL",
  krbsrvname: "PGKRBSRVNAME",
  options: "PGOPTIONS",
  sslcert: "PGSSLCERT",
  sslcrl: "PGSSLCRL",
  sslcrldir: "PGSSLCRLDIR",
  sslkey: "PGSSLKEY",
  sslmode: "PGSSLMODE",
  sslpassword: "PGSSLPASSWORD",
  sslrootcert: "PGSSLROOTCERT",
  target_session_attrs: "PGTARGETSESSIONATTRS",
  tcp_user_timeout: "PGTCPUSER_TIMEOUT",
};

const prismaOnlyParameters = new Set([
  "connection_limit",
  "pgbouncer",
  "pool_timeout",
  "schema",
  "socket_timeout",
]);

function decodeUrlPart(value: string, label: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${label} contem codificacao URL invalida.`);
  }
}

export function parsePostgreSqlConnection(
  raw: string,
  label: string,
): PostgreSqlConnection {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} deve ser URL PostgreSQL valida.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${label} deve usar postgresql:// ou postgres://.`);
  }
  const databaseName = decodeUrlPart(url.pathname.replace(/^\//, ""), label);
  if (!url.hostname || !databaseName || databaseName.includes("/")) {
    throw new Error(`${label} deve apontar para host e banco nomeado.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");

  const environment: Record<string, string> = {
    PGDATABASE: databaseName,
    PGHOST: host,
    PGPORT: url.port || "5432",
  };
  if (url.username) environment.PGUSER = decodeUrlPart(url.username, label);
  if (url.password) environment.PGPASSWORD = decodeUrlPart(url.password, label);

  for (const [name, value] of url.searchParams) {
    if (prismaOnlyParameters.has(name)) continue;
    const environmentName = libpqParameters[name];
    if (!environmentName) {
      throw new Error(
        `${label} contem parametro nao suportado por pg_dump/pg_restore: ${name}.`,
      );
    }
    environment[environmentName] = value;
  }

  return {
    databaseName,
    host: host.toLowerCase(),
    port: url.port || "5432",
    environment,
  };
}

export function postgresProcessEnvironment(connection: PostgreSqlConnection) {
  const environment: Record<string, string> = { ...connection.environment };
  for (const name of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "SystemRoot",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

export function pgDumpArguments(snapshotId: string, dumpPath: string) {
  if (!snapshotId.trim()) throw new Error("Snapshot PostgreSQL obrigatorio.");
  return [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--snapshot=${snapshotId}`,
    `--file=${dumpPath}`,
  ];
}

export function pgRestoreArguments(databaseName: string, dumpPath: string) {
  if (!databaseName.trim()) throw new Error("Banco alvo obrigatorio.");
  return [
    "--exit-on-error",
    "--single-transaction",
    "--no-owner",
    "--no-privileges",
    `--dbname=${databaseName}`,
    dumpPath,
  ];
}

export async function runPostgreSqlCommand(
  executable: string,
  arguments_: string[],
  environment: Record<string, string>,
  label: string,
  timeoutMs = 900_000,
) {
  await new Promise<void>((resolve, reject) => {
    const isolatedProcessGroup = process.platform !== "win32";
    const child = spawn(executable, arguments_, {
      detached: isolatedProcessGroup,
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const signalProcessGroup = (signal: NodeJS.Signals) => {
      if (
        isolatedProcessGroup &&
        typeof child.pid === "number" &&
        child.pid > 1
      ) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        }
      }
      child.kill(signal);
    };
    let errorOutput = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup("SIGTERM");
      killTimer = setTimeout(() => signalProcessGroup("SIGKILL"), 5_000);
      killTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();
    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (errorOutput.length < 64 * 1024) errorOutput += chunk;
    });
    child.once("error", (error) => {
      clearTimers();
      reject(new Error(`${label} nao iniciou: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimers();
      if (timedOut) {
        return reject(
          new Error(`${label} excedeu timeout seguro de ${timeoutMs} ms.`),
        );
      }
      if (code === 0) return resolve();
      const detail = errorOutput.trim().slice(0, 4_096);
      reject(
        new Error(
          `${label} falhou (codigo ${code ?? "sem codigo"}${signal ? `, sinal ${signal}` : ""})${detail ? `: ${detail}` : "."}`,
        ),
      );
    });
  });
}

export async function createCustomPgDump(options: {
  databaseUrl: string;
  dumpPath: string;
  executable?: string;
  snapshotId: string;
  timeoutMs?: number;
}) {
  const connection = parsePostgreSqlConnection(
    options.databaseUrl,
    "DATABASE_URL",
  );
  await runPostgreSqlCommand(
    options.executable || "pg_dump",
    pgDumpArguments(options.snapshotId, options.dumpPath),
    postgresProcessEnvironment(connection),
    "pg_dump",
    options.timeoutMs,
  );
  await chmod(options.dumpPath, 0o600);
  await assertCustomPgDump(options.dumpPath);
}

export async function restoreCustomPgDump(options: {
  dumpPath: string;
  executable?: string;
  targetDatabaseUrl: string;
  timeoutMs?: number;
}) {
  const connection = parsePostgreSqlConnection(
    options.targetDatabaseUrl,
    "RESTORE_DATABASE_URL",
  );
  await runPostgreSqlCommand(
    options.executable || "pg_restore",
    pgRestoreArguments(connection.databaseName, options.dumpPath),
    postgresProcessEnvironment(connection),
    "pg_restore",
    options.timeoutMs,
  );
}

export async function verifyCustomPgDump(
  dumpPath: string,
  executable = "pg_restore",
  timeoutMs = 120_000,
) {
  await assertCustomPgDump(dumpPath);
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TMPDIR",
    "SystemRoot",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  await runPostgreSqlCommand(
    executable,
    ["--list", dumpPath],
    environment,
    "pg_restore --list",
    timeoutMs,
  );
}

async function assertCustomPgDump(dumpPath: string) {
  const file = await open(dumpPath, "r");
  try {
    const marker = Buffer.alloc(customDumpMagic.length);
    const { bytesRead } = await file.read(marker, 0, marker.length, 0);
    if (bytesRead !== marker.length || !marker.equals(customDumpMagic)) {
      throw new Error("Arquivo descriptografado nao e pg_dump custom valido.");
    }
  } finally {
    await file.close();
  }
}

function parseNullableMigrationTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error("Manifesto contem migration invalida.");
}

function manifestFromUnknown(value: unknown): NativeBackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifesto nativo invalido.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.format !== NATIVE_MANIFEST_FORMAT ||
    record.pgDumpFormat !== "custom" ||
    typeof record.generatedAt !== "string" ||
    Number.isNaN(Date.parse(record.generatedAt)) ||
    typeof record.postgresVersion !== "string" ||
    !record.postgresVersion.trim() ||
    !record.tables ||
    typeof record.tables !== "object" ||
    Array.isArray(record.tables) ||
    !record.sequences ||
    typeof record.sequences !== "object" ||
    Array.isArray(record.sequences) ||
    !Array.isArray(record.migrations)
  ) {
    throw new Error("Manifesto nativo invalido.");
  }

  const tables: Record<string, NativeTableProof> = {};
  for (const [table, proof] of Object.entries(
    record.tables as Record<string, unknown>,
  )) {
    if (
      !table ||
      table.includes("\0") ||
      !proof ||
      typeof proof !== "object" ||
      Array.isArray(proof)
    ) {
      throw new Error("Manifesto contem tabela invalida.");
    }
    const typed = proof as Record<string, unknown>;
    if (
      typeof typed.rows !== "string" ||
      !/^\d+$/.test(typed.rows) ||
      typeof typed.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(typed.sha256)
    ) {
      throw new Error(`Prova invalida para tabela ${table}.`);
    }
    tables[table] = {
      rows: typed.rows,
      sha256: typed.sha256.toLowerCase(),
    };
  }

  if (
    !record.structure ||
    typeof record.structure !== "object" ||
    Array.isArray(record.structure)
  ) {
    throw new Error("Manifesto nao contem prova estrutural valida.");
  }
  const rawStructure = record.structure as Record<string, unknown>;
  if (
    typeof rawStructure.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(rawStructure.sha256) ||
    !rawStructure.objects ||
    typeof rawStructure.objects !== "object" ||
    Array.isArray(rawStructure.objects)
  ) {
    throw new Error("Manifesto nao contem prova estrutural valida.");
  }
  const structureObjects: Record<string, string> = {};
  for (const [identity, digest] of Object.entries(
    rawStructure.objects as Record<string, unknown>,
  )) {
    if (
      !identity ||
      identity.includes("\0") ||
      typeof digest !== "string" ||
      !/^[0-9a-f]{64}$/i.test(digest)
    ) {
      throw new Error("Manifesto contem objeto estrutural invalido.");
    }
    structureObjects[identity] = digest.toLowerCase();
  }
  const structure: NativeStructureProof = {
    sha256: rawStructure.sha256.toLowerCase(),
    objects: structureObjects,
  };

  const migrations = record.migrations.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Manifesto contem migration invalida.");
    }
    const migration = value as Record<string, unknown>;
    if (
      typeof migration.migrationName !== "string" ||
      typeof migration.checksum !== "string"
    ) {
      throw new Error("Manifesto contem migration invalida.");
    }
    return {
      migrationName: migration.migrationName,
      checksum: migration.checksum,
      finishedAt: parseNullableMigrationTimestamp(migration.finishedAt),
      rolledBackAt: parseNullableMigrationTimestamp(migration.rolledBackAt),
    };
  });

  const sequences: Record<string, NativeSequenceProof> = {};
  for (const [sequence, proof] of Object.entries(
    record.sequences as Record<string, unknown>,
  )) {
    if (
      !sequence ||
      sequence.includes("\0") ||
      !proof ||
      typeof proof !== "object" ||
      Array.isArray(proof)
    ) {
      throw new Error("Manifesto contem sequence invalida.");
    }
    const typed = proof as Record<string, unknown>;
    if (
      typeof typed.dataType !== "string" ||
      !typed.dataType.trim() ||
      typeof typed.startValue !== "string" ||
      !/^-?\d+$/.test(typed.startValue) ||
      typeof typed.minValue !== "string" ||
      !/^-?\d+$/.test(typed.minValue) ||
      typeof typed.maxValue !== "string" ||
      !/^-?\d+$/.test(typed.maxValue) ||
      typeof typed.incrementBy !== "string" ||
      !/^-?\d+$/.test(typed.incrementBy) ||
      typeof typed.cacheSize !== "string" ||
      !/^\d+$/.test(typed.cacheSize) ||
      typeof typed.cycle !== "boolean" ||
      typeof typed.lastValue !== "string" ||
      !/^-?\d+$/.test(typed.lastValue) ||
      typeof typed.isCalled !== "boolean"
    ) {
      throw new Error(`Prova invalida para sequence ${sequence}.`);
    }
    sequences[sequence] = {
      dataType: typed.dataType,
      startValue: typed.startValue,
      minValue: typed.minValue,
      maxValue: typed.maxValue,
      incrementBy: typed.incrementBy,
      cacheSize: typed.cacheSize,
      cycle: typed.cycle,
      lastValue: typed.lastValue,
      isCalled: typed.isCalled,
    };
  }

  return {
    format: NATIVE_MANIFEST_FORMAT,
    generatedAt: record.generatedAt,
    pgDumpFormat: "custom",
    postgresVersion: record.postgresVersion,
    tables,
    structure,
    sequences,
    migrations,
  };
}

function headerFromUnknown(value: unknown): NativeBackupHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cabecalho de backup nativo invalido.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.format !== NATIVE_BACKUP_FORMAT ||
    record.algorithm !== algorithm ||
    typeof record.keyId !== "string" ||
    !record.keyId.trim() ||
    record.keyId.length > 200 ||
    typeof record.iv !== "string" ||
    Buffer.from(record.iv, "base64").length !== 12
  ) {
    throw new Error("Cabecalho de backup nativo invalido.");
  }
  return {
    format: NATIVE_BACKUP_FORMAT,
    algorithm,
    keyId: record.keyId,
    iv: record.iv,
  };
}

function lengthPrefix(length: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(length);
  return buffer;
}

async function writeBundle(
  dumpPath: string,
  bundlePath: string,
  manifest: NativeBackupManifest,
) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.length > maxManifestBytes) {
    throw new Error("Manifesto excede limite seguro.");
  }
  await writeFile(
    bundlePath,
    Buffer.concat([
      bundleMagic,
      lengthPrefix(manifestBytes.length),
      manifestBytes,
    ]),
    { flag: "wx", mode: 0o600 },
  );
  await pipeline(
    createReadStream(dumpPath),
    createWriteStream(bundlePath, { flags: "a", mode: 0o600 }),
  );
  await chmod(bundlePath, 0o600);
}

async function encryptBundle(
  bundlePath: string,
  outputPath: string,
  key: Buffer,
  keyId: string,
) {
  if (key.length !== 32) {
    throw new BadRequestException("Chave de backup deve possuir 32 bytes.");
  }
  const iv = randomBytes(12);
  const normalizedKeyId = keyId.trim() || "primary";
  if (normalizedKeyId.length > 200) {
    throw new BadRequestException(
      "Identificador da chave de backup deve possuir no maximo 200 caracteres.",
    );
  }
  const header: NativeBackupHeader = {
    format: NATIVE_BACKUP_FORMAT,
    algorithm,
    keyId: normalizedKeyId,
    iv: iv.toString("base64"),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const authenticatedHeader = Buffer.concat([
    outerMagic,
    lengthPrefix(headerBytes.length),
    headerBytes,
  ]);
  const outputDirectory = dirname(outputPath);
  const temporaryPath = join(
    outputDirectory,
    `.${basename(outputPath)}.${randomUUID()}.tmp`,
  );
  const cipher = createCipheriv(algorithm, key, iv);
  cipher.setAAD(authenticatedHeader);
  let published = false;
  try {
    await writeFile(temporaryPath, authenticatedHeader, {
      flag: "wx",
      mode: 0o600,
    });
    await pipeline(
      createReadStream(bundlePath),
      cipher,
      createWriteStream(temporaryPath, { flags: "a", mode: 0o600 }),
    );
    await appendFile(temporaryPath, cipher.getAuthTag());
    await chmod(temporaryPath, 0o600);
    await syncFile(temporaryPath);

    // link(2) publica o inode ja sincronizado de forma atomica e falha com
    // EEXIST, preservando qualquer backup anterior no destino.
    await link(temporaryPath, outputPath);
    published = true;
    await unlink(temporaryPath);
    await syncDirectoryWhenSupported(outputDirectory);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const path of [temporaryPath, ...(published ? [outputPath] : [])]) {
      try {
        await unlinkIfPresent(path);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (published) {
      try {
        await syncDirectoryWhenSupported(outputDirectory);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Falha ao publicar e limpar backup nativo.",
      );
    }
    throw error;
  }
}

export async function syncFile(path: string) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

function isUnsupportedDirectorySync(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS" ||
    (process.platform === "win32" &&
      (code === "EACCES" || code === "EISDIR" || code === "EPERM"))
  );
}

export async function syncDirectoryWhenSupported(path: string) {
  let directory;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await directory?.close();
  }
}

async function unlinkIfPresent(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function createEncryptedNativeBackup(options: {
  dumpPath: string;
  key: Buffer;
  keyId: string;
  manifest: NativeBackupManifest;
  outputPath: string;
}) {
  const directory = await mkdtemp(join(tmpdir(), "nexus-backup-bundle-"));
  await chmod(directory, 0o700);
  const bundlePath = join(directory, "backup.bundle");
  try {
    await writeBundle(options.dumpPath, bundlePath, options.manifest);
    await encryptBundle(
      bundlePath,
      options.outputPath,
      options.key,
      options.keyId,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readNativeHeader(filePath: string) {
  const file = await open(filePath, "r");
  try {
    const prefixLength = outerMagic.length + 4;
    const prefix = Buffer.alloc(prefixLength);
    const prefixRead = await file.read(prefix, 0, prefix.length, 0);
    if (
      prefixRead.bytesRead !== prefix.length ||
      !prefix.subarray(0, outerMagic.length).equals(outerMagic)
    ) {
      throw new Error("Arquivo nao usa formato de backup PostgreSQL nativo.");
    }
    const headerLength = prefix.readUInt32BE(outerMagic.length);
    if (headerLength < 2 || headerLength > maxHeaderBytes) {
      throw new Error("Cabecalho de backup nativo excede limite seguro.");
    }
    const headerBytes = Buffer.alloc(headerLength);
    const headerRead = await file.read(
      headerBytes,
      0,
      headerLength,
      prefixLength,
    );
    if (headerRead.bytesRead !== headerLength) {
      throw new Error("Cabecalho de backup nativo truncado.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      throw new Error("Cabecalho de backup nativo nao contem JSON valido.");
    }
    return {
      authenticatedHeader: Buffer.concat([prefix, headerBytes]),
      ciphertextStart: prefixLength + headerLength,
      header: headerFromUnknown(parsed),
    };
  } finally {
    await file.close();
  }
}

async function extractBundle(bundlePath: string, dumpPath: string) {
  const file = await open(bundlePath, "r");
  try {
    const prefixLength = bundleMagic.length + 4;
    const prefix = Buffer.alloc(prefixLength);
    const prefixRead = await file.read(prefix, 0, prefix.length, 0);
    if (
      prefixRead.bytesRead !== prefix.length ||
      !prefix.subarray(0, bundleMagic.length).equals(bundleMagic)
    ) {
      throw new Error("Conteudo descriptografado nao e bundle pg_dump valido.");
    }
    const manifestLength = prefix.readUInt32BE(bundleMagic.length);
    if (manifestLength < 2 || manifestLength > maxManifestBytes) {
      throw new Error("Manifesto nativo excede limite seguro.");
    }
    const manifestBytes = Buffer.alloc(manifestLength);
    const manifestRead = await file.read(
      manifestBytes,
      0,
      manifestLength,
      prefixLength,
    );
    if (manifestRead.bytesRead !== manifestLength) {
      throw new Error("Manifesto nativo truncado.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      throw new Error("Manifesto nativo nao contem JSON valido.");
    }
    const manifest = manifestFromUnknown(parsed);
    const dumpStart = prefixLength + manifestLength;
    const bundleStat = await stat(bundlePath);
    if (dumpStart >= bundleStat.size) {
      throw new Error("Bundle nativo nao contem arquivo pg_dump.");
    }
    await pipeline(
      createReadStream(bundlePath, { start: dumpStart }),
      createWriteStream(dumpPath, { flags: "wx", mode: 0o600 }),
    );
    await chmod(dumpPath, 0o600);
    await assertCustomPgDump(dumpPath);
    return manifest;
  } finally {
    await file.close();
  }
}

export async function decryptNativeBackup(options: {
  backupPath: string;
  expectedKeyId?: string;
  key: Buffer;
  maxBackupBytes: number;
}): Promise<DecryptedNativeBackup> {
  if (options.key.length !== 32) {
    throw new BadRequestException("Chave de backup deve possuir 32 bytes.");
  }
  const backupStat = await stat(options.backupPath);
  if (!backupStat.isFile()) throw new Error("Backup nao e arquivo regular.");
  if (backupStat.size > options.maxBackupBytes) {
    throw new Error("Backup excede limite seguro configurado.");
  }
  const { authenticatedHeader, ciphertextStart, header } =
    await readNativeHeader(options.backupPath);
  if (options.expectedKeyId && options.expectedKeyId !== header.keyId) {
    throw new Error("keyId do backup diverge do valor esperado.");
  }
  if (backupStat.size <= ciphertextStart + authTagBytes) {
    throw new Error("Backup PostgreSQL nativo truncado.");
  }

  const source = await open(options.backupPath, "r");
  const authTag = Buffer.alloc(authTagBytes);
  try {
    const tagRead = await source.read(
      authTag,
      0,
      authTagBytes,
      backupStat.size - authTagBytes,
    );
    if (tagRead.bytesRead !== authTagBytes) {
      throw new Error("Tag de autenticacao do backup truncada.");
    }
  } finally {
    await source.close();
  }

  const directory = await mkdtemp(join(tmpdir(), "nexus-restore-native-"));
  await chmod(directory, 0o700);
  const bundlePath = join(directory, "backup.bundle");
  const dumpPath = join(directory, "backup.dump");
  const decipher = createDecipheriv(
    algorithm,
    options.key,
    Buffer.from(header.iv, "base64"),
  );
  decipher.setAAD(authenticatedHeader);
  decipher.setAuthTag(authTag);
  try {
    await pipeline(
      createReadStream(options.backupPath, {
        start: ciphertextStart,
        end: backupStat.size - authTagBytes - 1,
      }),
      decipher,
      createWriteStream(bundlePath, { flags: "wx", mode: 0o600 }),
    );
    await chmod(bundlePath, 0o600);
    const manifest = await extractBundle(bundlePath, dumpPath);
    await rm(bundlePath, { force: true });
    return {
      directory,
      dumpPath,
      keyId: header.keyId,
      manifest,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    const message =
      error instanceof Error ? error.message : "falha desconhecida";
    throw new Error(
      `Backup PostgreSQL nao pode ser autenticado/descriptografado: ${message}`,
    );
  }
}

export async function isNativeBackupFile(filePath: string) {
  const file = await open(filePath, "r");
  try {
    const marker = Buffer.alloc(outerMagic.length);
    const { bytesRead } = await file.read(marker, 0, marker.length, 0);
    return bytesRead === marker.length && marker.equals(outerMagic);
  } finally {
    await file.close();
  }
}

export async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function createSecureTemporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}
