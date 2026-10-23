import { test, expect } from "@playwright/test";
import { clickMap, coneRows, openConsole, setMode } from "./console.mjs";

async function createInSheet(page, name) {
  const input = page.getByTestId("inspector").getByRole("textbox", { name: "New course name" });
  await input.fill(name);
  await input.press("Enter");
  await expect(page.getByTestId("course-switcher")).toContainText(name);
}

test("the bottom sheet creates a course and folds from its handle", async ({ page }) => {
  await openConsole(page);
  const sheet = page.getByTestId("inspector");
  await createInSheet(page, "Phone course");
  const open = (await sheet.boundingBox()).height;
  await page.getByTestId("sheet-handle").tap();
  await expect.poll(async () => (await sheet.boundingBox()).height).toBeLessThan(open - 100);
  await page.getByTestId("sheet-handle").tap();
  await expect.poll(async () => (await sheet.boundingBox()).height).toBe(open);
});

test("a map tool folds the sheet and keeps the cone sides in it", async ({ page }) => {
  await openConsole(page);
  const sheet = page.getByTestId("inspector");
  await createInSheet(page, "Phone course");
  const open = (await sheet.boundingBox()).height;
  await sheet.getByRole("button", { name: "Add cones", exact: true }).tap();
  await expect.poll(async () => (await sheet.boundingBox()).height).toBeLessThan(open);
  await expect(page.getByTestId("tool-bar")).toHaveCount(0);
  for (const side of ["Left side", "Center side", "Right side"]) {
    await expect(sheet.getByRole("radio", { name: side })).toBeInViewport({ ratio: 1 });
  }
  await sheet.getByRole("radio", { name: "Right side" }).tap();
  await expect(sheet.getByRole("radio", { name: "Right side" })).toBeChecked();
});

test("the header keeps the course name clear of the device badges", async ({ page }) => {
  await openConsole(page, { rover: true });
  await expect(page.getByTestId("estop")).toBeVisible();
  const trigger = page.getByTestId("course-switcher").getByRole("button").first();
  const name = await trigger.boundingBox();
  const badge = await page.getByTestId("device-rover").boundingBox();
  expect(name.x + name.width).toBeLessThanOrEqual(badge.x);
  expect(await trigger.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await setMode(page, "operate");
  await expect(page.getByTestId("operate-panel")).toBeVisible();
});

test("the mission builder opens below the E-stop", async ({ page }) => {
  await openConsole(page, { rover: true });
  const sheet = page.getByTestId("inspector");
  await createInSheet(page, "Phone course");
  await sheet.getByRole("button", { name: "Add cones", exact: true }).tap();
  for (const dx of [-60, 0, 60]) await clickMap(page, dx, -40);
  await expect(coneRows(page)).toHaveCount(3);
  await sheet.getByRole("button", { name: "Select", exact: true }).tap();
  await setMode(page, "operate");
  await page.getByTestId("sheet-handle").tap();
  await sheet.getByRole("button", { name: "Plan a mission" }).tap();
  const builder = page.getByRole("dialog", { name: "Edit mission route" });
  const estop = await page.getByTestId("estop").boundingBox();
  const close = builder.getByRole("button", { name: "Close" });
  expect((await close.boundingBox()).y).toBeGreaterThanOrEqual(estop.y + estop.height);
  await close.tap();
  await expect(builder).toBeHidden();
});
