import { expect, test } from "@playwright/test";

const adminEmail = process.env.INITIAL_ADMIN_EMAIL;
const adminPassword = process.env.INITIAL_ADMIN_PASSWORD;

test.beforeAll(() => {
  if (!adminEmail || !adminPassword) {
    throw new Error("INITIAL_ADMIN_EMAIL e INITIAL_ADMIN_PASSWORD sao obrigatorios no E2E operacional.");
  }
});

test("autentica na API real, valida PostgreSQL e encerra a sessao", async ({ page, context }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "NEXUS OPERACIONAL" })).toBeVisible();

  await page.getByLabel("Email").fill(adminEmail!);
  await page.getByLabel("Senha").fill(adminPassword!);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Dashboard geral" })).toBeVisible();

  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === "nexus_session");
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie?.httpOnly).toBe(true);

  const currentSession = await context.request.get("/api/auth/me");
  expect(currentSession.status()).toBe(200);
  await expect(currentSession.json()).resolves.toMatchObject({
    user: { email: adminEmail, roles: ["ADMIN"] }
  });

  const databaseHealth = await context.request.get("/api/health/db");
  expect(databaseHealth.status()).toBe(200);
  await expect(databaseHealth.json()).resolves.toMatchObject({ status: "ok", database: "reachable" });

  const logout = await context.request.post("/api/auth/logout", { data: {} });
  expect(logout.status()).toBe(201);

  const expiredSession = await context.request.get("/api/auth/me");
  expect(expiredSession.status()).toBe(401);
});
