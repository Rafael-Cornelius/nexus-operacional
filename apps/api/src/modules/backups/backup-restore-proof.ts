import { stat } from "node:fs/promises";
import {
  decryptNativeBackup,
  parsePostgreSqlConnection,
  restoreCustomPgDump,
  sha256File,
  verifyCustomPgDump,
  type DecryptedNativeBackup,
  type NativeBackupManifest,
} from "./native-backup";
import {
  assertProofMatchesManifest,
  collectDatabaseProof,
  datasetSha256,
  totalManifestRows,
  type NativeProofSqlClient,
} from "./native-backup-proof";
import { parseBackupEncryptionKey } from "./backup-encryption";

const CONFIRMATION_PREFIX = "RESTORE_TO_EMPTY_DATABASE:";
const DEFAULT_MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const sha256Pattern = /^[0-9a-f]{64}$/i;

export interface DatabaseIdentity {
  databaseName: string;
  host: string;
  port: string;
}

export interface RestoreProofConfig {
  backupPath: string;
  expectedBackupSha256: string;
  expectedKeyId?: string;
  expectedTargetDatabaseName: string;
  maxBackupBytes: number;
  sourceIdentity: DatabaseIdentity;
  targetIdentity: DatabaseIdentity;
  targetDatabaseUrl: string;
  pgRestoreExecutable: string;
  restoreCommandTimeoutMs: number;
}

export interface RestoreProofResult {
  status: "RESTORE_PROOF_PASSED";
  format: "nexus-encrypted-pgdump-v1";
  durable: true;
  destructiveSourceAccess: false;
  databaseName: string;
  schemaName: "public";
  backupSha256: string;
  snapshotGeneratedAt: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  migrationCount: number;
  tableCount: number;
  rowCount: number | string;
  datasetSha256: string;
  structureSha256: string;
  tables: NativeBackupManifest["tables"];
  sequences: NativeBackupManifest["sequences"];
}

