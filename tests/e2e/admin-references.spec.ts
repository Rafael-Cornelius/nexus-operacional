import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard geral" })).toBeVisible();
}

test("manages equipment and shifts with isolated preview data", async ({ page }) => {
  await login(page);

  await page.goto("/equipamentos");
  await expect(page.getByRole("heading", { name: "Equipamentos", exact: true })).toBeVisible();
  await expect(page.getByText("equipamentos demonstrativos carregados localmente")).toBeVisible();
  await page.getByLabel("Linha de produção").selectOption("11111111-1111-4111-8111-111111111111");
  await page.getByLabel("Código").fill("EQ-TESTE");
  await page.getByLabel("Nome").fill("Equipamento de teste");
  await page.getByLabel("Tipo").fill("Teste");
  await page.getByRole("button", { name: "Criar equipamento" }).click();
  let equipmentRow = page.getByRole("row").filter({ hasText: "EQ-TESTE" });
  await expect(equipmentRow).toContainText("Equipamento de teste");
  await equipmentRow.getByRole("button", { name: "Editar" }).click();
  await page.getByLabel("Nome").fill("Equipamento atualizado");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  equipmentRow = page.getByRole("row").filter({ hasText: "EQ-TESTE" });
  await expect(equipmentRow).toContainText("Equipamento atualizado");
  page.once("dialog", (dialog) => dialog.accept());
  await equipmentRow.getByRole("button", { name: "Desativar" }).click();
  await expect(page.getByRole("row").filter({ hasText: "EQ-TESTE" })).toHaveCount(0);

  await page.goto("/turnos");
  await expect(page.getByRole("heading", { name: "Turnos", exact: true })).toBeVisible();
  await expect(page.getByText("turnos demonstrativos carregados localmente")).toBeVisible();
  await page.getByLabel("Código").fill("T3");
  await page.getByLabel("Nome").fill("Turno de teste");
  await page.getByLabel("Início").fill("22:00");
  await page.getByLabel("Fim").fill("06:00");
  await page.getByRole("button", { name: "Criar turno" }).click();
  let shiftRow = page.getByRole("row").filter({ hasText: "T3" });
  await expect(shiftRow).toContainText("Turno de teste");
  await shiftRow.getByRole("button", { name: "Editar" }).click();
  await page.getByLabel("Nome").fill("Turno noturno atualizado");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  shiftRow = page.getByRole("row").filter({ hasText: "T3" });
  await expect(shiftRow).toContainText("Turno noturno atualizado");
  page.once("dialog", (dialog) => dialog.accept());
  await shiftRow.getByRole("button", { name: "Desativar" }).click();
  await expect(page.getByRole("row").filter({ hasText: "T3" })).toHaveCount(0);
});
