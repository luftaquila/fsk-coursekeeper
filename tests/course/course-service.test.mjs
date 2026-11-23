import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createCourseService, initializeCourseSchema } from "../../course/service/index.mjs";
import { createCourseRouter } from "../../course/service/router.mjs";

const Database = createRequire(import.meta.url)("better-sqlite3");

// Course service rules through the shared REST surface, the way every host
// serves it. Host concerns (permissions, audit logs, publication) are tested by
// each host.
function courseHost(t) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  initializeCourseSchema(db);
  const service = createCourseService(db);
  return { db, service, handle: createCourseRouter(service, { actor: "local" }) };
}

function created(response) {
  assert.equal(response.status, 201, response.text);
  return response.json;
}

function seedCourse(handle, name, cones = []) {
  const course = created(handle("POST", "/api/courses", { name }));
  const coneIds = cones.map((cone) => created(handle("POST", `/api/courses/${course.id}/cones`, cone)).id);
  return { course, coneIds };
}

const LEFT = { lat: 37.5665, lng: 126.978, side: "left" };
const THREE_CONES = [
  { lat: 37.1, lng: 126.1, side: "left" },
  { lat: 37.2, lng: 126.2, side: "right" },
  { lat: 37.3, lng: 126.3, side: "center" },
];

test("course names are required and unique, and the list keeps creation order with cone counts", (t) => {
  const { handle } = courseHost(t);
  const first = created(handle("POST", "/api/courses", { name: "Autocross A" }));
  assert.equal(first.name, "Autocross A");
  assert.equal(handle("POST", "/api/courses", { name: "" }).status, 400);
  assert.equal(handle("POST", "/api/courses", { name: "Autocross A" }).status, 400);
  created(handle("POST", "/api/courses", { name: "Skidpad B" }));
  created(handle("POST", `/api/courses/${first.id}/cones`, LEFT));

  const list = handle("GET", "/api/courses");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((course) => [course.name, course.cone_count]), [["Autocross A", 1], ["Skidpad B", 0]]);
});

