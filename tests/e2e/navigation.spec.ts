import { expect, test } from "@playwright/test";

test("opens the Nexus command center", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "NEXUS OPERACIONAL" })).toBeVisible();
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard geral" })).toBeVisible();
  await expect(page.getByText("Preview ao vivo")).toBeVisible();
  await expect(page.locator("main")).not.toHaveCSS("background-color", "rgb(0, 0, 0)");
});
