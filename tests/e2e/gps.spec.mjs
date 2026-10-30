import { test, expect } from "@playwright/test";
import { openConsole, openDevicePanel } from "./console.mjs";

test("a survey point is added and surveyed on the GPS unit", async ({ page }) => {
  await openConsole(page, { rover: true, gps: true });
  const panel = await openDevicePanel(page, "gps");
  await expect(panel).toContainText("ONLINE");
  const name = `Base ${Date.now()}`;
  await panel.getByPlaceholder("Survey point name").fill(name);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  const point = panel.getByTestId("survey-point").filter({ hasText: name });
  await expect(point).toContainText("Not surveyed");
  await point.getByRole("button", { name: "Survey", exact: true }).click();
  await expect(point).toContainText("Surveyed", { timeout: 10000 });
});
