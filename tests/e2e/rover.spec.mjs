import { test, expect } from "@playwright/test";
import { addCones, coneRows, createCourse, openConsole, openTab, unlockEditing } from "./console.mjs";

test.beforeEach(async ({ page }) => {
  await openConsole(page, { rover: true });
});

test("the connected rover shows its fix and the E-stop", async ({ page }) => {
  await expect(page.locator(".chip").filter({ hasText: "RTK FIXED" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Emergency stop/ })).toBeVisible();
});

test("the E-stop latches and releases", async ({ page }) => {
  await page.getByRole("button", { name: /Emergency stop/ }).click();
  const release = page.getByRole("button", { name: /Release E-stop/ });
  await expect(release).toBeEnabled();
  await release.click();
  await expect(page.getByRole("button", { name: /Emergency stop/ })).toBeVisible();
});

test("a cone is captured at the rover position", async ({ page }) => {
  await createCourse(page, "Capture");
  await page.getByRole("button", { name: "Add cone at the rover GPS position" }).click();
  await expect(coneRows(page)).toHaveCount(1);
});

test("a planned route opens the preflight check", async ({ page }) => {
  await createCourse(page, "Skidpad");
  await unlockEditing(page);
  await addCones(page, [[-60, -30], [0, -30], [60, -30]]);
  await openTab(page, "Rover");
  await page.getByRole("button", { name: "Plan route" }).click();
  await page.getByRole("dialog", { name: "Edit mission route" }).getByRole("button", { name: "Apply route" }).click();
  await page.getByRole("button", { name: "Run route" }).click();
  await expect(page.getByRole("heading", { name: "Preflight check" })).toBeVisible();
});
