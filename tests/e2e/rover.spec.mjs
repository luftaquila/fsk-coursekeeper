import { test, expect } from "@playwright/test";
import { addCones, clickMap, coneRows, createCourse, openConsole, openDrawer, setMode } from "./console.mjs";

const estop = (page) => page.getByTestId("estop");

test.beforeEach(async ({ page }) => {
  await openConsole(page, { rover: true });
});

// The simulated rover outlives the page; leave it released for the next test.
test.afterEach(async ({ page }) => {
  if (await estop(page).getAttribute("aria-label") !== "Release the E-stop") return;
  await page.keyboard.press("Escape");
  await estop(page).click();
  await expect(estop(page)).toHaveAccessibleName("Emergency stop");
});

test("the connected rover shows its fix and the E-stop", async ({ page }) => {
  await expect(page.getByTestId("device-rover")).toContainText("RTK fixed");
  await expect(estop(page)).toHaveAccessibleName("Emergency stop");
});

test("the E-stop latches and releases", async ({ page }) => {
  await estop(page).click();
  await expect(estop(page)).toHaveAccessibleName("Release the E-stop");
  await expect(estop(page)).toBeEnabled();
  await estop(page).click();
  await expect(estop(page)).toHaveAccessibleName("Emergency stop");
});

test("the E-stop stays clickable over an open dialog and its toast", async ({ page }) => {
  const drawer = await openDrawer(page, "rover");
  await drawer.getByRole("button", { name: "Calibrate voltage" }).click();
  const dialog = page.getByRole("dialog", { name: "Battery voltage calibration" });
  await dialog.getByRole("spinbutton").fill("5");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("The measured value must be a number from 15 to 32 V.")).toBeVisible();
  await estop(page).click();
  await expect(estop(page)).toHaveAccessibleName("Release the E-stop");
  await expect(dialog).toBeVisible();
});

test("a cone is captured at the rover position", async ({ page }) => {
  await createCourse(page, "Capture");
  await page.getByRole("button", { name: "Capture a cone at the device position" }).click();
  await expect(coneRows(page)).toHaveCount(1);
});

test("a planned route survives map taps and opens the preflight check", async ({ page }) => {
  await createCourse(page, "Skidpad");
  await addCones(page, [[-60, -30], [0, -30], [60, -30]]);
  await setMode(page, "operate");
  const mission = page.getByTestId("mission");
  await mission.getByRole("button", { name: "Plan a mission" }).click();
  await page.getByRole("dialog", { name: "Edit mission route" }).getByRole("button", { name: "Apply route" }).click();
  await clickMap(page, 0, 80);
  const run = mission.getByRole("button", { name: "Check and run" });
  await expect(run).toBeVisible();
  await run.click();
  await expect(page.getByRole("heading", { name: "Preflight check" })).toBeVisible();
  await estop(page).click();
  await expect(estop(page)).toHaveAccessibleName("Release the E-stop");
});
