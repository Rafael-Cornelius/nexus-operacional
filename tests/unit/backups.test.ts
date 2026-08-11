import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupsService } from "../../apps/api/src/modules/backups/backups.service";
import {
  decryptNativeBackup,
  isNativeBackupFile,
} from "../../apps/api/src/modules/backups/native-backup";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function backupFixture() {
  const directory = await mkdtemp(join(tmpdir(), "nexus-backup-test-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "snapshot.json");
  const payload = JSON.stringify({
    app: "NEXUS OPERACIONAL",
    generatedAt: "2026-07-18T12:00:00.000Z",
    format: "nexus-json-snapshot-v1",
    tables: { users: [] },
  });
  await writeFile(filePath, payload, "utf8");
  return {
    directory,
    filePath,
    checksum: createHash("sha256").update(payload).digest("hex"),
  };
}

describe("backups service", () => {
  it("creates encrypted primary and checksum-matched external copies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-backup-create-"));
    temporaryDirectories.push(directory);
    const primary = join(directory, "primary");
    const external = join(directory, "external");
    const fakePgDump = join(directory, "fake-pg-dump.sh");
    await writeFile(
      fakePgDump,
      `#!/bin/sh
set -eu
dump_path=''
for argument in "$@"; do
  case "$argument" in
    --file=*) dump_path="\${argument#--file=}" ;;
  esac
done
test -n "$dump_path"
printf 'PGDMPprivate@example.com' > "$dump_path"
`,
      { mode: 0o700 },
    );
    await chmod(fakePgDump, 0o700);
    const backupCreate = vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "9f57f108-1e84-49c1-a39b-dff31dc07ca7",
        ...data,
        createdAt: new Date("2026-07-19T12:00:00.000Z"),
      }),
    );
    const transaction = {
      backup: { create: backupCreate },
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes("pg_export_snapshot"))
          return [{ snapshot_id: "00000001-1" }];
        if (sql.includes("SHOW server_version"))
          return [{ server_version: "16.9" }];
        if (sql.includes("information_schema.tables")) {
          return [{ schema_name: "public", table_name: "_prisma_migrations" }];
        }
        if (sql.includes("pg_catalog.pg_sequences")) return [];
        if (sql.includes("nexus_structure:")) return [];
        if (sql.includes("pg_catalog.pg_attribute")) {
          return [{ column_name: "id", formatted_type: "text" }];
        }
        if (sql.includes("migration_name, checksum")) {
          return [
            {
              migration_name: "0001_init",
              checksum: "checksum",
              finished_at: "2026-07-19T10:00:00.000Z",
              rolled_back_at: null,
            },
          ];
        }
        if (sql.includes("md5")) return [{ row_digest: "1".repeat(32) }];
        throw new Error(`SQL inesperado: ${sql}`);
      }),
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
      backup: { create: backupCreate },
    };
    const settings: Record<string, string> = {
      BACKUP_DIR: primary,
      BACKUP_EXTERNAL_DIR: external,
      BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      BACKUP_ENCRYPTION_KEY_ID: "key-2026-07",
      DATABASE_URL: "postgresql://nexus:secret@db:5432/nexus?schema=public",
      PG_DUMP_PATH: fakePgDump,
    };
    const audit = { record: vi.fn() };
    const service = new BackupsService(
      prisma as never,
      { get: vi.fn((key: string) => settings[key]) } as never,
      audit as never,
    );

    const result = await service.create();
    const primaryBytes = await readFile(join(primary, result.fileName));
    const externalBytes = await readFile(join(external, result.fileName));
    expect(result).toMatchObject({ encrypted: true, externalStored: true });
    expect(result.fileName).toMatch(/\.nxb$/);
    expect(primaryBytes.equals(externalBytes)).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create" }),
      transaction,
    );
    expect(primaryBytes.toString("utf8")).not.toContain("private@example.com");
    expect(await isNativeBackupFile(join(primary, result.fileName))).toBe(true);
    const decrypted = await decryptNativeBackup({
      backupPath: join(primary, result.fileName),
      expectedKeyId: "key-2026-07",
      key: Buffer.alloc(32, 7),
      maxBackupBytes: 1024 * 1024,
    });
    try {
      expect(await readFile(decrypted.dumpPath, "utf8")).toContain(
        "private@example.com",
      );
      expect(decrypted.manifest.format).toBe("nexus-pgdump-manifest-v1");
    } finally {
      await decrypted.cleanup();
    }
  });

  it("rolls back COMPLETED and FAILED metadata and removes both files when atomic audit fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-backup-rollback-"));
    temporaryDirectories.push(directory);
    const primary = join(directory, "primary");
    const external = join(directory, "external");
    const fakePgDump = join(directory, "fake-pg-dump.sh");
    await writeFile(
      fakePgDump,
      `#!/bin/sh
set -eu
for argument in "$@"; do
  case "$argument" in
    --file=*) printf 'PGDMProllback-test' > "\${argument#--file=}" ;;
  esac
done
`,
      { mode: 0o700 },
    );
    await chmod(fakePgDump, 0o700);

    const committedRows: Record<string, unknown>[] = [];
    const attemptedRows: Record<string, unknown>[] = [];
    const baseTransaction = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes("pg_export_snapshot"))
          return [{ snapshot_id: "snapshot" }];
        if (sql.includes("SHOW server_version"))
          return [{ server_version: "16.9" }];
        if (sql.includes("information_schema.tables")) {
          return [{ schema_name: "public", table_name: "_prisma_migrations" }];
        }
        if (sql.includes("pg_catalog.pg_sequences")) return [];
        if (sql.includes("nexus_structure:")) return [];
        if (sql.includes("pg_catalog.pg_attribute")) {
          return [{ column_name: "id", formatted_type: "text" }];
        }
        if (sql.includes("migration_name, checksum")) {
          return [
            {
              migration_name: "0001_init",
              checksum: "checksum",
              finished_at: "2026-08-01T00:00:00.000Z",
              rolled_back_at: null,
            },
          ];
        }
        if (sql.includes("md5")) return [];
        throw new Error(`SQL inesperado: ${sql}`);
      }),
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: never) => Promise<unknown>) => {
          let pending: Record<string, unknown> | undefined;
          const client = {
            ...baseTransaction,
            backup: {
              create: vi.fn(
                async ({ data }: { data: Record<string, unknown> }) => {
                  pending = data;
                  attemptedRows.push(data);
                  return {
                    id: "2842373f-69a8-4d92-a018-0aa4842373ab",
                    ...data,
                    createdAt: new Date("2026-08-01T12:00:00.000Z"),
                  };
                },
              ),
            },
          };
          const result = await operation(client as never);
          if (pending) committedRows.push(pending);
          return result;
        },
      ),
    };
    const settings: Record<string, string> = {
      BACKUP_DIR: primary,
      BACKUP_EXTERNAL_DIR: external,
      BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      DATABASE_URL: "postgresql://nexus:secret@db:5432/nexus?schema=public",
      PG_DUMP_PATH: fakePgDump,
    };
    const service = new BackupsService(
      prisma as never,
      { get: vi.fn((key: string) => settings[key]) } as never,
      {
        record: vi.fn().mockRejectedValue(new Error("audit unavailable")),
      } as never,
    );

    await expect(service.create()).rejects.toMatchObject({
      message: "Nao foi possivel gerar o backup do banco.",
      cause: expect.objectContaining({ message: "audit unavailable" }),
    });
    expect(committedRows).toEqual([]);
    expect(attemptedRows).toEqual([
      expect.objectContaining({ status: "COMPLETED" }),
      expect.objectContaining({ status: "FAILED" }),
    ]);
    expect(await readdir(primary)).toEqual([]);
    expect(await readdir(external)).toEqual([]);
  });

  it("never overwrites an external backup and removes temporary copies after verification failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-external-copy-"));
    temporaryDirectories.push(directory);
    const primary = join(directory, "primary");
    const external = join(directory, "external");
    await Promise.all([
      mkdir(primary, { recursive: true }),
      mkdir(external, { recursive: true }),
    ]);
    const fileName = "nexus-backup-exclusive.nxb";
    const primaryPath = join(primary, fileName);
    const externalPath = join(external, fileName);
    await writeFile(primaryPath, "new-encrypted-backup", "utf8");
    await writeFile(externalPath, "existing-protected-backup", "utf8");
    const service = new BackupsService(
      {} as never,
      {
        get: vi.fn((key: string) =>
          key === "BACKUP_DIR"
            ? primary
            : key === "BACKUP_EXTERNAL_DIR"
              ? external
              : undefined,
        ),
      } as never,
      {} as never,
    );
    const storage = service as unknown as {
      copyToExternalStorage(
        fullPath: string,
        targetName: string,
        checksum: string,
      ): Promise<string | null>;
    };

    await expect(
      storage.copyToExternalStorage(
        primaryPath,
        fileName,
        createHash("sha256").update("new-encrypted-backup").digest("hex"),
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(externalPath, "utf8")).toBe(
      "existing-protected-backup",
    );
    expect(await readdir(external)).toEqual([fileName]);

    await rm(externalPath);
    await expect(
      storage.copyToExternalStorage(primaryPath, fileName, "0".repeat(64)),
    ).rejects.toThrow("checksum");
    expect(await readdir(external)).toEqual([]);
  });

  it("marks retention pending before deleting files and safely resumes after database failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-retention-"));
    temporaryDirectories.push(directory);
    const primary = join(directory, "primary");
    const external = join(directory, "external");
    const fileName = "nexus-backup-expired.nxb";
    const primaryPath = join(primary, fileName);
    const externalPath = join(external, fileName);
    await Promise.all([
      mkdir(primary, { recursive: true }),
      mkdir(external, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(primaryPath, "primary", "utf8"),
      writeFile(externalPath, "external", "utf8"),
    ]);

    type BackupState = {
      id: string;
      filePath: string;
      status: string;
      sizeBytes: bigint | null;
      checksum: string | null;
      createdAt: Date;
      createdBy: string | null;
    };
    let row: BackupState | undefined = {
      id: "54fb76ae-9527-41c1-bc18-0951f1ca8f92",
      filePath: primaryPath,
      status: "COMPLETED",
      sizeBytes: 7n,
      checksum: "checksum",
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
      createdBy: null,
    };
    let failMarkAudit = true;
    let failFinalAudit = true;
    const audit = {
      record: vi.fn(async (input: { action: string }) => {
        if (input.action === "retention_mark" && failMarkAudit) {
          throw new Error("database mark audit failure");
        }
        if (input.action === "retention_delete" && failFinalAudit) {
          throw new Error("database audit failure");
        }
      }),
    };
    const prisma = {
      backup: {
        findMany: vi.fn(async ({ where }: { where: { status: string } }) =>
          row?.status === where.status ? [{ ...row }] : [],
        ),
      },
      $transaction: vi.fn(
        async (
          operation: (client: {
            backup: {
              updateMany(args: {
                where: { id: string; status: string };
                data: { status: string };
              }): Promise<{ count: number }>;
              delete(args: { where: { id: string } }): Promise<BackupState>;
            };
          }) => Promise<unknown>,
        ) => {
          const original = row ? { ...row } : undefined;
          let draft = row ? { ...row } : undefined;
          const transaction = {
            backup: {
              updateMany: vi.fn(
                async ({
                  where,
                  data,
                }: {
                  where: { id: string; status: string };
                  data: { status: string };
                }) => {
                  if (
                    !draft ||
                    draft.id !== where.id ||
                    draft.status !== where.status
                  ) {
                    return { count: 0 };
                  }
                  draft = { ...draft, ...data };
                  return { count: 1 };
                },
              ),
              delete: vi.fn(async ({ where }: { where: { id: string } }) => {
                if (!draft || draft.id !== where.id)
                  throw new Error("not found");
                const deleted = draft;
                draft = undefined;
                return deleted;
              }),
            },
          };
          try {
            const result = await operation(transaction);
            row = draft;
            return result;
          } catch (error) {
            row = original;
            throw error;
          }
        },
      ),
    };
    const service = new BackupsService(
      prisma as never,
      {
        get: vi.fn((key: string) =>
          key === "BACKUP_DIR"
            ? primary
            : key === "BACKUP_EXTERNAL_DIR"
              ? external
              : key === "BACKUP_RETENTION_COUNT"
                ? "1"
                : undefined,
        ),
      } as never,
      audit as never,
    );

    await expect(service.enforceRetention()).rejects.toThrow(
      "database mark audit failure",
    );
    expect(row?.status).toBe("COMPLETED");
    expect(await readFile(primaryPath, "utf8")).toBe("primary");
    expect(await readFile(externalPath, "utf8")).toBe("external");

    failMarkAudit = false;
    await expect(service.enforceRetention()).rejects.toThrow(
      "database audit failure",
    );
    expect(row?.status).toBe("RETENTION_PENDING");
    await expect(readFile(primaryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(externalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    failFinalAudit = false;
    await expect(service.enforceRetention()).resolves.toEqual({
      kept: 1,
      removed: 1,
    });
    expect(row).toBeUndefined();
    expect(audit.record.mock.calls.map(([input]) => input.action)).toEqual([
      "retention_mark",
      "retention_mark",
      "retention_delete",
      "retention_delete",
    ]);
    expect(audit.record.mock.calls.every((call) => Boolean(call[1]))).toBe(
      true,
    );
  });

  it("serializes BigInt sizes before returning backup rows", async () => {
    const createdAt = new Date("2026-05-25T10:00:00.000Z");
    const prisma = {
      backup: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "backup-1",
            filePath: "./backups/nexus-backup.json",
            status: "COMPLETED",
            sizeBytes: 2048n,
            checksum: "abc123",
            createdAt,
            createdBy: null,
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
        aggregate: vi.fn().mockResolvedValue({ _sum: { sizeBytes: 2048n } }),
      },
    };

    const service = new BackupsService(
      prisma as never,
      { get: vi.fn() } as never,
      { record: vi.fn() } as never,
    );

    await expect(service.list({ take: "10" })).resolves.toMatchObject({
      items: [
        {
          id: "backup-1",
          fileName: "nexus-backup.json",
          sizeBytes: "2048",
          createdAt: "2026-05-25T10:00:00.000Z",
        },
      ],
      summary: {
        total: 1,
        storageBytes: "2048",
        latestCreatedAt: "2026-05-25T10:00:00.000Z",
      },
    });
  });

  it("verifies checksum and snapshot structure before a restore", async () => {
    const fixture = await backupFixture();
    const backup = {
      id: "8fdb349d-ea49-4ef4-842a-970be880c988",
      filePath: fixture.filePath,
      status: "COMPLETED",
      sizeBytes: 100n,
      checksum: fixture.checksum,
      createdAt: new Date("2026-07-18T12:00:00.000Z"),
      createdBy: null,
    };
    const prisma = {
      backup: { findUnique: vi.fn().mockResolvedValue(backup) },
    };
    const config = {
      get: vi.fn((key: string) =>
        key === "BACKUP_DIR" ? fixture.directory : undefined,
      ),
    };
    const audit = { record: vi.fn() };
    const service = new BackupsService(
      prisma as never,
      config as never,
      audit as never,
    );

    await expect(service.verify(backup.id)).resolves.toMatchObject({
      id: backup.id,
      checksumValid: true,
      tableCount: 1,
      rowCount: 0,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "verify", entityId: backup.id }),
    );
  });

  it("rejects a backup whose file no longer matches its checksum", async () => {
    const fixture = await backupFixture();
    const prisma = {
      backup: {
        findUnique: vi.fn().mockResolvedValue({
          id: "76092fc5-8b27-47dc-a20f-02965688a756",
          filePath: fixture.filePath,
          status: "COMPLETED",
          sizeBytes: 100n,
          checksum: "checksum-incorreto",
          createdAt: new Date(),
          createdBy: null,
        }),
      },
    };
    const config = {
      get: vi.fn((key: string) =>
        key === "BACKUP_DIR" ? fixture.directory : undefined,
      ),
    };
    const service = new BackupsService(
      prisma as never,
      config as never,
      { record: vi.fn() } as never,
    );

    await expect(
      service.verify("76092fc5-8b27-47dc-a20f-02965688a756"),
    ).rejects.toThrow("Checksum");
  });

  it("keeps legacy JSON backups read-only and never replays their rows", async () => {
    const fixture = await backupFixture();
    const backup = {
      id: "a346ae3c-dd96-445d-8fa9-ddbcd4d01c2e",
      filePath: fixture.filePath,
      status: "COMPLETED",
      sizeBytes: 100n,
      checksum: fixture.checksum,
      createdAt: new Date("2026-07-18T12:00:00.000Z"),
      createdBy: null,
    };
    const transaction = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: 0n }]),
    };
    const prisma = {
      backup: { findUnique: vi.fn().mockResolvedValue(backup) },
      $queryRaw: vi.fn().mockResolvedValue([{ table_name: "users" }]),
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    };
    const config = {
      get: vi.fn((key: string) =>
        key === "BACKUP_DIR" ? fixture.directory : undefined,
      ),
    };
    const service = new BackupsService(
      prisma as never,
      config as never,
      { record: vi.fn() } as never,
    );

    await expect(service.rehearseRestore(backup.id)).resolves.toMatchObject({
      status: "LEGACY_SNAPSHOT_VERIFICATION_PASSED",
      destructive: false,
      tableCount: 1,
      rowCount: 0,
      requiresDisposableDatabase: true,
    });
    expect(transaction.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
