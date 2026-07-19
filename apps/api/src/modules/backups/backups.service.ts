import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type Backup } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";

interface BackupQuery {
  status?: string;
  take?: string;
}

interface DatabaseTable {
  table_name: string;
}

interface BackupSnapshot {
  app?: string;
  generatedAt: string;
  format: "nexus-json-snapshot-v1";
  tables: Record<string, unknown[]>;
}

interface VerifiedSnapshot {
  backup: Backup;
  filePath: string;
  snapshot: BackupSnapshot;
  tableCount: number;
  rowCount: number;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class BackupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService
  ) {}

  async list(query: BackupQuery) {
    const take = this.sanitizeTake(query.take);
    const status = query.status?.trim().toUpperCase() || undefined;

    const [items, total, completed, failed, running, storage] = await Promise.all([
      this.prisma.backup.findMany({
        where: { status },
        orderBy: { createdAt: "desc" },
        take
      }),
      this.prisma.backup.count(),
      this.prisma.backup.count({ where: { status: "COMPLETED" } }),
      this.prisma.backup.count({ where: { status: "FAILED" } }),
      this.prisma.backup.count({ where: { status: "RUNNING" } }),
      this.prisma.backup.aggregate({ _sum: { sizeBytes: true } })
    ]);

    return {
      items: items.map((backup) => this.toDto(backup)),
      summary: {
        total,
        completed,
        failed,
        running,
        storageBytes: storage._sum.sizeBytes?.toString() ?? "0",
        latestCreatedAt: items[0]?.createdAt.toISOString() ?? null
      }
    };
  }

  async create(user?: CurrentUser) {
    const backupDir = this.config.get<string>("BACKUP_DIR")?.trim() || "./backups";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `nexus-backup-${timestamp}.json`;
    const filePath = `${backupDir.replace(/[\\/]+$/, "")}/${fileName}`;
    const fullPath = resolve(process.cwd(), backupDir, fileName);
    const createdBy = user?.id && uuidPattern.test(user.id) ? user.id : undefined;

    try {
      await mkdir(resolve(process.cwd(), backupDir), { recursive: true, mode: 0o700 });
      await chmod(resolve(process.cwd(), backupDir), 0o700);
      const snapshot = await this.buildSnapshot();
      const payload = JSON.stringify(snapshot, this.jsonReplacer, 2);
      await writeFile(fullPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(fullPath, 0o600);

      const [fileBuffer, fileStat] = await Promise.all([readFile(fullPath), stat(fullPath)]);
      const checksum = createHash("sha256").update(fileBuffer).digest("hex");

      const backup = await this.prisma.backup.create({
        data: {
          filePath,
          status: "COMPLETED",
          sizeBytes: BigInt(fileStat.size),
          checksum,
          createdBy
        }
      });

      await this.audit.record({
        userId: user?.id,
        module: "backups",
        action: "create",
        entity: "Backup",
        entityId: backup.id,
        after: this.toDto(backup)
      });

      return this.toDto(backup);
    } catch (error) {
      await this.recordFailedBackup(filePath, createdBy, user, error);
      throw new InternalServerErrorException("Nao foi possivel gerar o backup do banco.");
    }
  }

  async verify(id: string, user?: CurrentUser) {
    const verified = await this.loadVerifiedSnapshot(id);
    const result = {
      ...this.toDto(verified.backup),
      format: verified.snapshot.format,
      generatedAt: verified.snapshot.generatedAt,
      tableCount: verified.tableCount,
      rowCount: verified.rowCount,
      checksumValid: true
    };

    await this.audit.record({
      userId: user?.id,
      module: "backups",
      action: "verify",
      entity: "Backup",
      entityId: id,
      after: result
    });
    return result;
  }

  async rehearseRestore(id: string, user?: CurrentUser) {
    const verified = await this.loadVerifiedSnapshot(id);
    const liveTables = await this.prisma.$queryRaw<DatabaseTable[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> '_prisma_migrations'
      ORDER BY table_name
    `;
    const available = new Set(liveTables.map((table) => table.table_name));
    const snapshotTables = Object.entries(verified.snapshot.tables);
    const missing = snapshotTables.map(([table]) => table).filter((table) => !available.has(table));
    if (missing.length) {
      throw new BadRequestException(`Backup possui tabelas ausentes no schema atual: ${missing.join(", ")}.`);
    }

    const restoredCounts = await this.prisma.$transaction(
      async (transaction) => {
        const counts: Record<string, number> = {};
        for (const [index, [tableName, rows]] of snapshotTables.entries()) {
          const tempTable = `nexus_restore_${index}`;
          await transaction.$executeRawUnsafe(
            `CREATE TEMP TABLE "${tempTable}" (LIKE public."${tableName}" INCLUDING ALL) ON COMMIT DROP`
          );
          if (rows.length) {
            await transaction.$executeRawUnsafe(
              `INSERT INTO "${tempTable}" SELECT * FROM jsonb_populate_recordset(NULL::public."${tableName}", $1::jsonb)`,
              JSON.stringify(rows)
            );
          }
          const countRows = await transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT COUNT(*)::bigint AS count FROM "${tempTable}"`
          );
          const restored = Number(countRows[0]?.count ?? 0);
          if (restored !== rows.length) {
            throw new BadRequestException(`Ensaio divergente na tabela ${tableName}: esperado ${rows.length}, restaurado ${restored}.`);
          }
          counts[tableName] = restored;
        }
        return counts;
      },
      { maxWait: 10_000, timeout: 120_000 }
    );

    const result = {
      backupId: id,
      status: "RESTORE_REHEARSAL_PASSED",
      destructive: false,
      tableCount: verified.tableCount,
      rowCount: verified.rowCount,
      restoredCounts
    };
    await this.audit.record({
      userId: user?.id,
      module: "backups",
      action: "restore_rehearsal",
      entity: "Backup",
      entityId: id,
      after: result
    });
    return result;
  }

  async enforceRetention() {
    const configured = Number(this.config.get<string>("BACKUP_RETENTION_COUNT") ?? 30);
    const keep = Number.isFinite(configured) ? Math.min(Math.max(Math.trunc(configured), 1), 365) : 30;
    const expired = await this.prisma.backup.findMany({
      where: { status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
      skip: keep
    });
    let removed = 0;
    for (const backup of expired) {
      const filePath = await this.resolveBackupFile(backup.filePath, false);
      try {
        await unlink(filePath);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "ENOENT") throw error;
      }
      await this.prisma.backup.delete({ where: { id: backup.id } });
      removed += 1;
    }
    return { kept: keep, removed };
  }

  private async buildSnapshot() {
    return this.prisma.$transaction(
      async (transaction) => {
        const tables = await transaction.$queryRaw<DatabaseTable[]>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'
            AND table_name <> '_prisma_migrations'
          ORDER BY table_name
        `;

        const data: Record<string, unknown[]> = {};
        for (const table of tables) {
          const tableName = table.table_name.replace(/"/g, "\"\"");
          data[table.table_name] = await transaction.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${tableName}"`);
        }

        return {
          app: this.config.get<string>("APP_NAME") ?? "NEXUS OPERACIONAL",
          generatedAt: new Date().toISOString(),
          format: "nexus-json-snapshot-v1" as const,
          tables: data
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: 120_000
      }
    );
  }

  private async loadVerifiedSnapshot(id: string): Promise<VerifiedSnapshot> {
    if (!uuidPattern.test(id)) throw new BadRequestException("Identificador de backup invalido.");
    const backup = await this.prisma.backup.findUnique({ where: { id } });
    if (!backup) throw new NotFoundException("Backup nao encontrado.");
    if (backup.status !== "COMPLETED" || !backup.checksum) {
      throw new BadRequestException("Somente backups concluidos e assinados podem ser verificados.");
    }

    const filePath = await this.resolveBackupFile(backup.filePath, true);
    const fileStat = await stat(filePath);
    const configuredLimit = Number(this.config.get<string>("BACKUP_MAX_VERIFY_BYTES") ?? 512 * 1024 * 1024);
    const maxBytes = Number.isFinite(configuredLimit) ? Math.max(configuredLimit, 1024) : 512 * 1024 * 1024;
    if (fileStat.size > maxBytes) throw new BadRequestException("Backup excede o limite seguro de verificacao.");

    const buffer = await readFile(filePath);
    const checksum = createHash("sha256").update(buffer).digest("hex");
    if (checksum !== backup.checksum) throw new BadRequestException("Checksum do backup nao confere.");

    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new BadRequestException("Backup nao contem JSON valido.");
    }
    const snapshot = this.parseSnapshot(parsed);
    const tableCount = Object.keys(snapshot.tables).length;
    const rowCount = Object.values(snapshot.tables).reduce((total, rows) => total + rows.length, 0);
    return { backup, filePath, snapshot, tableCount, rowCount };
  }

  private parseSnapshot(value: unknown): BackupSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("Estrutura de backup invalida.");
    }
    const record = value as Record<string, unknown>;
    if (record.format !== "nexus-json-snapshot-v1") {
      throw new BadRequestException("Formato de backup nao suportado.");
    }
    if (typeof record.generatedAt !== "string" || Number.isNaN(Date.parse(record.generatedAt))) {
      throw new BadRequestException("Data de geracao do backup invalida.");
    }
    if (!record.tables || typeof record.tables !== "object" || Array.isArray(record.tables)) {
      throw new BadRequestException("Backup sem conjunto de tabelas valido.");
    }

    const tables: Record<string, unknown[]> = {};
    for (const [tableName, rows] of Object.entries(record.tables as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_]*$/.test(tableName) || !Array.isArray(rows)) {
        throw new BadRequestException(`Tabela invalida no backup: ${tableName}.`);
      }
      tables[tableName] = rows;
    }
    if (!Object.keys(tables).length) throw new BadRequestException("Backup nao possui tabelas.");
    return {
      app: typeof record.app === "string" ? record.app : undefined,
      generatedAt: record.generatedAt,
      format: "nexus-json-snapshot-v1",
      tables
    };
  }

  private async resolveBackupFile(storedPath: string, mustExist: boolean) {
    const configuredDir = this.config.get<string>("BACKUP_DIR")?.trim() || "./backups";
    const backupRoot = resolve(process.cwd(), configuredDir);
    const candidate = isAbsolute(storedPath) ? resolve(storedPath) : resolve(process.cwd(), storedPath);
    if (candidate !== backupRoot && !candidate.startsWith(`${backupRoot}${sep}`)) {
      throw new BadRequestException("Caminho de backup fora do diretorio autorizado.");
    }
    if (!mustExist) return candidate;

    try {
      const [realRoot, realFile] = await Promise.all([realpath(backupRoot), realpath(candidate)]);
      if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) {
        throw new BadRequestException("Arquivo de backup resolve para fora do diretorio autorizado.");
      }
      return realFile;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new NotFoundException("Arquivo fisico do backup nao encontrado.");
    }
  }

  private async recordFailedBackup(filePath: string, createdBy: string | undefined, user: CurrentUser | undefined, error: unknown) {
    const message = error instanceof Error ? error.message : "Falha desconhecida";
    try {
      const backup = await this.prisma.backup.create({
        data: {
          filePath,
          status: "FAILED",
          createdBy
        }
      });

      await this.audit.record({
        userId: user?.id,
        module: "backups",
        action: "failed",
        entity: "Backup",
        entityId: backup.id,
        after: { ...this.toDto(backup), error: message }
      });
    } catch {
      // If the database itself is unavailable, the HTTP error above is the only safe signal.
    }
  }

  private sanitizeTake(raw?: string) {
    const parsed = Number(raw ?? 50);
    if (!Number.isFinite(parsed)) return 50;
    return Math.min(Math.max(Math.trunc(parsed), 1), 100);
  }

  private toDto(backup: Backup) {
    return {
      id: backup.id,
      filePath: backup.filePath,
      fileName: basename(backup.filePath),
      status: backup.status,
      sizeBytes: backup.sizeBytes?.toString() ?? null,
      checksum: backup.checksum,
      createdAt: backup.createdAt.toISOString(),
      createdBy: backup.createdBy
    };
  }

  private jsonReplacer(_key: string, value: unknown) {
    if (typeof value === "bigint") return value.toString();
    return value;
  }
}