test("renaming validates the new name and the course", (t) => {
  const { handle } = courseHost(t);
  const { course: first } = seedCourse(handle, "Autocross A");
  const { course: second } = seedCourse(handle, "Skidpad B");
  const renamed = handle("PATCH", `/api/courses/${first.id}`, { name: "Autocross A-1" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.name, "Autocross A-1");
  assert.equal(handle("PATCH", `/api/courses/${first.id}`, { name: "  " }).status, 400);
  assert.equal(handle("PATCH", "/api/courses/999", { name: "test" }).status, 404);
  assert.equal(handle("PATCH", `/api/courses/${second.id}`, { name: "Autocross A-1" }).status, 400);
});

test("cones store coordinates, side, and an optional altitude", (t) => {
  const { handle } = courseHost(t);
  const { course } = seedCourse(handle, "Autocross");
  const left = created(handle("POST", `/api/courses/${course.id}/cones`, LEFT));
  assert.deepEqual([left.course_id, left.lat, left.lng, left.side, left.alt], [course.id, 37.5665, 126.978, "left", null]);
  const right = created(handle("POST", `/api/courses/${course.id}/cones`, { lat: 37.5666, lng: 126.9781, side: "right", alt: 42.5 }));
  assert.equal(right.alt, 42.5);
  created(handle("POST", `/api/courses/${course.id}/cones`, { lat: 37.5667, lng: 126.9782, side: "center" }));

  const list = handle("GET", `/api/courses/${course.id}/cones`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((cone) => cone.side), ["left", "right", "center"]);
  assert.equal(handle("GET", "/api/courses/999/cones").status, 404);
});

test("cone creation rejects invalid input and a missing course", (t) => {
  const { handle } = courseHost(t);
  const { course } = seedCourse(handle, "Autocross");
  for (const bad of [
    { lat: 91, lng: 126.978, side: "left" },
    { lat: 37.5, lng: 181, side: "left" },
    { lat: 37.5, lng: 126.9, side: "invalid" },
    { lat: 37.5, lng: 126.9, side: "left", alt: 999999 },
    { lat: 37.5, lng: 126.9, side: "left", alt: "high" },
  ]) {
    assert.equal(handle("POST", `/api/courses/${course.id}/cones`, bad).status, 400, JSON.stringify(bad));
  }
  assert.equal(handle("POST", "/api/courses/999/cones", LEFT).status, 404);
});

test("cone updates change only the given fields and validate them", (t) => {
  const { handle } = courseHost(t);
  const { coneIds: [coneId] } = seedCourse(handle, "Autocross", [LEFT]);
  const patch = (body) => handle("PATCH", `/api/cones/${coneId}`, body);

  const moved = patch({ lat: 37.567, lng: 126.9785 });
  assert.equal(moved.status, 200);
  assert.deepEqual([moved.json.lat, moved.json.lng], [37.567, 126.9785]);
  assert.equal(patch({ side: "right" }).json.side, "right");
  assert.equal(patch({ alt: 12.34 }).json.alt, 12.34);
  const latOnly = patch({ lat: 37.568 });
  assert.deepEqual([latOnly.json.lat, latOnly.json.alt], [37.568, 12.34], "a lat-only update keeps the altitude");

  for (const bad of [{ lat: -91 }, { alt: "high" }, { side: "invalid" }, {}]) {
    assert.equal(patch(bad).status, 400, JSON.stringify(bad));
  }
  assert.equal(handle("PATCH", "/api/cones/999", { lat: 37.5 }).status, 404);
});

test("a deleted cone is gone and cannot be deleted again", (t) => {
  const { handle } = courseHost(t);
  const { course, coneIds } = seedCourse(handle, "Autocross", [LEFT, { ...LEFT, side: "right" }]);
  assert.equal(handle("DELETE", `/api/cones/${coneIds[0]}`).status, 200);
  assert.deepEqual(handle("GET", `/api/courses/${course.id}/cones`).json.map((cone) => cone.id), [coneIds[1]]);
  assert.equal(handle("DELETE", `/api/cones/${coneIds[0]}`).status, 404);
});

test("route markers are reusable anchors visited in a stored order", (t) => {
  const { handle } = courseHost(t);
  const { course } = seedCourse(handle, "Skidpad");
  const { course: other } = seedCourse(handle, "Other");
  const route = () => handle("GET", `/api/courses/${course.id}/route`).json;
  const addMarker = (courseId, body) => created(handle("POST", `/api/courses/${courseId}/route/markers`, body)).id;
  assert.deepEqual(route(), { markers: [], steps: [] });

  const first = addMarker(course.id, { lat: 35.292, lng: 126.574, label: "Waist" });
  const second = addMarker(course.id, { lat: 35.293, lng: 126.575, label: "Left" });
  assert.equal(route().markers.length, 2);
  assert.deepEqual(route().steps, [], "adding a marker adds no visit");

  const steps = handle("PUT", `/api/courses/${course.id}/route/steps`, { steps: [first, second, first] });
  assert.equal(steps.status, 200);
  assert.deepEqual(steps.json.steps, [first, second, first]);

  const renamed = handle("PATCH", `/api/route/markers/${second}`, { label: "Left circle", lat: 35.2931 });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.label, "Left circle");

  const foreign = addMarker(other.id, { lat: 35.4, lng: 126.6, label: "Other" });
  assert.equal(handle("PUT", `/api/courses/${course.id}/route/steps`, { steps: [first, foreign] }).status, 400);
  assert.deepEqual(route().steps, [first, second, first], "a rejected order leaves the stored one");

  const exported = handle("GET", `/api/courses/${course.id}/export`).json;
  assert.deepEqual(exported.route_steps, [0, 1, 0], "export refers to markers by index");
  assert.deepEqual(exported.route_markers.map((marker) => marker.label), ["Waist", "Left circle"]);

  const removed = handle("DELETE", `/api/route/markers/${first}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.steps, [second], "deleting a marker removes all its visits");
  assert.deepEqual(removed.json.markers.map((marker) => marker.id), [second]);
});

test("route requests require an existing course and valid markers", (t) => {
  const { handle } = courseHost(t);
  const { course } = seedCourse(handle, "Skidpad");
  assert.equal(handle("GET", "/api/courses/999/route").status, 404);
  assert.equal(handle("POST", `/api/courses/${course.id}/route/markers`, { lat: 999, lng: 126.5, label: "bad" }).status, 400);
  assert.equal(handle("PUT", `/api/courses/${course.id}/route/steps`, { steps: ["not-an-id"] }).status, 400);
});

test("deleting a course removes everything that belongs to it and reports the counts", (t) => {
  const { db, service, handle } = courseHost(t);
  const { course, coneIds } = seedCourse(handle, "Autocross", [LEFT]);
  const marker = created(handle("POST", `/api/courses/${course.id}/route/markers`, { lat: 35.292, lng: 126.574 })).id;
  assert.equal(handle("PUT", `/api/courses/${course.id}/route/steps`, { steps: [marker, marker] }).status, 200);
  created(handle("POST", `/api/courses/${course.id}/memos`, { lat: 35, lng: 126, width: 2, height: 1 }));
  created(handle("POST", `/api/courses/${course.id}/snapshots`, {}));
  created(handle("POST", `/api/courses/${course.id}/mission-presets`, {
    name: "Lap", items: [{ cone_id: coneIds[0], ...LEFT, alt: null }],
  }));

  const result = service.deleteCourse(String(course.id));
  assert.equal(result.ok, true);
  assert.deepEqual(result.detail, {
    course_id: course.id,
    cascade: {
      cones: 1, memos: 1, route_markers: 1, route_steps: 2, snapshots: 1, mission_presets: 1, mission_preset_items: 1,
    },
  });
  for (const table of ["cone", "memo", "route_marker", "route_step", "course_snapshot", "mission_route_preset", "mission_route_preset_item"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(handle("GET", `/api/courses/${course.id}/cones`).status, 404);
  assert.equal(handle("DELETE", `/api/courses/${course.id}`).status, 404);
});

test("export carries cones with altitude, the travel direction, and the start cone by index", (t) => {
  const { handle } = courseHost(t);
  const { course, coneIds } = seedCourse(handle, "Export", [{ lat: 35, lng: 126, side: "left", alt: 88.8 }]);
  const exported = handle("GET", `/api/courses/${course.id}/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.json.name, "Export");
  assert.deepEqual(exported.json.cones, [{ lat: 35, lng: 126, alt: 88.8, side: "left" }]);
  assert.deepEqual([exported.json.reverse, exported.json.start_cone_index], [false, null]);

  assert.equal(handle("PATCH", `/api/courses/${course.id}/direction`, { reverse: true, start_cone_id: coneIds[0] }).status, 200);
  const directed = handle("GET", `/api/courses/${course.id}/export`).json;
  assert.deepEqual([directed.reverse, directed.start_cone_index], [true, 0], "cone ids change on import, so the start is an index");
  assert.equal(handle("GET", "/api/courses/999/export").status, 404);
});

