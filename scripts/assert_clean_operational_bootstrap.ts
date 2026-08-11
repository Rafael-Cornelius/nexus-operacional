import { PrismaClient } from "@prisma/client";

const permittedBootstrapTables = new Set([
  "users",
  "roles",
  "permissions",
  "user_roles",
  "role_permissions",
  "system_settings"
]);
const tableNamePattern = /^[a-z][a-z0-9_]*$/;

async function main() {
  const prisma = new PrismaClient();
  try {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name <> '_prisma_migrations'
       ORDER BY table_name
    `;
    if (!tables.length) throw new Error("Schema operacional ausente.");

    const counts: Record<string, number> = {};
    for (const { table_name: tableName } of tables) {
      if (!tableNamePattern.test(tableName)) {
        throw new Error(`Nome de tabela inesperado: ${tableName}.`);
      }
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM public."${tableName}"`
      );
      counts[tableName] = Number(rows[0]?.count ?? 0);
    }

    const adminState = await prisma.$queryRaw<Array<{ total: bigint; active: bigint; email: string | null }>>`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE active AND deleted_at IS NULL)::bigint AS active,
             MIN(email) AS email
        FROM users
    `;
    const userTotal = Number(adminState[0]?.total ?? 0);
    const activeUsers = Number(adminState[0]?.active ?? 0);
    if (userTotal !== 1 || activeUsers !== 1) {
      throw new Error(
        `Bootstrap não está limpo: esperado um administrador ativo; encontrados ${userTotal} usuário(s), ${activeUsers} ativo(s).`
      );
    }
    const expectedAdminEmail = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
    if (expectedAdminEmail && adminState[0]?.email?.toLowerCase() !== expectedAdminEmail) {
      throw new Error("Administrador do banco diverge de INITIAL_ADMIN_EMAIL.");
    }

    const adminRoles = await prisma.$queryRaw<Array<{ total: bigint; admin: bigint; other: bigint }>>`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE roles.code = 'ADMIN')::bigint AS admin,
             COUNT(*) FILTER (WHERE roles.code <> 'ADMIN')::bigint AS other
        FROM user_roles
        JOIN roles ON roles.id = user_roles.role_id
        JOIN users ON users.id = user_roles.user_id
    `;
    const roleLinks = Number(adminRoles[0]?.total ?? 0);
    const adminLinks = Number(adminRoles[0]?.admin ?? 0);
    const otherRoleLinks = Number(adminRoles[0]?.other ?? 0);
    if (roleLinks !== 1 || adminLinks !== 1 || otherRoleLinks !== 0) {
      throw new Error(
        `Bootstrap não está limpo: administrador deve possuir exclusivamente o papel ADMIN; vínculos encontrados=${roleLinks}.`
      );
    }

    const settingKeys = await prisma.$queryRaw<Array<{ key: string }>>`
      SELECT key FROM system_settings ORDER BY key
    `;
    const unexpectedSettings = settingKeys.map(({ key }) => key).filter((key) => key !== "company");
    if (unexpectedSettings.length || settingKeys.length > 1) {
      throw new Error(
        `Bootstrap contém configuração não permitida: ${unexpectedSettings.join(", ") || "duplicidade"}.`
      );
    }

    const populated = Object.entries(counts)
      .filter(([tableName, count]) => !permittedBootstrapTables.has(tableName) && count > 0)
      .map(([tableName, count]) => `${tableName}=${count}`);
    if (populated.length) {
      throw new Error(
        `Banco não está zerado; nenhuma exclusão foi executada. Tabelas preenchidas: ${populated.join(", ")}.`
      );
    }

    process.stdout.write(`${JSON.stringify({
      status: "CLEAN_OPERATIONAL_BOOTSTRAP_CONFIRMED",
      users: userTotal,
      activeUsers,
      administratorRole: "ADMIN",
      permittedRbacRows: ["roles", "permissions", "user_roles", "role_permissions"]
        .reduce((total, tableName) => total + (counts[tableName] ?? 0), 0),
      companyConfigured: settingKeys.length === 1,
      emptyApplicationTables: Object.keys(counts).filter((tableName) => !permittedBootstrapTables.has(tableName)).length
    })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Falha desconhecida na prova de banco limpo."}\n`);
  process.exitCode = 1;
});
