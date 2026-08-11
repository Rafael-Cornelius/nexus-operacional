import { createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectCompletelyEmptyRestoreTarget,
  parseRestoreProofConfig,
  readVerifiedNativeBackup,
  verifyRestoredDatabaseAfterCommit,
} from "../../apps/api/src/modules/backups/backup-restore-proof";
import {
  NATIVE_MANIFEST_FORMAT,
  createEncryptedNativeBackup,
  decryptNativeBackup,
  formatBackupCliError,
  parsePostgreSqlConnection,
  pgRestoreArguments,
  postgresProcessEnvironment,
  runPostgreSqlCommand,
  type NativeBackupManifest,
} from "../../apps/api/src/modules/backups/native-backup";
import {
  collectStructureProof,
  fingerprintStructuralDescriptors,
  type NativeProofSqlClient,
} from "../../apps/api/src/modules/backups/native-backup-proof";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL:
      "postgresql://source:secret@db:5432/nexus?schema=public&sslmode=require",
    RESTORE_DATABASE_URL:
      "postgresql://restore:secret@db:5432/nexus_restore_test?schema=public&sslmode=require",
    RESTORE_DATABASE_EXPECTED_NAME: "nexus_restore_test",
    RESTORE_CONFIRMATION: "RESTORE_TO_EMPTY_DATABASE:nexus_restore_test",
    RESTORE_BACKUP_SHA256: "a".repeat(64),
    ...overrides,
  };
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function waitForFile(path: string, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Processo de teste nao sinalizou prontidao: ${path}`);
}

const manifest: NativeBackupManifest = {
  format: NATIVE_MANIFEST_FORMAT,
  generatedAt: "2026-08-01T12:00:00.000Z",
  pgDumpFormat: "custom",
  postgresVersion: "16.9",
  tables: {
    "public._prisma_migrations": { rows: "1", sha256: "a".repeat(64) },
    "public.values": { rows: "2", sha256: "b".repeat(64) },
  },
  structure: {
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    objects: {},
  },
  sequences: {
    "public.values_id_seq": {
      dataType: "bigint",
      startValue: "1",
      minValue: "1",
      maxValue: "9223372036854775807",
      incrementBy: "1",
      cacheSize: "1",
      cycle: false,
      lastValue: "9007199254740993",
      isCalled: true,
    },
  },
  migrations: [
    {
      migrationName: "0001_init",
      checksum: "migration-checksum",
      finishedAt: "2026-08-01T10:00:00.000Z",
      rolledBackAt: null,
    },
  ],
};

describe("native PostgreSQL backup safety", () => {
  it("rejects source database and requires exact destructive-target confirmation", () => {
    expect(() =>
      parseRestoreProofConfig(
        environment({
          RESTORE_DATABASE_URL:
            "postgresql://other:other@db:5432/nexus?schema=another",
          RESTORE_DATABASE_EXPECTED_NAME: "nexus",
          RESTORE_CONFIRMATION: "RESTORE_TO_EMPTY_DATABASE:nexus",
        }),
        "/tmp/backup.nxb",
      ),
    ).toThrow("mesmo banco");
    expect(() =>
      parseRestoreProofConfig(
        environment({ RESTORE_CONFIRMATION: "yes" }),
        "/tmp/backup.nxb",
      ),
    ).toThrow("Confirmacao invalida");
  });

  it("removes Prisma-only URL options and preserves supported libpq TLS options", () => {
    const connection = parsePostgreSqlConnection(
      "postgresql://user:p%40ss@db:5432/nexus?schema=public&connection_limit=10&sslmode=verify-full&sslrootcert=%2Fcerts%2Fca.pem",
      "DATABASE_URL",
    );
    const commandEnvironment = postgresProcessEnvironment(connection);
    expect(commandEnvironment).toMatchObject({
      PGDATABASE: "nexus",
      PGHOST: "db",
      PGPASSWORD: "p@ss",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/certs/ca.pem",
      PGUSER: "user",
    });
    expect(commandEnvironment).not.toHaveProperty("DATABASE_URL");
    expect(commandEnvironment).not.toHaveProperty("schema");
  });

  it("preserves nested backup diagnostics while redacting connection secrets", () => {
    const error = new Error("Nao foi possivel gerar o backup do banco.", {
      cause: new Error(
        "pg_dump falhou em postgresql://nexus:private@db:5432/nexus password=private",
      ),
    });

    const diagnostic = formatBackupCliError(error);
    expect(diagnostic).toContain("Nao foi possivel gerar o backup do banco.");
    expect(diagnostic).toContain("pg_dump falhou");
    expect(diagnostic).not.toContain("nexus:private");
    expect(diagnostic).not.toContain("password=private");
  });

  it.skipIf(process.platform === "win32")(
    "kills the isolated PostgreSQL process group with TERM then KILL on timeout",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "nexus-pg-timeout-"));
      temporaryDirectories.push(directory);
      const scriptPath = join(directory, "stubborn-pg-command.sh");
      const descendantPidPath = join(directory, "descendant.pid");
      await writeFile(
        scriptPath,
        [
          "#!/bin/sh",
          "trap '' TERM",
          "(",
          "  trap '' TERM",
          "  while :; do sleep 1; done",
          ") &",
          'printf "%s" "$!" > "$PID_FILE"',
          "wait",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );

      const command = runPostgreSqlCommand(
        scriptPath,
        [],
        {
          PATH: process.env.PATH || "/usr/bin:/bin",
          PID_FILE: descendantPidPath,
        },
        "pg command stubborn",
        2_000,
      );
      const rejectedCommand = expect(command).rejects.toThrow(
        "excedeu timeout seguro",
      );
      const descendantPid = Number(await waitForFile(descendantPidPath));
      await rejectedCommand;

      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(await waitForProcessExit(descendantPid)).toBe(true);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    },
    15_000,
  );

  it("round-trips exact pg_dump custom bytes through AES-256-GCM and 0600 temp files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-native-roundtrip-"));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, "source.dump");
    const backupPath = join(directory, "backup.nxb");
    const dumpBytes = Buffer.concat([
      Buffer.from("PGDMP", "ascii"),
      Buffer.from([0, 255, 0, 1, 128, 64]),
      Buffer.from("precise-native-data", "utf8"),
    ]);
    const key = randomBytes(32);
    await writeFile(dumpPath, dumpBytes, { mode: 0o600 });
    await createEncryptedNativeBackup({
      dumpPath,
      key,
      keyId: "key-2026-08",
      manifest,
      outputPath: backupPath,
    });

    expect((await readdir(directory)).sort()).toEqual([
      "backup.nxb",
      "source.dump",
    ]);

    const encrypted = await readFile(backupPath);
    expect(encrypted.includes(Buffer.from("precise-native-data"))).toBe(false);
    const decrypted = await decryptNativeBackup({
      backupPath,
      expectedKeyId: "key-2026-08",
      key,
      maxBackupBytes: 1024 * 1024,
    });
    try {
      expect(await readFile(decrypted.dumpPath)).toEqual(dumpBytes);
      expect(decrypted.manifest).toEqual(manifest);
      expect((await stat(decrypted.dumpPath)).mode & 0o777).toBe(0o600);
      expect((await stat(decrypted.directory)).mode & 0o777).toBe(0o700);
    } finally {
      await decrypted.cleanup();
    }
  });

  it("rejects a keyId that its own reader would reject", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-native-key-id-"));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, "source.dump");
    const backupPath = join(directory, "backup.nxb");
    await writeFile(dumpPath, Buffer.from("PGDMPpayload"), { mode: 0o600 });

    await expect(
      createEncryptedNativeBackup({
        dumpPath,
        key: randomBytes(32),
        keyId: "x".repeat(201),
        manifest,
        outputPath: backupPath,
      }),
    ).rejects.toThrow("no maximo 200");
    await expect(stat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual(["source.dump"]);
  });

  it("publishes without overwrite and removes its exclusive temporary file on failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-native-publish-"));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, "source.dump");
    const backupPath = join(directory, "backup.nxb");
    const existing = Buffer.from("backup anterior deve permanecer intacto");
    await writeFile(dumpPath, Buffer.from("PGDMPpayload"), { mode: 0o600 });
    await writeFile(backupPath, existing, { mode: 0o600 });

    await expect(
      createEncryptedNativeBackup({
        dumpPath,
        key: randomBytes(32),
        keyId: "primary",
        manifest,
        outputPath: backupPath,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(backupPath)).toEqual(existing);
    expect((await readdir(directory)).sort()).toEqual([
      "backup.nxb",
      "source.dump",
    ]);
  });

  it("removes the decrypted dump when pg_restore --list fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-native-cleanup-"));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, "source.dump");
    const backupPath = join(directory, "backup.nxb");
    const capturedPath = join(directory, "decrypted-path.txt");
    const failingPgRestore = join(directory, "failing-pg-restore.sh");
    const key = randomBytes(32);
    await writeFile(dumpPath, Buffer.from("PGDMPpayload"), { mode: 0o600 });
    await writeFile(
      failingPgRestore,
      `#!/bin/sh\nprintf '%s' "$2" > '${capturedPath}'\nexit 42\n`,
      { mode: 0o700 },
    );
    await createEncryptedNativeBackup({
      dumpPath,
      key,
      keyId: "primary",
      manifest,
      outputPath: backupPath,
    });
    const checksum = createHash("sha256")
      .update(await readFile(backupPath))
      .digest("hex");
    const config = parseRestoreProofConfig(
      environment({
        RESTORE_BACKUP_SHA256: checksum,
        PG_RESTORE_PATH: failingPgRestore,
      }),
      backupPath,
    );

    await expect(
      readVerifiedNativeBackup(config, key.toString("base64")),
    ).rejects.toThrow("pg_restore --list falhou");
    const decryptedPath = await readFile(capturedPath, "utf8");
    await expect(stat(dirname(decryptedPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fingerprints column types even when a table has no rows", () => {
    const bigint = fingerprintStructuralDescriptors([
      {
        object_type: "column",
        object_identity: '["public", "empty_table", "value"]',
        definition: '{"notNull":false,"type":"bigint"}',
      },
    ]);
    const numeric = fingerprintStructuralDescriptors([
      {
        object_type: "column",
        object_identity: '["public", "empty_table", "value"]',
        definition: '{"notNull":false,"type":"numeric(20,0)"}',
      },
    ]);

    expect(bigint.sha256).not.toBe(numeric.sha256);
    expect(bigint.objects).not.toEqual(numeric.objects);
  });

  it("collects every structural category required by the restore proof", async () => {
    const queries: string[] = [];
    const client: NativeProofSqlClient = {
      execute: async () => 0,
      query: async <T extends object>(sql: string) => {
        queries.push(sql);
        return [] as T[];
      },
    };

    await collectStructureProof(client);
    const sql = queries.join("\n");
    for (const category of [
      "tables",
      "columns",
      "constraints",
      "indexes",
      "triggers",
      "views",
      "routines",
      "types",
    ]) {
      expect(sql).toContain(`nexus_structure:${category}`);
    }
    expect(sql).toContain("pg_get_constraintdef");
    expect(sql).toContain("pg_get_indexdef");
    expect(sql).toContain("pg_get_triggerdef");
    expect(sql).toContain("pg_get_viewdef");
    expect(sql).toContain("pg_get_functiondef");
    expect(sql).toContain("attribute.attnotnull");
    expect(sql).toContain("attribute_default.adbin");
    expect(sql).toContain("AS column_collation");
    expect(sql).toContain("AS type_collation");
    expect(sql).not.toMatch(/\bAS\s+collation\b/i);
  });

  it("rejects ciphertext tampering before exposing a pg_dump file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-native-tamper-"));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, "source.dump");
    const backupPath = join(directory, "backup.nxb");
    const key = randomBytes(32);
    await writeFile(dumpPath, Buffer.from("PGDMPpayload"), { mode: 0o600 });
    await createEncryptedNativeBackup({
      dumpPath,
      key,
      keyId: "primary",
      manifest,
      outputPath: backupPath,
    });
    const payload = await readFile(backupPath);
    payload[payload.length - 17] ^= 0xff;
    await writeFile(backupPath, payload, { mode: 0o600 });

    await expect(
      decryptNativeBackup({
        backupPath,
        key,
        maxBackupBytes: 1024 * 1024,
      }),
    ).rejects.toThrow("autenticado/descriptografado");
  });

  it("requires a completely empty target, not a pre-migrated empty schema", async () => {
    const client: NativeProofSqlClient = {
      execute: async () => 0,
      query: async <T extends object>(sql: string) => {
        if (sql.includes("current_database")) {
          return [
            { database_name: "nexus_restore_test", schema_name: "public" },
          ] as T[];
        }
        return [
          { object_type: "relation", object_name: "public._prisma_migrations" },
        ] as T[];
      },
    };
    await expect(
      inspectCompletelyEmptyRestoreTarget(client, "nexus_restore_test"),
    ).rejects.toThrow("totalmente vazio");
  });

  it("checks non-relational objects before allowing a destructive restore", async () => {
    const queries: string[] = [];
    const client: NativeProofSqlClient = {
      execute: async () => 0,
      query: async <T extends object>(sql: string) => {
        queries.push(sql);
        if (sql.includes("current_database")) {
          return [
            { database_name: "nexus_restore_test", schema_name: "public" },
          ] as T[];
        }
        return [] as T[];
      },
    };

    await expect(
      inspectCompletelyEmptyRestoreTarget(client, "nexus_restore_test"),
    ).resolves.toMatchObject({ empty: true });
    const inspection = queries.join("\n");
    for (const catalog of [
      "pg_largeobject_metadata",
      "pg_collation",
      "pg_conversion",
      "pg_ts_config",
      "pg_ts_dict",
      "pg_event_trigger",
      "pg_publication",
      "pg_foreign_server",
    ]) {
      expect(inspection).toContain(catalog);
    }
    expect(inspection).toContain("AS catalog_collation");
    expect(inspection).not.toMatch(/\bAS\s+collation\b/i);
  });

  it("uses pg_restore atomic and fail-fast flags without source URL", () => {
    expect(
      pgRestoreArguments("nexus_restore_test", "/tmp/backup.dump"),
    ).toEqual([
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      "--dbname=nexus_restore_test",
      "/tmp/backup.dump",
    ]);
  });

  it("validates post-commit table content and exact migration metadata", async () => {
    const client: NativeProofSqlClient = {
      execute: async () => 0,
      query: async <T extends object>(sql: string) => {
        if (sql.includes("information_schema.tables")) {
          return [
            { schema_name: "public", table_name: "_prisma_migrations" },
            { schema_name: "public", table_name: "values" },
          ] as T[];
        }
        if (sql.includes("pg_catalog.pg_sequences")) {
          return [
            {
              schema_name: "public",
              sequence_name: "values_id_seq",
              data_type: "bigint",
              start_value: "1",
              min_value: "1",
              max_value: "9223372036854775807",
              increment_by: "1",
              cache_size: "1",
              cycle: false,
            },
          ] as T[];
        }
        if (sql.includes("nexus_structure:")) return [] as T[];
        if (sql.includes('FROM "public"."values_id_seq"')) {
          return [{ last_value: "9007199254740993", is_called: true }] as T[];
        }
        if (sql.includes("pg_catalog.pg_attribute")) {
          return [
            { column_name: "id", formatted_type: "numeric(30,10)" },
          ] as T[];
        }
        if (sql.includes("migration_name, checksum")) {
          return [
            {
              migration_name: "0001_init",
              checksum: "migration-checksum",
              finished_at: "2026-08-01T10:00:00.000Z",
              rolled_back_at: null,
            },
          ] as T[];
        }
        if (sql.includes("md5")) {
          const count = sql.includes('"values"') ? 2 : 1;
          return Array.from({ length: count }, () => ({
            row_digest: count === 2 ? "2".repeat(32) : "1".repeat(32),
          })) as T[];
        }
        throw new Error(`SQL inesperado: ${sql}`);
      },
    };
    const crypto = await import("node:crypto");
    const expected = structuredClone(manifest);
    expected.tables["public._prisma_migrations"].sha256 = crypto
      .createHash("sha256")
      .update("1".repeat(32))
      .digest("hex");
    expected.tables["public.values"].sha256 = crypto
      .createHash("sha256")
      .update(`${"2".repeat(32)}\n${"2".repeat(32)}`)
      .digest("hex");

    await expect(
      verifyRestoredDatabaseAfterCommit(client, expected),
    ).resolves.toMatchObject({ tables: expected.tables });

    const wrongMigration = structuredClone(expected);
    wrongMigration.migrations[0].checksum = "wrong";
    await expect(
      verifyRestoredDatabaseAfterCommit(client, wrongMigration),
    ).rejects.toThrow("Migrations restauradas divergem");

    const wrongSequence = structuredClone(expected);
    wrongSequence.sequences["public.values_id_seq"].incrementBy = "5";
    await expect(
      verifyRestoredDatabaseAfterCommit(client, wrongSequence),
    ).rejects.toThrow("Sequences restauradas divergem");

    const wrongStructure = structuredClone(expected);
    wrongStructure.structure.sha256 = "f".repeat(64);
    await expect(
      verifyRestoredDatabaseAfterCommit(client, wrongStructure),
    ).rejects.toThrow("Estrutura PostgreSQL restaurada diverge");
  });
});