test("import validates the file and creates the course with its cones", (t) => {
  const { handle } = courseHost(t);
  const imported = created(handle("POST", "/api/courses/import", {
    name: "Imported",
    cones: [{ lat: 35.3, lng: 126.3, side: "left", alt: 55.5 }, { lat: 35.4, lng: 126.4, side: "center" }],
  }));
  assert.equal(imported.name, "Imported");
  assert.deepEqual(
    handle("GET", `/api/courses/${imported.id}/cones`).json.map((cone) => [cone.side, cone.alt]),
    [["left", 55.5], ["center", null]],
  );

  for (const bad of [
    { name: "Imported", cones: [] },
    { name: "Bad cone", cones: [{ lat: 91, lng: 0, side: "left" }] },
    { name: "Bad altitude", cones: [{ lat: 35, lng: 126, side: "left", alt: "high" }] },
    { name: "Bad route", cones: [], route_markers: [{ lat: 91, lng: 126.1, label: "invalid" }], route_steps: [0] },
  ]) {
    assert.equal(handle("POST", "/api/courses/import", bad).status, 400, bad.name);
  }
});

test("import round-trips route markers with repeated visits", (t) => {
  const { handle } = courseHost(t);
  const course = created(handle("POST", "/api/courses/import", {
    name: "Guided",
    cones: [],
    route_markers: [{ lat: 35.1, lng: 126.1, label: "Waist" }, { lat: 35.2, lng: 126.2, label: "Outer" }],
    route_steps: [0, 1, 0, 1, 0],
  }));
  const route = handle("GET", `/api/courses/${course.id}/route`).json;
  const [a, b] = route.markers.map((marker) => marker.id);
  assert.deepEqual(route.steps, [a, b, a, b, a]);
  assert.deepEqual(handle("GET", `/api/courses/${course.id}/export`).json.route_steps, [0, 1, 0, 1, 0]);
});

test("import restores the travel direction and start cone and ignores an out-of-range start", (t) => {
  const { handle } = courseHost(t);
  const cones = [{ lat: 35.5, lng: 126.5, side: "left" }, { lat: 35.6, lng: 126.6, side: "right" }];
  const directed = created(handle("POST", "/api/courses/import", { name: "Directed", reverse: true, start_cone_index: 1, cones }));
  assert.equal(directed.reverse, 1);
  assert.equal(directed.start_cone_id, handle("GET", `/api/courses/${directed.id}/cones`).json[1].id);

  const plain = created(handle("POST", "/api/courses/import", { name: "Plain", cones }));
  assert.deepEqual([plain.reverse, plain.start_cone_id], [0, null]);
  const outOfRange = created(handle("POST", "/api/courses/import", { name: "Out of range", start_cone_index: 9, cones }));
  assert.equal(outOfRange.start_cone_id, null);
});

