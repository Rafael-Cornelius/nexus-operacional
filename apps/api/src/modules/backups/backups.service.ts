import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type Backup } from "@prisma/client";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";
import {
  decryptBackupEnvelope,
  isEncryptedBackupEnvelope,
  parseBackupEncryptionKey,
} from "./backup-encryption";
import {
  createCustomPgDump,
  createEncryptedNativeBackup,
  createSecureTemporaryDirectory,
  decryptNativeBackup,
  isNativeBackupFile,
  sha256File,
  syncDirectoryWhenSupported,
  syncFile,
  verifyCustomPgDump,
} from "./native-backup";
import {
  buildNativeBackupManifest,
  collectSequenceProofs,
  totalManifestRows,
  type NativeProofSqlClient,
} from "./native-backup-proof";

interface BackupQuery {
  status?: string;
  take?: string;
}

interface BackupSnapshot {
  app?: string;
  generatedAt: string;
  format: "nexus-json-snapshot-v1";
  tables: Record<string, unknown[]>;
}

interface VerifiedBackupFile {
  backup: Backup;
  filePath: string;
  format: "nexus-encrypted-pgdump-v1" | "nexus-json-snapshot-v1";
  generatedAt: string;
  tableCount: number;
  rowCount: number | string;
  encrypted: true | boolean;
  native: boolean;
  legacySnapshot?: BackupSnapshot;
  storage: "primary" | "external";
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class BackupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async list(query: BackupQuery) {
    const take = this.sanitizeTake(query.take);
    const status = query.status?.trim().toUpperCase() || undefined;

    const [items, total, completed, failed, running, storage] =
      await Promise.all([
        this.prisma.backup.findMany({
          where: { status },
          orderBy: { createdAt: "desc" },
          take,
        }),
        this.prisma.backup.count(),
        this.prisma.backup.count({ where: { status: "COMPLETED" } }),
        this.prisma.backup.count({ where: { status: "FAILED" } }),
        this.prisma.backup.count({ where: { status: "RUNNING" } }),
        this.prisma.backup.aggregate({ _sum: { sizeBytes: true } }),
      ]);

    return {
      items: items.map((backup) => this.toDto(backup)),
      summary: {
        total,
        completed,
        failed,
        running,
        storageBytes: storage._sum.sizeBytes?.toString() ?? "0",
        latestCreatedAt: items[0]?.createdAt.toISOString() ?? null,
      },
    };
  }

