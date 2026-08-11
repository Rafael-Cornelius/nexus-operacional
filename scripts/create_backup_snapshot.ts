import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../apps/api/src/infrastructure/database/prisma.service";
import { RequestContextService } from "../apps/api/src/infrastructure/request-context/request-context.service";
import { AuditService } from "../apps/api/src/modules/audit/audit.service";
import { BackupsService } from "../apps/api/src/modules/backups/backups.service";

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    const requestContext = new RequestContextService();
    const audit = new AuditService(prisma, requestContext);
    const backups = new BackupsService(prisma, new ConfigService(), audit);
    const result = await backups.create();

    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Falha desconhecida.";
  process.stderr.write(`Criacao do backup para prova falhou: ${message}\n`);
  process.exitCode = 1;
});