test("the travel direction and start cone are validated per course", (t) => {
  const { handle } = courseHost(t);
  const { course, coneIds: [coneId] } = seedCourse(handle, "Direction", [LEFT]);
  const { coneIds: [otherConeId] } = seedCourse(handle, "Other", [{ ...LEFT, side: "right" }]);
  const direction = (body) => handle("PATCH", `/api/courses/${course.id}/direction`, body);

  const listed = handle("GET", "/api/courses").json.find((entry) => entry.id === course.id);
  assert.deepEqual([listed.reverse, listed.start_cone_id], [0, null]);
  const reversed = direction({ reverse: true });
  assert.equal(reversed.status, 200);
  assert.equal(reversed.json.reverse, 1);
  assert.equal(direction({ reverse: false }).json.reverse, 0);
  assert.equal(direction({ start_cone_id: coneId }).json.start_cone_id, coneId);
  assert.equal(direction({ start_cone_id: null }).json.start_cone_id, null);
  const both = direction({ reverse: true, start_cone_id: coneId });
  assert.deepEqual([both.json.reverse, both.json.start_cone_id], [1, coneId]);

  for (const bad of [{ reverse: "yes" }, { start_cone_id: otherConeId }, { start_cone_id: "abc" }, {}]) {
    assert.equal(direction(bad).status, 400, JSON.stringify(bad));
  }
  assert.equal(handle("PATCH", "/api/courses/999999/direction", { reverse: true }).status, 404);
});

test("the start cone is cleared when its cone goes away", (t) => {
  const { handle } = courseHost(t);
  const { course, coneIds } = seedCourse(handle, "Start", THREE_CONES);
  const startOf = () => handle("GET", "/api/courses").json.find((entry) => entry.id === course.id).start_cone_id;
  const setStart = (coneId) => assert.equal(handle("PATCH", `/api/courses/${course.id}/direction`, { start_cone_id: coneId }).status, 200);

  setStart(coneIds[0]);
  handle("DELETE", `/api/cones/${coneIds[0]}`);
  assert.equal(startOf(), null);

  setStart(coneIds[1]);
  handle("DELETE", `/api/cones/${coneIds[2]}`);
  assert.equal(startOf(), coneIds[1], "deleting another cone keeps the start");

  const snapshot = created(handle("POST", `/api/courses/${course.id}/snapshots`, { reason: "test" }));
  assert.equal(handle("POST", `/api/courses/${course.id}/snapshots/${snapshot.id}/restore`).status, 200);
  assert.equal(startOf(), null, "restored cones get new ids");
});

test("deleting all cones reports the count and clears the start cone", (t) => {
  const { handle } = courseHost(t);
  const { course, coneIds } = seedCourse(handle, "Wipe", THREE_CONES);
  assert.equal(handle("PATCH", `/api/courses/${course.id}/direction`, { start_cone_id: coneIds[0] }).status, 200);

  const wiped = handle("DELETE", `/api/courses/${course.id}/cones`);
  assert.deepEqual([wiped.status, wiped.json.deleted], [200, 3]);
  assert.deepEqual(handle("GET", `/api/courses/${course.id}/cones`).json, []);
  assert.equal(handle("GET", "/api/courses").json.find((entry) => entry.id === course.id).start_cone_id, null);

  const again = handle("DELETE", `/api/courses/${course.id}/cones`);
  assert.deepEqual([again.status, again.json.deleted], [200, 0]);
  assert.equal(handle("DELETE", "/api/courses/999999/cones").status, 404);
});

