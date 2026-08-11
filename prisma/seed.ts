import { PrismaClient } from "@prisma/client";
import {
  bootstrapProduction,
  parseProductionBootstrapConfig,
} from "./production-bootstrap";

const prisma = new PrismaClient();

async function main() {
  const config = parseProductionBootstrapConfig(process.env);
  const result = await bootstrapProduction(prisma, config);

  const passwordStatus = result.passwordRotated
    ? "senha existente rotacionada e sessoes revogadas"
    : result.adminCreated
      ? "administrador criado"
      : "administrador existente preservado";
  console.info(
    `Bootstrap operacional concluido: RBAC sincronizado; ${passwordStatus}; nenhum dado operacional foi criado ou removido.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Falha desconhecida no bootstrap operacional.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
