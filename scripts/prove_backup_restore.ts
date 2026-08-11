import { PrismaClient } from "@prisma/client";
import {
  inspectCompletelyEmptyRestoreTarget,
  parseRestoreProofConfig,
  readVerifiedNativeBackup,
  restoreNativeBackupToEmptyDatabase,
} from "../apps/api/src/modules/backups/backup-restore-proof";
import type { NativeProofSqlClient } from "../apps/api/src/modules/backups/native-backup-proof";

function backupPathFromArguments(arguments_: string[]) {
  if (arguments_.length === 2 && arguments_[0] === "--file" && arguments_[1]) {
    return arguments_[1];
  }
  throw new Error(
    "Uso: npm run backup:restore:prove -- --file /caminho/backup.nxb",
  );
}

function adaptSqlClient(
  client: Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">,
): NativeProofSqlClient {
  return {
    query: async <T extends object>(sql: string, ...parameters: unknown[]) =>
      client.$queryRawUnsafe<T[]>(sql, ...parameters),
    execute: (sql: string, ...parameters: unknown[]) =>
      client.$executeRawUnsafe(sql, ...parameters),
  };
}

function targetClient(targetDatabaseUrl: string) {
  return new PrismaClient({
    datasources: { db: { url: targetDatabaseUrl } },
  });
}

async function main() {
  const backupPath = backupPathFromArguments(process.argv.slice(2));
  const config = parseRestoreProofConfig(process.env, backupPath);
  const backup = await readVerifiedNativeBackup(
    config,
    process.env.BACKUP_ENCRYPTION_KEY,
  );
  let prisma: PrismaClient | undefined;

  try {
    // Somente RESTORE_DATABASE_URL chega ao Prisma. DATABASE_URL origem foi
    // usada apenas na comparacao textual de identidade em parseRestoreProofConfig.
    prisma = targetClient(config.targetDatabaseUrl);
    await prisma.$connect();
    await inspectCompletelyEmptyRestoreTarget(
      adaptSqlClient(prisma),
      config.expectedTargetDatabaseName,
    );
    await prisma.$disconnect();
    prisma = undefined;

    const result = await restoreNativeBackupToEmptyDatabase({
      backup,
      config,
      reconnectAndVerify: async () => {
        prisma = targetClient(config.targetDatabaseUrl);
        await prisma.$connect();
        return adaptSqlClient(prisma);
      },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prisma?.$disconnect();
    await backup.cleanup();
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Falha desconhecida.";
  process.stderr.write(`Prova de restauracao falhou: ${message}\n`);
  process.exitCode = 1;
});
