import { test, expect } from "@playwright/test";
import { openConsole, openDrawer } from "./console.mjs";

test("a survey point is added and surveyed on the GPS unit", async ({ page }) => {
  await openConsole(page, { rover: true, gps: true });
  const drawer = await openDrawer(page, "gps");
  await expect(drawer).toContainText("ONLINE");
  const name = `Base ${Date.now()}`;
  await drawer.getByPlaceholder("Survey point name").fill(name);
  await drawer.getByRole("button", { name: "Add", exact: true }).click();
  const point = drawer.getByTestId("survey-point").filter({ hasText: name });
  await expect(point).toContainText("Not surveyed");
  await point.getByRole("button", { name: "Survey", exact: true }).click();
  await expect(point).toContainText("Surveyed", { timeout: 10000 });
});
