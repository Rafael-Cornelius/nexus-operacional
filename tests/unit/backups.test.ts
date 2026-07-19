import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupsService } from "../../apps/api/src/modules/backups/backups.service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function backupFixture() {
  const directory = await mkdtemp(join(tmpdir(), "nexus-backup-test-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "snapshot.json");
  const payload = JSON.stringify({
    app: "NEXUS OPERACIONAL",
    generatedAt: "2026-07-18T12:00:00.000Z",
    format: "nexus-json-snapshot-v1",
    tables: { users: [] }
  });
  await writeFile(filePath, payload, "utf8");
  return {
    directory,
    filePath,
    checksum: createHash("sha256").update(payload).digest("hex")
  };
}

describe("backups service", () => {
  it("creates encrypted primary and checksum-matched external copies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-backup-create-"));
    temporaryDirectories.push(directory);
    const primary = join(directory, "primary");
    const external = join(directory, "external");
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ table_name: "users" }]),
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: "user-1", email: "private@example.com" }])
    };
    const backupCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "9f57f108-1e84-49c1-a39b-dff31dc07ca7",
      ...data,
      createdAt: new Date("2026-07-19T12:00:00.000Z")
    }));
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction)),
      backup: { create: backupCreate }
    };
    const settings: Record<string, string> = {
      BACKUP_DIR: primary,
      BACKUP_EXTERNAL_DIR: external,
      BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      BACKUP_ENCRYPTION_KEY_ID: "key-2026-07"
    };
    const service = new BackupsService(prisma as never, { get: vi.fn((key: string) => settings[key]) } as never, { record: vi.fn() } as never);

    const result = await service.create();
    const primaryBytes = await readFile(join(primary, result.fileName));
    const externalBytes = await readFile(join(external, result.fileName));
    expect(result).toMatchObject({ encrypted: true, externalStored: true });
    expect(result.fileName).toMatch(/\.nxb$/);
    expect(primaryBytes.equals(externalBytes)).toBe(true);
    expect(primaryBytes.toString("utf8")).not.toContain("private@example.com");
    expect(JSON.parse(primaryBytes.toString("utf8"))).toMatchObject({
      format: "nexus-encrypted-backup-v1",
      algorithm: "aes-256-gcm",
      keyId: "key-2026-07"
    });
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
            createdBy: null
          }
        ]),
        count: vi.fn().mockResolvedValue(1),
        aggregate: vi.fn().mockResolvedValue({ _sum: { sizeBytes: 2048n } })
      }
    };

    const service = new BackupsService(prisma as never, { get: vi.fn() } as never, { record: vi.fn() } as never);

    await expect(service.list({ take: "10" })).resolves.toMatchObject({
      items: [
        {
          id: "backup-1",
          fileName: "nexus-backup.json",
          sizeBytes: "2048",
          createdAt: "2026-05-25T10:00:00.000Z"
        }
      ],
      summary: {
        total: 1,
        storageBytes: "2048",
        latestCreatedAt: "2026-05-25T10:00:00.000Z"
      }
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
      createdBy: null
    };
    const prisma = { backup: { findUnique: vi.fn().mockResolvedValue(backup) } };
    const config = { get: vi.fn((key: string) => key === "BACKUP_DIR" ? fixture.directory : undefined) };
    const audit = { record: vi.fn() };
    const service = new BackupsService(prisma as never, config as never, audit as never);

    await expect(service.verify(backup.id)).resolves.toMatchObject({
      id: backup.id,
      checksumValid: true,
      tableCount: 1,
      rowCount: 0
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "verify", entityId: backup.id }));
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
          createdBy: null
        })
      }
    };
    const config = { get: vi.fn((key: string) => key === "BACKUP_DIR" ? fixture.directory : undefined) };
    const service = new BackupsService(prisma as never, config as never, { record: vi.fn() } as never);

    await expect(service.verify("76092fc5-8b27-47dc-a20f-02965688a756")).rejects.toThrow("Checksum");
  });

  it("rehearses every row in temporary PostgreSQL tables without changing production tables", async () => {
    const fixture = await backupFixture();
    const backup = {
      id: "a346ae3c-dd96-445d-8fa9-ddbcd4d01c2e",
      filePath: fixture.filePath,
      status: "COMPLETED",
      sizeBytes: 100n,
      checksum: fixture.checksum,
      createdAt: new Date("2026-07-18T12:00:00.000Z"),
      createdBy: null
    };
    const transaction = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: 0n }])
    };
    const prisma = {
      backup: { findUnique: vi.fn().mockResolvedValue(backup) },
      $queryRaw: vi.fn().mockResolvedValue([{ table_name: "users" }]),
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction))
    };
    const config = { get: vi.fn((key: string) => key === "BACKUP_DIR" ? fixture.directory : undefined) };
    const service = new BackupsService(prisma as never, config as never, { record: vi.fn() } as never);

    await expect(service.rehearseRestore(backup.id)).resolves.toMatchObject({
      status: "RESTORE_REHEARSAL_PASSED",
      destructive: false,
      tableCount: 1,
      rowCount: 0
    });
    expect(transaction.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("CREATE TEMP TABLE"));
  });
});
