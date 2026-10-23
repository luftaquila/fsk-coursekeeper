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
  await expect(page.getByTestId("map")).toBeVisible();
}

// A point on the map, offset in pixels from the centre of the map element.
export async function mapPoint(page, dx = 0, dy = 0) {
  const box = await page.getByTestId("map").boundingBox();
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

export async function clickMap(page, dx = 0, dy = 0) {
  const { x, y } = await mapPoint(page, dx, dy);
  await page.mouse.click(x, y);
}

export async function dragMap(page, from, to) {
  const a = await mapPoint(page, ...from);
  const b = await mapPoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}

// Creates a course from the course switcher in the header.
export async function createCourse(page, name) {
  const switcher = page.getByTestId("course-switcher");
  await switcher.getByRole("button", { expanded: false }).click();
  const input = switcher.getByRole("textbox", { name: "New course name" });
  await input.fill(name);
  await input.press("Enter");
  await expect(switcher.getByRole("button").first()).toContainText(name);
}

export const coneRows = (page) => page.getByTestId("cone-row");

export const toolButton = (page, label) => page.getByTestId("palette").getByRole("button", { name: label, exact: true });

export async function selectTool(page, label) {
  const button = toolButton(page, label);
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

// Adds cones with the Add tool, which stays active afterwards.
export async function addCones(page, points) {
  await selectTool(page, "Add cones");
  const before = await coneRows(page).count();
  for (const [dx, dy] of points) await clickMap(page, dx, dy);
  await expect(coneRows(page)).toHaveCount(before + points.length);
}

export async function setMode(page, mode) {
  const tab = page.getByTestId(`mode-${mode}`);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-pressed", "true");
}

export async function openDrawer(page, kind) {
  await page.getByTestId(`device-${kind}`).click();
  const drawer = page.getByTestId("device-drawer");
  await expect(drawer).toBeVisible();
  return drawer;
}