  async create(user?: CurrentUser) {
    const backupDir =
      this.config.get<string>("BACKUP_DIR")?.trim() || "./backups";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `nexus-backup-${timestamp}.nxb`;
    const filePath = `${backupDir.replace(/[\\/]+$/, "")}/${fileName}`;
    const fullPath = resolve(process.cwd(), backupDir, fileName);
    const createdBy =
      user?.id && uuidPattern.test(user.id) ? user.id : undefined;
    let temporaryDirectory: string | undefined;
    let outputCreated = false;
    let externalPathCreated: string | undefined;

    try {
      await mkdir(resolve(process.cwd(), backupDir), {
        recursive: true,
        mode: 0o700,
      });
      await chmod(resolve(process.cwd(), backupDir), 0o700);
      const key = parseBackupEncryptionKey(
        this.config.get<string>("BACKUP_ENCRYPTION_KEY"),
      );
      const databaseUrl = this.config.get<string>("DATABASE_URL")?.trim();
      if (!databaseUrl)
        throw new Error("DATABASE_URL obrigatoria para pg_dump.");
      temporaryDirectory =
        await createSecureTemporaryDirectory("nexus-pgdump-");
      const dumpPath = resolve(temporaryDirectory, "database.dump");
      const generatedAt = new Date().toISOString();
      const configuredTimeout = Number(
        this.config.get<string>("BACKUP_COMMAND_TIMEOUT_MS") ?? 900_000,
      );
      const timeout = Number.isSafeInteger(configuredTimeout)
        ? Math.min(Math.max(configuredTimeout, 60_000), 3_600_000)
        : 900_000;

      const manifest = await this.prisma.$transaction(
        async (transaction) => {
          const client: NativeProofSqlClient = {
            query: <T extends object>(sql: string, ...parameters: unknown[]) =>
              transaction.$queryRawUnsafe<T[]>(sql, ...parameters),
            execute: (sql: string, ...parameters: unknown[]) =>
              transaction.$executeRawUnsafe(sql, ...parameters),
          };
          const snapshots = await transaction.$queryRawUnsafe<
            Array<{ snapshot_id: string }>
          >("SELECT pg_export_snapshot() AS snapshot_id");
          const snapshotId = snapshots[0]?.snapshot_id;
          if (!snapshotId)
            throw new Error("PostgreSQL nao exportou snapshot consistente.");

          const contentManifest = await buildNativeBackupManifest(
            client,
            generatedAt,
          );
          // Transacao REPEATABLE READ permanece aberta ate pg_dump consumir o
          // snapshot exportado por completo.
          await createCustomPgDump({
            databaseUrl,
            dumpPath,
            executable:
              this.config.get<string>("PG_DUMP_PATH")?.trim() || "pg_dump",
            snapshotId,
            timeoutMs: timeout,
          });
          const sequencesAfterDump = await collectSequenceProofs(client);
          if (
            JSON.stringify(contentManifest.sequences) !==
            JSON.stringify(sequencesAfterDump)
          ) {
            throw new Error(
              "Sequences mudaram durante pg_dump; backup recusado.",
            );
          }
          return contentManifest;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 10_000,
          timeout,
        },
      );

      await createEncryptedNativeBackup({
        dumpPath,
        key,
        keyId:
          this.config.get<string>("BACKUP_ENCRYPTION_KEY_ID")?.trim() ||
          "primary",
        manifest,
        outputPath: fullPath,
      });
      outputCreated = true;

      const [checksum, fileStat] = await Promise.all([
        sha256File(fullPath),
        stat(fullPath),
      ]);
      externalPathCreated =
        (await this.copyToExternalStorage(fullPath, fileName, checksum)) ??
        undefined;

      const backup = await this.prisma.$transaction(async (transaction) => {
        const persisted = await transaction.backup.create({
          data: {
            filePath,
            status: "COMPLETED",
            sizeBytes: BigInt(fileStat.size),
            checksum,
            createdBy,
          },
        });

        await this.audit.record(
          {
            userId: user?.id,
            module: "backups",
            action: "create",
            entity: "Backup",
            entityId: persisted.id,
            after: {
              ...this.toDto(persisted),
              encrypted: true,
              externalStored: Boolean(externalPathCreated),
              format: manifest.format,
              tableCount: Object.keys(manifest.tables).length,
              rowCount: totalManifestRows(manifest),
            },
          },
          transaction,
        );
        return persisted;
      });

      return {
        ...this.toDto(backup),
        encrypted: true,
        externalStored: Boolean(externalPathCreated),
        format: "nexus-encrypted-pgdump-v1" as const,
      };
    } catch (error) {
      const cleanupResults = await Promise.allSettled([
        ...(outputCreated ? [this.unlinkIfPresent(fullPath)] : []),
        ...(externalPathCreated
          ? [this.unlinkIfPresent(externalPathCreated)]
          : []),
      ]);
      const cleanupMessages = cleanupResults.flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? result.reason.message
                : "falha desconhecida",
            ]
          : [],
      );
      const failure = cleanupMessages.length
        ? new Error(
            `${error instanceof Error ? error.message : "Falha desconhecida"}; limpeza incompleta: ${cleanupMessages.join("; ")}`,
            { cause: error },
          )
        : error;
      await this.recordFailedBackup(filePath, createdBy, user, failure);
      throw new InternalServerErrorException(
        "Nao foi possivel gerar o backup do banco.",
        { cause: failure },
      );
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  async verify(id: string, user?: CurrentUser) {
    const verified = await this.loadVerifiedBackup(id);
    const result = {
      ...this.toDto(verified.backup),
      format: verified.format,
      generatedAt: verified.generatedAt,
      tableCount: verified.tableCount,
      rowCount: verified.rowCount,
      checksumValid: true,
      encrypted: verified.encrypted,
      storage: verified.storage,
    };

    await this.audit.record({
      userId: user?.id,
      module: "backups",
      action: "verify",
      entity: "Backup",
      entityId: id,
      after: result,
    });
    return result;
  }

  async rehearseRestore(id: string, user?: CurrentUser) {
    const verified = await this.loadVerifiedBackup(id);

    const result = {
      backupId: id,
      status: verified.native
        ? "NATIVE_ARCHIVE_VERIFICATION_PASSED"
        : "LEGACY_SNAPSHOT_VERIFICATION_PASSED",
      destructive: false,
      tableCount: verified.tableCount,
      rowCount: verified.rowCount,
      requiresDisposableDatabase: true,
      note: verified.native
        ? "Use backup:restore:prove em PostgreSQL novo e vazio para provar restauracao real."
        : "Backup JSON legado foi somente autenticado e lido; restauracao recusada por perda potencial de fidelidade.",
    };
    await this.audit.record({
      userId: user?.id,
      module: "backups",
      action: "restore_rehearsal",
      entity: "Backup",
      entityId: id,
      after: result,
    });
    return result;
  }

