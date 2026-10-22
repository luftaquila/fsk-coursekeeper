import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The console is shared by every host, so it may import only package modules
// and its declared third-party packages; host specifics arrive through the host.
const LIB_DIR = path.resolve("course");
const CONSOLE_DIR = path.join(LIB_DIR, "console");
const PACKAGES = new Set(["vue", "leaflet", "leaflet-rotate", "jszip", "vue-sonner"]);

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(mjs|js|vue|css)$/.test(entry.name) ? [full] : [];
  });
}

test("the console imports only package modules and declared packages", () => {
  for (const file of sources(CONSOLE_DIR)) {
    const source = fs.readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(/\bimport\s[^"']*?from\s+["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/@import\s+["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);
        assert.ok(resolved.startsWith(LIB_DIR + path.sep), `${path.relative(LIB_DIR, file)} imports ${specifier}`);
      } else {
        assert.ok(PACKAGES.has(specifier.split("/")[0]), `${path.relative(LIB_DIR, file)} imports ${specifier}`);
      }
    }
    assert.doesNotMatch(source, /window\.__[A-Z_]+__/, `${path.relative(LIB_DIR, file)} reads a host global`);
  }
});
