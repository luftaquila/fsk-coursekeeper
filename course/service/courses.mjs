import { changed, fail, isUniqueViolation, ok, parseId, SQL_NOW } from "./result.mjs";
import {
  validateAltitude,
  validateCoordinate,
  validateCourseName,
  validateMemoContent,
  validateMemoDimension,
  validateMemoRotation,
  validateRouteMarkerLabel,
  validateSide,
} from "./validation.mjs";

export const MESSAGES = {
  invalidCourseId: "Invalid course ID.",
  courseNotFound: "Course not found.",
  duplicateCourseName: "A course with this name already exists.",
  nothingToUpdate: "Nothing to update.",
};

// Resolves a course path parameter; returns { id, course } or { failure }.
export function findCourse(reads, rawId) {
  const id = parseId(rawId);
  if (id == null) return { failure: fail(400, MESSAGES.invalidCourseId) };
  const course = reads.getCourse(id);
  if (!course) return { failure: fail(404, MESSAGES.courseNotFound, { detail: { course_id: id } }) };
  return { id, course };
}

export function createCourseOperations(db, reads) {
  const coursesEvent = (type, extra) => ["courses", { type, ...extra, courses: reads.listCourses() }];

  function listCourses() {
    return ok(reads.listCourses());
  }

  function createCourse(body = {}) {
    const name = validateCourseName(body.name);
    if (!name.valid) return fail(400, name.error, { subject: body.name ?? null });
    try {
      db.prepare(`INSERT INTO course (name, created_at, updated_at) VALUES (?, ${SQL_NOW}, ${SQL_NOW})`).run(name.value);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return fail(400, MESSAGES.duplicateCourseName, { subject: name.value, detail: { error: error.message } });
    }
    const course = db.prepare("SELECT * FROM course WHERE id = last_insert_rowid()").get();
    return changed(course, {
      status: 201,
      subject: name.value,
      events: [coursesEvent("create", { course })],
    });
  }

  function renameCourse(rawId, body = {}) {
    const { id, course, failure } = findCourse(reads, rawId);
    if (failure) return failure;
    const name = validateCourseName(body.name);
    if (!name.valid) return fail(400, name.error, { subject: course.name });
    try {
      db.prepare(`UPDATE course SET name = ?, updated_at = ${SQL_NOW} WHERE id = ?`).run(name.value, id);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return fail(400, MESSAGES.duplicateCourseName, { subject: course.name, detail: { error: error.message } });
    }
    const updated = reads.getCourse(id);
    return changed(updated, {
      subject: course.name,
      detail: { before: course.name, after: name.value },
      events: [coursesEvent("rename", { course: updated })],
    });
  }

  // Stores the shared travel direction and start cone; only the fields present
  // in the body change. start_cone_id must belong to this course, or be null to
  // return to the automatic start gate.
  function setCourseDirection(rawId, body = {}) {
    const { id, course, failure } = findCourse(reads, rawId);
    if (failure) return failure;
    const sets = [];
    const params = [];
    const detail = {};
    if ("reverse" in body) {
      if (typeof body.reverse !== "boolean") {
        return fail(400, "Travel direction (reverse) must be true or false.", { subject: course.name });
      }
      sets.push("reverse = ?");
      params.push(body.reverse ? 1 : 0);
      detail.reverse = body.reverse;
    }
    if ("start_cone_id" in body) {
      const startConeId = body.start_cone_id;
      if (startConeId !== null) {
        if (!Number.isInteger(startConeId)) return fail(400, "Invalid start cone ID.", { subject: course.name });
        const cone = reads.getCone(startConeId);
        if (!cone || cone.course_id !== id) {
          return fail(400, "The start cone does not belong to this course.", { subject: course.name });
        }
      }
      sets.push("start_cone_id = ?");
      params.push(startConeId);
      detail.start_cone_id = startConeId;
    }
    if (sets.length === 0) return fail(400, MESSAGES.nothingToUpdate, { subject: course.name });

    db.prepare(`UPDATE course SET ${sets.join(", ")}, updated_at = ${SQL_NOW} WHERE id = ?`).run(...params, id);
    const updated = reads.getCourse(id);
    // The course was deleted between the existence check and the UPDATE.
    if (!updated) {
      return fail(404, MESSAGES.courseNotFound, {
        subject: course.name,
        detail: { error: "course removed mid-update", ...detail },
      });
    }
    return changed(updated, {
      subject: course.name,
      detail,
      events: [coursesEvent("direction", { course: updated })],
    });
  }

  function exportCourse(rawId) {
    const { id, course, failure } = findCourse(reads, rawId);
    if (failure) return failure;
    const cones = reads.getCones(id);
    // Cone ids are reassigned on import, so the start cone travels as its index.
    const startIndex = course.start_cone_id != null ? cones.findIndex((c) => c.id === course.start_cone_id) : -1;
    const route = reads.getRoute(id);
    const markerIndex = new Map(route.markers.map((marker, index) => [marker.id, index]));
    const data = {
      name: course.name,
      reverse: !!course.reverse,
      start_cone_index: startIndex >= 0 ? startIndex : null,
      cones: cones.map((c) => ({ lat: c.lat, lng: c.lng, alt: c.alt, side: c.side })),
      memos: reads.getMemos(id).map((m) => ({
        lat: m.lat,
        lng: m.lng,
        width: m.width,
        height: m.height,
        rotation: m.rotation,
        content: m.content,
      })),
      route_markers: route.markers.map((marker) => ({ lat: marker.lat, lng: marker.lng, label: marker.label })),
      route_steps: route.steps.map((markerId) => markerIndex.get(markerId)),
    };
    const result = changed(data, {
      subject: course.name,
      detail: {
        cone_count: cones.length,
        route_marker_count: route.markers.length,
        route_step_count: route.steps.length,
      },
    });
    result.filename = `${course.name}.json`;
    return result;
  }

  function validateImport(body) {
    const { cones } = body;
    if (!Array.isArray(cones)) return "Invalid cone data.";
    for (const cone of cones) {
      for (const check of [validateCoordinate(cone.lat, cone.lng), validateSide(cone.side), validateAltitude(cone.alt)]) {
        if (!check.valid) return check.error;
      }
    }
    // Memos are optional; older files have none.
    const memos = Array.isArray(body.memos) ? body.memos : [];
    for (const memo of memos) {
      for (const check of [
        validateCoordinate(memo.lat, memo.lng),
        validateMemoDimension(memo.width, "width"),
        validateMemoDimension(memo.height, "height"),
        validateMemoRotation(memo.rotation),
        validateMemoContent(memo.content),
      ]) {
        if (!check.valid) return check.error;
      }
    }
    const markers = body.route_markers === undefined ? [] : body.route_markers;
    const steps = body.route_steps === undefined ? [] : body.route_steps;
    if (!Array.isArray(markers) || !Array.isArray(steps) || markers.length > 200 || steps.length > 500) {
      return "Invalid route marker data.";
    }
    for (const marker of markers) {
      for (const check of [validateCoordinate(marker.lat, marker.lng), validateRouteMarkerLabel(marker.label)]) {
        if (!check.valid) return check.error;
      }
    }
    if (steps.some((index) => !Number.isInteger(index) || index < 0 || index >= markers.length)) {
      return "The route order references a marker that does not exist.";
    }
    return null;
  }

  function importCourse(body = {}) {
    const name = validateCourseName(body.name);
    if (!name.valid) return fail(400, name.error, { subject: body.name ?? null });
    const invalid = validateImport(body);
    if (invalid) return fail(400, invalid, { subject: body.name });

    const cones = body.cones;
    const memos = Array.isArray(body.memos) ? body.memos : [];
    const markers = body.route_markers === undefined ? [] : body.route_markers;
    const steps = body.route_steps === undefined ? [] : body.route_steps;
    let imported;
    try {
      imported = db.transaction(() => {
        db.prepare(`INSERT INTO course (name, created_at, updated_at) VALUES (?, ${SQL_NOW}, ${SQL_NOW})`).run(name.value);
        const courseId = db.prepare("SELECT id FROM course WHERE id = last_insert_rowid()").get().id;
        const insertCone = db.prepare(
          `INSERT INTO cone (course_id, lat, lng, alt, side, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ${SQL_NOW}, ${SQL_NOW})`,
        );
        const coneIds = cones.map((cone) =>
          insertCone.run(courseId, cone.lat, cone.lng, typeof cone.alt === "number" ? cone.alt : null, cone.side)
            .lastInsertRowid,
        );
        const startIndex = body.start_cone_index;
        const startId =
          Number.isInteger(startIndex) && startIndex >= 0 && startIndex < coneIds.length ? coneIds[startIndex] : null;
        db.prepare("UPDATE course SET reverse = ?, start_cone_id = ? WHERE id = ?").run(body.reverse ? 1 : 0, startId, courseId);
        if (memos.length) {
          const insertMemo = db.prepare(
            `INSERT INTO memo (course_id, lat, lng, width, height, rotation, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ${SQL_NOW}, ${SQL_NOW})`,
          );
          for (const memo of memos) {
            insertMemo.run(
              courseId,
              memo.lat,
              memo.lng,
              memo.width,
              memo.height,
              validateMemoRotation(memo.rotation).value,
              typeof memo.content === "string" ? memo.content : "",
            );
          }
        }
        if (markers.length) {
          const insertMarker = db.prepare("INSERT INTO route_marker (course_id, lat, lng, label) VALUES (?, ?, ?, ?)");
          const markerIds = markers.map((marker) =>
            Number(insertMarker.run(courseId, marker.lat, marker.lng, validateRouteMarkerLabel(marker.label).value).lastInsertRowid),
          );
          const insertStep = db.prepare("INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)");
          steps.forEach((markerIndex, position) => insertStep.run(courseId, position, markerIds[markerIndex]));
        }
        return {
          course: reads.getCourse(courseId),
          cones: reads.getCones(courseId),
          memos: reads.getMemos(courseId),
          route: reads.getRoute(courseId),
        };
      })();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return fail(400, MESSAGES.duplicateCourseName, { subject: body.name, detail: { error: error.message } });
    }

    const courseId = imported.course.id;
    const events = [
      coursesEvent("create", { course: imported.course }),
      ["cones", { type: "add", courseId, cones: imported.cones }],
    ];
    if (imported.memos.length) events.push(["memos", { type: "add", courseId, memos: imported.memos }]);
    if (imported.route.markers.length) events.push(["route", { type: "import", courseId, ...imported.route }]);
    return changed(imported.course, {
      status: 201,
      subject: name.value,
      detail: {
        cone_count: cones.length,
        memo_count: memos.length,
        route_marker_count: markers.length,
        route_step_count: steps.length,
      },
      events,
    });
  }

  // Deleting a course cascades its editing assets. The cascade scope is counted
  // in the same transaction so the audit entry matches what was removed.
  function deleteCourse(rawId) {
    const { id, course, failure } = findCourse(reads, rawId);
    if (failure) return failure;
    const count = (sql) => db.prepare(sql).get(id).count;
    const cascade = db.transaction(() => {
      const counts = {
        cones: count("SELECT COUNT(*) AS count FROM cone WHERE course_id = ?"),
        memos: count("SELECT COUNT(*) AS count FROM memo WHERE course_id = ?"),
        route_markers: count("SELECT COUNT(*) AS count FROM route_marker WHERE course_id = ?"),
        route_steps: count("SELECT COUNT(*) AS count FROM route_step WHERE course_id = ?"),
        snapshots: count("SELECT COUNT(*) AS count FROM course_snapshot WHERE course_id = ?"),
        mission_presets: count("SELECT COUNT(*) AS count FROM mission_route_preset WHERE course_id = ?"),
        mission_preset_items: count(`SELECT COUNT(*) AS count
        FROM mission_route_preset_item item
        JOIN mission_route_preset preset ON preset.id = item.preset_id
        WHERE preset.course_id = ?`),
      };
      db.prepare("DELETE FROM course WHERE id = ?").run(id);
      return counts;
    })();
    return changed(undefined, {
      subject: course.name,
      detail: { course_id: id, cascade },
      events: [coursesEvent("delete", { courseId: id })],
    });
  }

  return { listCourses, createCourse, renameCourse, setCourseDirection, exportCourse, importCourse, deleteCourse };
}
