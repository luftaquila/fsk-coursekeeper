import { test, expect } from "@playwright/test";
import { addCones, clickMap, coneRows, createCourse, dragMap, openConsole, selectTool, toolButton } from "./console.mjs";

test.beforeEach(async ({ page }) => {
  await openConsole(page);
  await createCourse(page, "Autocross");
});

test("map taps add cones only with the Add tool", async ({ page }) => {
  await clickMap(page, -100, 0);
  await expect(coneRows(page)).toHaveCount(0);
  await addCones(page, [[-100, -40], [0, -40], [100, -40]]);
  await page.keyboard.press("Escape");
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "true");
  await clickMap(page, -100, 60);
  await expect(coneRows(page)).toHaveCount(3);
});

test("a cone tapped with the Select tool is deleted by key and restored by undo", async ({ page }) => {
  await addCones(page, [[-60, 0], [60, 0]]);
  await page.keyboard.press("Escape");
  await clickMap(page, -60, 0);
  await expect(page.getByTestId("selection")).toContainText("Left #1");
  await page.keyboard.press("Delete");
  await expect(coneRows(page)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(coneRows(page)).toHaveCount(2);
});

test("a cone deleted from the list comes back with the Undo button", async ({ page }) => {
  await addCones(page, [[-60, 0], [60, 0]]);
  await coneRows(page).first().getByRole("button", { name: /^Delete / }).click();
  await expect(coneRows(page)).toHaveCount(1);
  await toolButton(page, "Undo").click();
  await expect(coneRows(page)).toHaveCount(2);
});

test("the ruler measures the distance between two taps", async ({ page }) => {
  await selectTool(page, "Measure distance");
  await clickMap(page, -100, 0);
  await clickMap(page, 100, 0);
  await expect(page.getByTestId("tool-bar")).toContainText(/\d+\.\d{2} m/);
});

test("area select picks the cones inside the box", async ({ page }) => {
  await addCones(page, [[-120, 0], [-60, 0], [120, 0]]);
  await selectTool(page, "Select area");
  await dragMap(page, [-150, -30], [-30, 30]);
  await expect(page.getByTestId("selection")).toContainText("2 cones selected");
});
