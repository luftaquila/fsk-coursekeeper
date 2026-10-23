import { test, expect } from "@playwright/test";
import { openConsole, openTab } from "./console.mjs";

test("a survey point is added and surveyed on the GPS unit", async ({ page }) => {
  await openConsole(page, { rover: true, gps: true });
  await openTab(page, "GPS");
  await expect(page.locator(".gps-detail:visible").first()).toContainText("ONLINE");
  const name = `Base ${Date.now()}`;
  await page.getByPlaceholder("Survey point name").fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const card = page.locator(".gps-point-card").filter({ hasText: name });
  await expect(card).toContainText("Not surveyed");
  await card.getByRole("button", { name: "Survey", exact: true }).click();
  await expect(card).toContainText("Surveyed", { timeout: 10000 });
});
