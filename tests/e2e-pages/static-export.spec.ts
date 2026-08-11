import { expect, test } from "@playwright/test";

const basePath = "/nexus-operacional";
const routes = [
  "dashboard",
  "importacao",
  "cadastros-base",
  "produtos",
  "equipamentos",
  "turnos",
  "semanas",
  "metas",
  "producao/p1",
  "producao/p2",
  "perdas",
  "paradas",
  "dosagem",
  "produtividade",
  "sobrepeso",
  "historico",
  "relatorios",
  "apresentacoes",
  "backups",
  "usuarios",
  "auditoria",
  "configuracoes",
];

test("serves the exact GitHub Pages export with basePath and working login", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const criticalResource = ["document", "script", "stylesheet", "font"].includes(
      request.resourceType(),
    );
    if (
      request.url().includes(basePath) &&
      criticalResource &&
      request.failure()?.errorText !== "net::ERR_ABORTED"
    ) {
      runtimeErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`);
    }
  });

  const loginResponse = await page.goto(`${basePath}/login/`);
  expect(loginResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "NEXUS OPERACIONAL" })).toBeVisible();
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(new RegExp(`${basePath}/dashboard/?$`));
  await expect(page.getByRole("heading", { name: "Dashboard geral" })).toBeVisible();
  await expect(page.getByText("Preview ao vivo")).toBeVisible();

  for (const route of routes) {
    const response = await page.goto(`${basePath}/${route}/`);
    expect(response?.status(), route).toBe(200);
    await expect(page.locator("main").getByRole("heading").first(), route).toBeVisible();
    await page.waitForFunction(() => {
      const color = window.getComputedStyle(document.body).backgroundColor;
      return document.styleSheets.length > 0 && color !== "rgba(0, 0, 0, 0)";
    });
  }

  expect(runtimeErrors).toEqual([]);
});
