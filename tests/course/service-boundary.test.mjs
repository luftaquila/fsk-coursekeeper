import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The course service runs unchanged on better-sqlite3 (FSK) and on SQLite WASM
// in a browser worker, so it may import only its own modules: no host code, no
// Node built-ins, and no Node-only globals.
const SERVICE_DIR = path.resolve("course/service");

test("the course service imports only its own modules and no Node-only APIs", () => {
  for (const file of fs.readdirSync(SERVICE_DIR).filter((name) => name.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(SERVICE_DIR, file), "utf8");
    for (const [, specifier] of source.matchAll(/\b(?:import|export)\s[^"']*?from\s+["']([^"']+)["']/g)) {
      assert.match(specifier, /^\.\/[\w-]+\.mjs$/, `${file} imports ${specifier}`);
    }
    assert.doesNotMatch(source, /\brequire\(|\bprocess\.|\bBuffer\.|__dirname/, `${file} uses a Node-only API`);
  }
});
