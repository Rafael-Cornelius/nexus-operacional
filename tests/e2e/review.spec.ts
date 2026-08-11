import { expect, test } from "@playwright/test";

test.setTimeout(90_000);

const reviewRoutes = [
  { slug: "home", path: "/" },
  { slug: "login", path: "/login" },
  { slug: "dashboard", path: "/dashboard" },
  { slug: "importacao", path: "/importacao" },
  { slug: "cadastros-base", path: "/cadastros-base" },
  { slug: "produtos", path: "/produtos" },
  { slug: "equipamentos", path: "/equipamentos" },
  { slug: "turnos", path: "/turnos" },
  { slug: "semanas", path: "/semanas" },
  { slug: "metas", path: "/metas" },
  { slug: "producao-p1", path: "/producao/p1" },
  { slug: "producao-p2", path: "/producao/p2" },
  { slug: "perdas", path: "/perdas" },
  { slug: "paradas", path: "/paradas" },
  { slug: "dosagem", path: "/dosagem" },
  { slug: "produtividade", path: "/produtividade" },
  { slug: "sobrepeso", path: "/sobrepeso" },
  { slug: "historico", path: "/historico" },
  { slug: "relatorios", path: "/relatorios" },
  { slug: "apresentacoes", path: "/apresentacoes" },
  { slug: "backups", path: "/backups" },
  { slug: "usuarios", path: "/usuarios" },
  { slug: "auditoria", path: "/auditoria" },
  { slug: "configuracoes", path: "/configuracoes" }
];

for (const route of reviewRoutes) {
  test(`review screenshot ${route.slug}`, async ({ page }, testInfo) => {
    await page.goto("/login", { timeout: 90_000 });
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard geral" })).toBeVisible();
    await page.goto(route.path, { timeout: 90_000 });
    await expect(page.locator("main").getByRole("heading").first()).toBeVisible();
    await page.waitForFunction(() => {
      const color = window.getComputedStyle(document.body).backgroundColor;
      return document.styleSheets.length > 0 && color !== "rgba(0, 0, 0, 0)";
    });
    if (route.path === "/dashboard") {
      await page.locator("canvas").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    }
    await page.screenshot({
      path: `test-results/review/${testInfo.project.name}-${route.slug}.png`,
      fullPage: true
    });
  });
}
