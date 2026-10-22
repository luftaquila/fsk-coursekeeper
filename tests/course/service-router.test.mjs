import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createCourseService, initializeCourseSchema } from "../../course/service/index.mjs";
import { createCourseRouter } from "../../course/service/router.mjs";

const Database = createRequire(import.meta.url)("better-sqlite3");

function localCourseHost() {
  const db = new Database(":memory:");
  initializeCourseSchema(db);
  return { db, handle: createCourseRouter(createCourseService(db), { actor: "local" }) };
}

test("the in-process router serves the course REST surface with the service's events", () => {
  const { db, handle } = localCourseHost();
  try {
    const created = handle("POST", "/api/courses", { name: "Autocross" });
    assert.equal(created.status, 201);
    const courseId = created.json.id;
    assert.deepEqual(created.events.map(([event, payload]) => [event, payload.type]), [["courses", "create"]]);

    const cone = handle("POST", `/api/courses/${courseId}/cones`, { lat: 35.1, lng: 126.5, alt: 12, side: "left" });
    assert.equal(cone.status, 201);
    assert.equal(cone.events[0][1].cones.length, 1);

    const duplicate = handle("POST", "/api/courses", { name: "autocross " });
    assert.equal(duplicate.status, 201, "course names are case-sensitive after trimming");
    assert.equal(handle("POST", "/api/courses", { name: "Autocross" }).status, 400);

    const exported = handle("GET", `/api/courses/${courseId}/export?download=1`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers["Content-Disposition"], /Autocross\.json/);
    assert.deepEqual(exported.json.cones, [{ lat: 35.1, lng: 126.5, alt: 12, side: "left" }]);

    const snapshot = handle("POST", `/api/courses/${courseId}/snapshots`, { reason: "before edit" });
    assert.equal(snapshot.status, 201);
    assert.equal(db.prepare("SELECT actor FROM course_snapshot").get().actor, "local");

    const items = [{ cone_id: cone.json.id, lat: 35.1, lng: 126.5, alt: 12, side: "left" }];
    const preset = handle("POST", `/api/courses/${courseId}/mission-presets`, { name: "Lap", items });
    assert.equal(preset.status, 201);
    assert.match(preset.json.preset_revision, /^[a-f0-9]{64}$/);
    const stale = handle("DELETE", `/api/courses/${courseId}/mission-presets/${preset.json.id}`, { expected_preset_revision: "old" });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.reason, "preset_revision_mismatch");

    const missing = handle("PATCH", "/api/cones/999", { side: "right" });
    assert.deepEqual([missing.status, missing.text, missing.events], [404, "Cone not found.", []]);
    assert.equal(handle("GET", "/api/unknown").status, 404);

    const removed = handle("DELETE", `/api/courses/${courseId}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.text, "");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cone").get().n, 0);
  } finally {
    db.close();
  }
});