test("snapshots record, restore, and delete a course's cones", (t) => {
  const { handle } = courseHost(t);
  const { course } = seedCourse(handle, "Snapshots", THREE_CONES.slice(0, 2));
  const list = () => handle("GET", `/api/courses/${course.id}/snapshots`).json.snapshots;

  const snapshotId = created(handle("POST", `/api/courses/${course.id}/snapshots`, { reason: "first" })).id;
  assert.deepEqual(list().map((snapshot) => [snapshot.reason, snapshot.cone_count]), [["first", 2]]);
  created(handle("POST", `/api/courses/${course.id}/cones`, LEFT));

  const restored = handle("POST", `/api/courses/${course.id}/snapshots/${snapshotId}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.json.cones.length, 2);
  assert.equal(list().length, 2, "restore first snapshots the cones it replaces");

  assert.equal(handle("DELETE", `/api/courses/${course.id}/snapshots/${snapshotId}`).status, 204);
  assert.deepEqual(list().map((snapshot) => snapshot.id).includes(snapshotId), false);
  assert.equal(list().length, 1);
});

test("snapshot requests reject an empty course and snapshots of another course", (t) => {
  const { handle } = courseHost(t);
  const { course } = seedCourse(handle, "Snapshots", [LEFT]);
  const { course: empty } = seedCourse(handle, "Empty");
  assert.equal(handle("POST", `/api/courses/${empty.id}/snapshots`, {}).status, 400);
  assert.equal(handle("POST", `/api/courses/${course.id}/snapshots/999999/restore`).status, 404);
  assert.equal(handle("DELETE", `/api/courses/${course.id}/snapshots/999999`).status, 404);
  const snapshotId = created(handle("POST", `/api/courses/${course.id}/snapshots`, {})).id;
  assert.equal(handle("DELETE", `/api/courses/${empty.id}/snapshots/${snapshotId}`).status, 404);
});

test("memos keep a sized, rotated note on the map", (t) => {
  const { handle } = courseHost(t);
  const { course } = seedCourse(handle, "Memos");
  const addMemo = (body) => created(handle("POST", `/api/courses/${course.id}/memos`, body));
  const listMemos = () => handle("GET", `/api/courses/${course.id}/memos`).json;

  const memo = addMemo({ lat: 37.5, lng: 126.9, width: 25, height: 12, content: "Slalom" });
  assert.deepEqual(
    [memo.course_id, memo.lat, memo.lng, memo.width, memo.height, memo.rotation, memo.content],
    [course.id, 37.5, 126.9, 25, 12, 0, "Slalom"],
  );
  assert.equal(addMemo({ lat: 37.51, lng: 126.91, width: 10, height: 10 }).content, "");
  assert.equal(addMemo({ lat: 37.5, lng: 126.9, width: 10, height: 10, rotation: 45 }).rotation, 45);
  assert.deepEqual(listMemos().map((entry) => entry.content), ["Slalom", "", ""]);

  const patch = (body) => handle("PATCH", `/api/memos/${memo.id}`, body);
  const moved = patch({ lat: 37.6, lng: 127.0 });
  assert.deepEqual([moved.status, moved.json.lat, moved.json.lng], [200, 37.6, 127]);
  const resized = patch({ width: 40, height: 30 });
  assert.deepEqual([resized.json.width, resized.json.height], [40, 30]);
  assert.equal(patch({ content: "Edited" }).json.content, "Edited");
  assert.equal(patch({ rotation: 405 }).json.rotation, 45, "rotation is normalized to [0, 360)");

  assert.equal(handle("DELETE", `/api/memos/${memo.id}`).status, 200);
  assert.equal(listMemos().some((entry) => entry.id === memo.id), false);
  assert.equal(handle("DELETE", `/api/memos/${memo.id}`).status, 404);
});

test("memo requests validate coordinates, size, rotation, and content", (t) => {
  const { handle } = courseHost(t);
  const { course } = seedCourse(handle, "Memos");
  const base = { lat: 37.5, lng: 126.9, width: 10, height: 10 };
  for (const bad of [
    { lat: 91 }, { width: 0 }, { height: -5 }, { width: "big" }, { height: 200000 },
    { rotation: "sideways" }, { content: "x".repeat(5001) },
  ]) {
    assert.equal(handle("POST", `/api/courses/${course.id}/memos`, { ...base, ...bad }).status, 400, Object.keys(bad)[0]);
  }
  assert.equal(handle("POST", "/api/courses/999999/memos", base).status, 404);

  const memo = created(handle("POST", `/api/courses/${course.id}/memos`, base));
  assert.equal(handle("PATCH", `/api/memos/${memo.id}`, {}).status, 400);
  assert.equal(handle("PATCH", `/api/memos/${memo.id}`, { width: -1 }).status, 400);
  assert.equal(handle("PATCH", "/api/memos/999999", { content: "x" }).status, 404);
});

test("memos round-trip through export and import", (t) => {
  const { handle } = courseHost(t);
  const { course } = seedCourse(handle, "Memo source", [{ lat: 35, lng: 126, side: "left" }]);
  created(handle("POST", `/api/courses/${course.id}/memos`, { lat: 35.1, lng: 126.1, width: 20, height: 8, rotation: 30, content: "Label" }));

  const exported = handle("GET", `/api/courses/${course.id}/export`).json;
  const copy = created(handle("POST", "/api/courses/import", { ...exported, name: "Memo copy" }));
  const memos = handle("GET", `/api/courses/${copy.id}/memos`).json;
  assert.deepEqual(
    memos.map((memo) => [memo.content, memo.rotation, memo.width, memo.height]),
    [["Label", 30, 20, 8]],
  );
});
