import { test, expect } from "@playwright/test";
import { openConsole } from "./console.mjs";

// Saved settings apply in place: the console reconnects without a page load,
// which would also bring back the empty settings openConsole starts with.
test("a rover added in Settings connects without reloading the page", async ({ page }) => {
  await openConsole(page);
  const badge = page.getByTestId("device-rover");
  await expect(badge).toContainText("Not set up");
  await page.evaluate(() => { window.sameDocument = true; });

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "+ Rover" }).click();
  await page.getByRole("textbox", { name: "Device host" }).fill(process.env.E2E_ROVER_URL);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(badge).toContainText("RTK fixed");
  expect(await page.evaluate(() => window.sameDocument)).toBe(true);
});
