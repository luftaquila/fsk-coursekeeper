import { test, expect } from "@playwright/test";
import { addCones, clickMap, coneRows, createCourse, mapPoint, openConsole, unlockEditing } from "./console.mjs";

test.beforeEach(async ({ page }) => {
  await openConsole(page);
  await createCourse(page, "Autocross");
});

test("map taps add cones only once editing is unlocked", async ({ page }) => {
  await clickMap(page, -100, 0);
  await expect(coneRows(page)).toHaveCount(0);
  await unlockEditing(page);
  await addCones(page, [[-100, -40], [0, -40], [100, -40]]);
});

test("a cone deleted from the list comes back with undo", async ({ page }) => {
  await unlockEditing(page);
  await addCones(page, [[-60, 0], [60, 0]]);
  await coneRows(page).first().locator(".del-btn").click();
  await expect(coneRows(page)).toHaveCount(1);
  await page.locator(".fab-undo").click();
  await expect(coneRows(page)).toHaveCount(2);
});

test("the ruler measures the distance between two taps", async ({ page }) => {
  await page.getByRole("button", { name: "Measure distance" }).click();
  await clickMap(page, -100, 0);
  await clickMap(page, 100, 0);
  await expect(page.locator(".measure-overlay .measure-result")).toHaveText(/\d+\.\d{2} m/);
});

test("area select picks the cones inside the box", async ({ page }) => {
  await unlockEditing(page);
  await addCones(page, [[-120, 0], [-60, 0], [120, 0]]);
  await page.getByRole("button", { name: "Area select mode" }).click();
  const from = await mapPoint(page, -150, -30);
  const to = await mapPoint(page, -30, 30);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".inspector-group.selected .group-title")).toHaveText("2 selected");
});