function requiredEnvironment(
  environment: Record<string, string | undefined>,
  name: string,
) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} obrigatoria.`);
  return value;
}

export function parseDatabaseIdentity(
  raw: string,
  label: string,
): DatabaseIdentity {
  const connection = parsePostgreSqlConnection(raw, label);
  return {
    databaseName: connection.databaseName,
    host: connection.host,
    port: connection.port,
  };
}

function sameDatabase(left: DatabaseIdentity, right: DatabaseIdentity) {
  return (
    left.host === right.host &&
    left.port === right.port &&
    left.databaseName === right.databaseName
  );
}

export function parseRestoreProofConfig(
  environment: Record<string, string | undefined>,
  backupPath: string,
): RestoreProofConfig {
  if (!backupPath.trim()) throw new Error("Caminho do backup obrigatorio.");
  const sourceUrl = requiredEnvironment(environment, "DATABASE_URL");
  const targetDatabaseUrl = requiredEnvironment(
    environment,
    "RESTORE_DATABASE_URL",
  );
  const sourceIdentity = parseDatabaseIdentity(sourceUrl, "DATABASE_URL");
  const targetIdentity = parseDatabaseIdentity(
    targetDatabaseUrl,
    "RESTORE_DATABASE_URL",
  );
  if (sameDatabase(sourceIdentity, targetIdentity)) {
    throw new Error(
      "RESTORE_DATABASE_URL aponta para o mesmo banco de DATABASE_URL.",
    );
  }
  if (sourceIdentity.databaseName === targetIdentity.databaseName) {
    throw new Error(
      "Banco de restauracao deve possuir nome diferente do banco de origem.",
    );
  }

  const expectedTargetDatabaseName = requiredEnvironment(
    environment,
    "RESTORE_DATABASE_EXPECTED_NAME",
  );
  if (expectedTargetDatabaseName !== targetIdentity.databaseName) {
    throw new Error(
      "RESTORE_DATABASE_EXPECTED_NAME diverge do nome presente em RESTORE_DATABASE_URL.",
    );
  }
  const confirmation = requiredEnvironment(environment, "RESTORE_CONFIRMATION");
  const expectedConfirmation = `${CONFIRMATION_PREFIX}${expectedTargetDatabaseName}`;
  if (confirmation !== expectedConfirmation) {
    throw new Error(
      `Confirmacao invalida. Valor exigido: ${expectedConfirmation}`,
    );
  }

  const expectedBackupSha256 = requiredEnvironment(
    environment,
    "RESTORE_BACKUP_SHA256",
  ).toLowerCase();
  if (!sha256Pattern.test(expectedBackupSha256)) {
    throw new Error("RESTORE_BACKUP_SHA256 deve conter SHA-256 hexadecimal.");
  }
  const configuredLimit = Number(
    environment.RESTORE_MAX_BACKUP_BYTES ?? DEFAULT_MAX_BACKUP_BYTES,
  );
  if (
    !Number.isSafeInteger(configuredLimit) ||
    configuredLimit < 1024 ||
    configuredLimit > 16 * 1024 * 1024 * 1024
  ) {
    throw new Error(
      "RESTORE_MAX_BACKUP_BYTES deve ser inteiro entre 1024 e 17179869184.",
    );
  }
  const configuredCommandTimeout = Number(
    environment.RESTORE_COMMAND_TIMEOUT_MS ?? 900_000,
  );
  if (
    !Number.isSafeInteger(configuredCommandTimeout) ||
    configuredCommandTimeout < 60_000 ||
    configuredCommandTimeout > 3_600_000
  ) {
    throw new Error(
      "RESTORE_COMMAND_TIMEOUT_MS deve ser inteiro entre 60000 e 3600000.",
    );
  }

  return {
    backupPath: backupPath.trim(),
    expectedBackupSha256,
    expectedKeyId: environment.RESTORE_BACKUP_KEY_ID?.trim() || undefined,
    expectedTargetDatabaseName,
    maxBackupBytes: configuredLimit,
    sourceIdentity,
    targetIdentity,
    targetDatabaseUrl,
    pgRestoreExecutable: environment.PG_RESTORE_PATH?.trim() || "pg_restore",
    restoreCommandTimeoutMs: configuredCommandTimeout,
  };
}

export async function readVerifiedNativeBackup(
  config: RestoreProofConfig,
  encryptionKeyValue: string | undefined,
): Promise<
  DecryptedNativeBackup & {
    backupSha256: string;
  }
> {
  const fileStat = await stat(config.backupPath);
  if (!fileStat.isFile()) {
    throw new Error("Caminho de backup nao e arquivo regular.");
  }
  if (fileStat.size > config.maxBackupBytes) {
    throw new Error("Backup excede RESTORE_MAX_BACKUP_BYTES.");
  }
  const checksum = await sha256File(config.backupPath);
  if (checksum !== config.expectedBackupSha256) {
    throw new Error("SHA-256 do backup diverge de RESTORE_BACKUP_SHA256.");
  }
  const key = parseBackupEncryptionKey(encryptionKeyValue);
  const decrypted = await decryptNativeBackup({
    backupPath: config.backupPath,
    expectedKeyId: config.expectedKeyId,
    key,
    maxBackupBytes: config.maxBackupBytes,
  });
  try {
    await verifyCustomPgDump(
      decrypted.dumpPath,
      config.pgRestoreExecutable,
      Math.min(config.restoreCommandTimeoutMs, 120_000),
    );
  } catch (error) {
    try {
      await decrypted.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Validacao do pg_dump falhou e temporario descriptografado nao pode ser removido.",
      );
    }
    throw error;
  }
  return { ...decrypted, backupSha256: checksum };
}

export async function inspectCompletelyEmptyRestoreTarget(
  client: NativeProofSqlClient,
  expectedDatabaseName: string,
) {
  const identity = await client.query<{
    database_name: string;
    schema_name: string;
  }>(
    "SELECT current_database() AS database_name, current_schema() AS schema_name",
  );
  if (identity[0]?.database_name !== expectedDatabaseName) {
    throw new Error(
      "current_database() diverge de RESTORE_DATABASE_EXPECTED_NAME.",
    );
  }
  if (identity[0]?.schema_name !== "public") {
    throw new Error("Restauracao exige current_schema() igual a public.");
  }

  const objects = await client.query<{
    object_type: string;
    object_name: string;
  }>(
    `SELECT object_type, object_name
       FROM (
         SELECT 'relation'::text AS object_type,
                namespace.nspname || '.' || relation.relname AS object_name
           FROM pg_catalog.pg_class AS relation
           JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
         UNION ALL
         SELECT 'routine'::text,
                namespace.nspname || '.' || routine.proname
           FROM pg_catalog.pg_proc AS routine
           JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         UNION ALL
         SELECT 'type'::text,
                namespace.nspname || '.' || type_row.typname
           FROM pg_catalog.pg_type AS type_row
           JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
            AND type_row.typtype IN ('b', 'c', 'd', 'e', 'm', 'r')
         UNION ALL
         SELECT 'schema'::text, namespace.nspname
           FROM pg_catalog.pg_namespace AS namespace
          WHERE namespace.nspname NOT IN ('public', 'information_schema')
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         UNION ALL
         SELECT 'extension'::text, extension.extname
           FROM pg_catalog.pg_extension AS extension
          WHERE extension.extname <> 'plpgsql'
         UNION ALL
         SELECT 'large_object'::text, large_object.oid::text
           FROM pg_catalog.pg_largeobject_metadata AS large_object
         UNION ALL
         SELECT 'collation'::text,
                namespace.nspname || '.' || catalog_collation.collname
           FROM pg_catalog.pg_collation AS catalog_collation
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = catalog_collation.collnamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         UNION ALL
         SELECT 'conversion'::text,
                namespace.nspname || '.' || conversion.conname
           FROM pg_catalog.pg_conversion AS conversion
           JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = conversion.connamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         UNION ALL
         SELECT 'text_search_config'::text,
                namespace.nspname || '.' || configuration.cfgname
           FROM pg_catalog.pg_ts_config AS configuration
           JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = configuration.cfgnamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         UNION ALL
         SELECT 'text_search_dictionary'::text,
                namespace.nspname || '.' || dictionary.dictname
           FROM pg_catalog.pg_ts_dict AS dictionary
           JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = dictionary.dictnamespace
          WHERE namespace.nspname <> 'information_schema'
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         UNION ALL
         SELECT 'event_trigger'::text, event_trigger.evtname
           FROM pg_catalog.pg_event_trigger AS event_trigger
         UNION ALL
         SELECT 'publication'::text, publication.pubname
           FROM pg_catalog.pg_publication AS publication
         UNION ALL
         SELECT 'foreign_server'::text, foreign_server.srvname
           FROM pg_catalog.pg_foreign_server AS foreign_server
       ) AS user_object
      ORDER BY object_type, object_name`,
  );
  if (objects.length) {
    throw new Error(
      `Banco alvo nao esta totalmente vazio. Primeiro objeto encontrado: ${objects[0].object_type} ${objects[0].object_name}.`,
    );
  }
  return {
    databaseName: expectedDatabaseName,
    schemaName: "public" as const,
    empty: true as const,
  };
}

export async function verifyRestoredDatabaseAfterCommit(
  client: NativeProofSqlClient,
  manifest: NativeBackupManifest,
) {
  const actual = await collectDatabaseProof(client);
  assertProofMatchesManifest(manifest, actual);
  return actual;
}

export async function restoreNativeBackupToEmptyDatabase(options: {
  backup: DecryptedNativeBackup & { backupSha256: string };
  config: RestoreProofConfig;
  reconnectAndVerify: () => Promise<NativeProofSqlClient>;
}) {
  const startedAt = new Date();

  // pg_restore recebe somente PG* derivados de RESTORE_DATABASE_URL. DATABASE_URL
  // nunca e repassada para cliente ou subprocesso de restauracao.
  await restoreCustomPgDump({
    dumpPath: options.backup.dumpPath,
    executable: options.config.pgRestoreExecutable,
    targetDatabaseUrl: options.config.targetDatabaseUrl,
    timeoutMs: options.config.restoreCommandTimeoutMs,
  });

  // Nova conexao depois do pg_restore comprova estado duravel apos COMMIT.
  const verificationClient = await options.reconnectAndVerify();
  const actual = await verifyRestoredDatabaseAfterCommit(
    verificationClient,
    options.backup.manifest,
  );
  const completedAt = new Date();
  return {
    status: "RESTORE_PROOF_PASSED" as const,
    format: "nexus-encrypted-pgdump-v1" as const,
    durable: true as const,
    destructiveSourceAccess: false as const,
    databaseName: options.config.expectedTargetDatabaseName,
    schemaName: "public" as const,
    backupSha256: options.backup.backupSha256,
    snapshotGeneratedAt: options.backup.manifest.generatedAt,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    migrationCount: actual.migrations.filter(
      (migration) => migration.finishedAt && !migration.rolledBackAt,
    ).length,
    tableCount: Object.keys(actual.tables).length,
    rowCount: totalManifestRows(options.backup.manifest),
    datasetSha256: datasetSha256(
      actual.tables,
      actual.sequences,
      actual.structure,
    ),
    structureSha256: actual.structure.sha256,
    tables: actual.tables,
    sequences: actual.sequences,
  } satisfies RestoreProofResult;
}
