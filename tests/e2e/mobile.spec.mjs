import { test, expect } from "@playwright/test";
import { createCourse, openConsole } from "./console.mjs";

test("the bottom sheet opens from its handle and holds the course list", async ({ page }) => {
  await openConsole(page);
  const sheet = page.locator(".inspector");
  const collapsed = (await sheet.boundingBox()).height;
  await page.locator(".sheet-handle").tap();
  await expect.poll(async () => (await sheet.boundingBox()).height).toBeGreaterThan(collapsed + 100);
  await createCourse(page, "Phone course");
});