  async enforceRetention() {
    const configured = Number(
      this.config.get<string>("BACKUP_RETENTION_COUNT") ?? 30,
    );
    const keep = Number.isFinite(configured)
      ? Math.min(Math.max(Math.trunc(configured), 1), 365)
      : 30;
    const [pending, expired] = await Promise.all([
      this.prisma.backup.findMany({
        where: { status: "RETENTION_PENDING" },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.backup.findMany({
        where: { status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        skip: keep,
      }),
    ]);
    const candidates = [
      ...new Map(
        [...pending, ...expired].map((backup) => [backup.id, backup]),
      ).values(),
    ];
    let removed = 0;
    for (const backup of candidates) {
      const retentionBackup =
        backup.status === "RETENTION_PENDING"
          ? backup
          : await this.prisma.$transaction(async (transaction) => {
              const claimed = await transaction.backup.updateMany({
                where: { id: backup.id, status: "COMPLETED" },
                data: { status: "RETENTION_PENDING" },
              });
              if (claimed.count !== 1) return null;
              const marked = { ...backup, status: "RETENTION_PENDING" };
              await this.audit.record(
                {
                  module: "backups",
                  action: "retention_mark",
                  entity: "Backup",
                  entityId: backup.id,
                  before: this.toDto(backup),
                  after: this.toDto(marked),
                  reason: `Retencao automatica: manter ${keep} backups concluidos.`,
                },
                transaction,
              );
              return marked;
            });
      if (!retentionBackup) continue;

      const filePath = await this.resolveBackupFile(backup.filePath, false);
      const primaryRemovedNow = await this.unlinkIfPresent(filePath);
      const externalPath = this.externalBackupPath(backup.filePath);
      const externalRemovedNow = externalPath
        ? await this.unlinkIfPresent(externalPath)
        : false;

      await this.prisma.$transaction(async (transaction) => {
        await transaction.backup.delete({ where: { id: backup.id } });
        await this.audit.record(
          {
            module: "backups",
            action: "retention_delete",
            entity: "Backup",
            entityId: backup.id,
            before: this.toDto(retentionBackup),
            after: {
              deleted: true,
              primaryAbsent: true,
              primaryRemovedNow,
              externalConfigured: Boolean(externalPath),
              externalAbsent: Boolean(externalPath),
              externalRemovedNow,
            },
            reason: `Retencao automatica: manter ${keep} backups concluidos.`,
          },
          transaction,
        );
      });
      removed += 1;
    }
    return { kept: keep, removed };
  }

  private async loadVerifiedBackup(id: string): Promise<VerifiedBackupFile> {
    if (!uuidPattern.test(id))
      throw new BadRequestException("Identificador de backup invalido.");
    const backup = await this.prisma.backup.findUnique({ where: { id } });
    if (!backup) throw new NotFoundException("Backup nao encontrado.");
    if (backup.status !== "COMPLETED" || !backup.checksum) {
      throw new BadRequestException(
        "Somente backups concluidos e assinados podem ser verificados.",
      );
    }

    let filePath: string;
    let storage: "primary" | "external" = "primary";
    try {
      filePath = await this.resolveBackupFile(backup.filePath, true);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      filePath = await this.resolveExternalBackupFile(backup.filePath);
      storage = "external";
    }
    const fileStat = await stat(filePath);
    const configuredLimit = Number(
      this.config.get<string>("BACKUP_MAX_VERIFY_BYTES") ??
        2 * 1024 * 1024 * 1024,
    );
    const maxBytes = Number.isSafeInteger(configuredLimit)
      ? Math.min(Math.max(configuredLimit, 1024), 16 * 1024 * 1024 * 1024)
      : 2 * 1024 * 1024 * 1024;
    if (fileStat.size > maxBytes)
      throw new BadRequestException(
        "Backup excede o limite seguro de verificacao.",
      );

    const checksum = await sha256File(filePath);
    if (checksum !== backup.checksum)
      throw new BadRequestException("Checksum do backup nao confere.");

    if (await isNativeBackupFile(filePath)) {
      const key = parseBackupEncryptionKey(
        this.config.get<string>("BACKUP_ENCRYPTION_KEY"),
      );
      const decrypted = await decryptNativeBackup({
        backupPath: filePath,
        key,
        maxBackupBytes: maxBytes,
      });
      try {
        await verifyCustomPgDump(
          decrypted.dumpPath,
          this.config.get<string>("PG_RESTORE_PATH")?.trim() || "pg_restore",
          120_000,
        );
        return {
          backup,
          filePath,
          format: "nexus-encrypted-pgdump-v1",
          generatedAt: decrypted.manifest.generatedAt,
          tableCount: Object.keys(decrypted.manifest.tables).length,
          rowCount: totalManifestRows(decrypted.manifest),
          encrypted: true,
          native: true,
          storage,
        };
      } finally {
        await decrypted.cleanup();
      }
    }

    // Compatibilidade somente de leitura/verificacao. Snapshot JSON legado nao
    // pode alimentar restauracao porque perde fidelidade de tipos PostgreSQL.
    const buffer = await readFile(filePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new BadRequestException("Backup nao contem JSON valido.");
    }
    let encrypted = false;
    if (isEncryptedBackupEnvelope(parsed)) {
      encrypted = true;
      const key = parseBackupEncryptionKey(
        this.config.get<string>("BACKUP_ENCRYPTION_KEY"),
      );
      try {
        parsed = JSON.parse(decryptBackupEnvelope(parsed, key));
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException(
          "Conteudo descriptografado do backup nao contem JSON valido.",
        );
      }
    }
    const snapshot = this.parseSnapshot(parsed);
    const tableCount = Object.keys(snapshot.tables).length;
    const rowCount = Object.values(snapshot.tables).reduce(
      (total, rows) => total + rows.length,
      0,
    );
    return {
      backup,
      filePath,
      format: snapshot.format,
      generatedAt: snapshot.generatedAt,
      tableCount,
      rowCount,
      encrypted,
      native: false,
      legacySnapshot: snapshot,
      storage,
    };
  }

  private parseSnapshot(value: unknown): BackupSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("Estrutura de backup invalida.");
    }
    const record = value as Record<string, unknown>;
    if (record.format !== "nexus-json-snapshot-v1") {
      throw new BadRequestException("Formato de backup nao suportado.");
    }
    if (
      typeof record.generatedAt !== "string" ||
      Number.isNaN(Date.parse(record.generatedAt))
    ) {
      throw new BadRequestException("Data de geracao do backup invalida.");
    }
    if (
      !record.tables ||
      typeof record.tables !== "object" ||
      Array.isArray(record.tables)
    ) {
      throw new BadRequestException("Backup sem conjunto de tabelas valido.");
    }

    const tables: Record<string, unknown[]> = {};
    for (const [tableName, rows] of Object.entries(
      record.tables as Record<string, unknown>,
    )) {
      if (!/^[a-z][a-z0-9_]*$/.test(tableName) || !Array.isArray(rows)) {
        throw new BadRequestException(
          `Tabela invalida no backup: ${tableName}.`,
        );
      }
      tables[tableName] = rows;
    }
    if (!Object.keys(tables).length)
      throw new BadRequestException("Backup nao possui tabelas.");
    return {
      app: typeof record.app === "string" ? record.app : undefined,
      generatedAt: record.generatedAt,
      format: "nexus-json-snapshot-v1",
      tables,
    };
  }

  private async resolveBackupFile(storedPath: string, mustExist: boolean) {
    const configuredDir =
      this.config.get<string>("BACKUP_DIR")?.trim() || "./backups";
    const backupRoot = resolve(process.cwd(), configuredDir);
    const candidate = isAbsolute(storedPath)
      ? resolve(storedPath)
      : resolve(process.cwd(), storedPath);
    if (
      candidate !== backupRoot &&
      !candidate.startsWith(`${backupRoot}${sep}`)
    ) {
      throw new BadRequestException(
        "Caminho de backup fora do diretorio autorizado.",
      );
    }
    if (!mustExist) return candidate;

    try {
      const [realRoot, realFile] = await Promise.all([
        realpath(backupRoot),
        realpath(candidate),
      ]);
      if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) {
        throw new BadRequestException(
          "Arquivo de backup resolve para fora do diretorio autorizado.",
        );
      }
      return realFile;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new NotFoundException("Arquivo fisico do backup nao encontrado.");
    }
  }

