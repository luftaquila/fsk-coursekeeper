import { expect } from "@playwright/test";

// Page helpers shared by the console specs.

const SETTINGS_KEY = "fsk-coursekeeper.settings";

// Opens the standalone console with the simulated devices configured. Every
// browser context has its own course storage, so each test starts empty.
export async function openConsole(page, { rover = false, gps = false } = {}) {
  const devices = [];
  if (rover) devices.push({ id: "rover", kind: "rover", label: "Rover", url: process.env.E2E_ROVER_URL });
  if (gps) devices.push({ id: "gps", kind: "gps", label: "GPS unit", url: process.env.E2E_GPS_URL });
  // Map tiles and web fonts are not part of what is tested.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value),
    [SETTINGS_KEY, JSON.stringify({ devices, vworldKey: "" })]);
  await page.goto("/");
  await expect(page.locator("#map")).toBeVisible();
}

// A point on the map, offset in pixels from the centre of the map element.
export async function mapPoint(page, dx = 0, dy = 0) {
  const box = await page.locator("#map").boundingBox();
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

export async function clickMap(page, dx = 0, dy = 0) {
  const { x, y } = await mapPoint(page, dx, dy);
  await page.mouse.click(x, y);
}

export async function createCourse(page, name) {
  const input = page.locator('input[placeholder="New course name"]');
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator(".course-item.active")).toContainText(name);
}

export const coneRows = (page) => page.locator(".cone-item");

export async function unlockEditing(page) {
  const lock = page.locator(".fab-lock");
  if (await lock.evaluate((el) => el.classList.contains("locked"))) await lock.click();
  await expect(lock).not.toHaveClass(/locked/);
}

export async function addCones(page, points) {
  const before = await coneRows(page).count();
  for (const [dx, dy] of points) await clickMap(page, dx, dy);
  await expect(coneRows(page)).toHaveCount(before + points.length);
}

export async function openTab(page, title) {
  await page.locator(`.rail-btn[title="${title}"]`).click();
}