  private externalBackupPath(storedPath: string) {
    const configuredDir = this.config
      .get<string>("BACKUP_EXTERNAL_DIR")
      ?.trim();
    if (!configuredDir) return null;
    return resolve(process.cwd(), configuredDir, basename(storedPath));
  }

  private async resolveExternalBackupFile(storedPath: string) {
    const configuredDir = this.config
      .get<string>("BACKUP_EXTERNAL_DIR")
      ?.trim();
    if (!configuredDir)
      throw new NotFoundException("Arquivo fisico do backup nao encontrado.");
    const externalRoot = resolve(process.cwd(), configuredDir);
    const candidate = resolve(externalRoot, basename(storedPath));
    try {
      const [realRoot, realFile] = await Promise.all([
        realpath(externalRoot),
        realpath(candidate),
      ]);
      if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) {
        throw new BadRequestException(
          "Copia externa resolve para fora do diretorio autorizado.",
        );
      }
      return realFile;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new NotFoundException(
        "Arquivo fisico do backup nao encontrado nos armazenamentos configurados.",
      );
    }
  }

  private async copyToExternalStorage(
    fullPath: string,
    fileName: string,
    checksum: string,
  ) {
    const configuredDir = this.config
      .get<string>("BACKUP_EXTERNAL_DIR")
      ?.trim();
    if (!configuredDir) return null;
    const externalRoot = resolve(process.cwd(), configuredDir);
    const primaryRoot = resolve(
      process.cwd(),
      this.config.get<string>("BACKUP_DIR")?.trim() || "./backups",
    );
    if (externalRoot === primaryRoot)
      throw new BadRequestException(
        "BACKUP_EXTERNAL_DIR deve ser diferente de BACKUP_DIR.",
      );
    await mkdir(externalRoot, { recursive: true, mode: 0o700 });
    await chmod(externalRoot, 0o700);
    const externalPath = resolve(externalRoot, basename(fileName));
    const temporaryExternalPath = resolve(
      externalRoot,
      `.${basename(fileName)}.${randomUUID()}.tmp`,
    );
    let published = false;
    try {
      await copyFile(
        fullPath,
        temporaryExternalPath,
        fsConstants.COPYFILE_EXCL,
      );
      await chmod(temporaryExternalPath, 0o600);
      const externalChecksum = await sha256File(temporaryExternalPath);
      if (externalChecksum !== checksum) {
        throw new BadRequestException(
          "Copia externa do backup falhou na verificacao de checksum.",
        );
      }
      await syncFile(temporaryExternalPath);
      // Hard link publica atomicamente e nunca sobrescreve destino existente.
      await link(temporaryExternalPath, externalPath);
      published = true;
      await this.unlinkIfPresent(temporaryExternalPath);
      await syncDirectoryWhenSupported(externalRoot);
      return externalPath;
    } catch (error) {
      const cleanup = await Promise.allSettled([
        this.unlinkIfPresent(temporaryExternalPath),
        ...(published ? [this.unlinkIfPresent(externalPath)] : []),
      ]);
      const cleanupFailure = cleanup.find(
        (result) => result.status === "rejected",
      );
      if (cleanupFailure?.status === "rejected") {
        throw new Error(
          `Falha ao limpar copia externa incompleta: ${cleanupFailure.reason instanceof Error ? cleanupFailure.reason.message : "erro desconhecido"}`,
          { cause: error },
        );
      }
      await syncDirectoryWhenSupported(externalRoot);
      throw error;
    }
  }

  private async recordFailedBackup(
    filePath: string,
    createdBy: string | undefined,
    user: CurrentUser | undefined,
    error: unknown,
  ) {
    const message =
      error instanceof Error ? error.message : "Falha desconhecida";
    try {
      await this.prisma.$transaction(async (transaction) => {
        const backup = await transaction.backup.create({
          data: {
            filePath,
            status: "FAILED",
            createdBy,
          },
        });

        await this.audit.record(
          {
            userId: user?.id,
            module: "backups",
            action: "failed",
            entity: "Backup",
            entityId: backup.id,
            after: { ...this.toDto(backup), error: message },
          },
          transaction,
        );
      });
    } catch {
      // If the database itself is unavailable, the HTTP error above is the only safe signal.
    }
  }

  private errorCode(error: unknown) {
    return error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  }

  private async unlinkIfPresent(filePath: string) {
    try {
      await unlink(filePath);
      return true;
    } catch (error) {
      if (this.errorCode(error) !== "ENOENT") throw error;
      return false;
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
      createdBy: backup.createdBy,
    };
  }
}
