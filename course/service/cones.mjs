import { findCourse, MESSAGES } from "./courses.mjs";
import { changed, fail, ok, parseId, SQL_NOW } from "./result.mjs";
import { validateAltitude, validateCoordinate, validateSide } from "./validation.mjs";

export function createConeOperations(db, reads) {
  const startResetEvent = (courseId) => [
    "courses",
    { type: "start_reset", course: reads.getCourse(courseId), courses: reads.listCourses() },
  ];

  function findCone(rawId) {
    const id = parseId(rawId);
    if (id == null) return { failure: fail(400, "Invalid cone ID.") };
    const cone = reads.getCone(id);
    if (!cone) return { failure: fail(404, "Cone not found.", { detail: { cone_id: id } }) };
    return { id, cone };
  }

  function listCones(rawCourseId) {
    const { id, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    return ok(reads.getCones(id));
  }

  function createCone(rawCourseId, body = {}) {
    const { id: courseId, course, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    const { lat, lng, side } = body;
    const coordinate = validateCoordinate(lat, lng);
    if (!coordinate.valid) return fail(400, coordinate.error, { subject: course.name });
    const alt = validateAltitude(body.alt);
    if (!alt.valid) return fail(400, alt.error, { subject: course.name });
    const sideCheck = validateSide(side);
    if (!sideCheck.valid) return fail(400, sideCheck.error, { subject: course.name });

    db.prepare(
      `INSERT INTO cone (course_id, lat, lng, alt, side, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ${SQL_NOW}, ${SQL_NOW})`,
    ).run(courseId, lat, lng, alt.value, side);
    const cone = db.prepare("SELECT * FROM cone WHERE id = last_insert_rowid()").get();
    return changed(cone, {
      status: 201,
      subject: course.name,
      detail: { lat, lng, alt: alt.value, side },
      events: [["cones", { type: "add", courseId, cone, cones: reads.getCones(courseId) }]],
    });
  }

  // Destructive bulk wipe: one audit entry and one change event instead of one per cone.
  function deleteAllCones(rawCourseId) {
    const { id: courseId, course, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    const count = reads.getCones(courseId).length;
    const hadStart = course.start_cone_id != null;
    db.transaction(() => {
      db.prepare("DELETE FROM cone WHERE course_id = ?").run(courseId);
      // Wiping every cone also invalidates the designated start cone.
      if (hadStart) db.prepare("UPDATE course SET start_cone_id = NULL WHERE id = ?").run(courseId);
    })();
    const events = [["cones", { type: "clear", courseId, cones: [] }]];
    if (hadStart) events.push(startResetEvent(courseId));
    return changed({ deleted: count }, { subject: course.name, detail: { count }, events });
  }

  function updateCone(rawId, body = {}) {
    const { id, cone, failure } = findCone(rawId);
    if (failure) return failure;
    const subject = reads.getCourse(cone.course_id)?.name ?? null;
    const sets = [];
    const values = [];
    if (body.lat !== undefined || body.lng !== undefined) {
      const lat = body.lat !== undefined ? body.lat : cone.lat;
      const lng = body.lng !== undefined ? body.lng : cone.lng;
      const coordinate = validateCoordinate(lat, lng);
      if (!coordinate.valid) return fail(400, coordinate.error, { subject });
      if (body.lat !== undefined) {
        sets.push("lat = ?");
        values.push(lat);
      }
      if (body.lng !== undefined) {
        sets.push("lng = ?");
        values.push(lng);
      }
    }
    if (body.alt !== undefined) {
      const alt = validateAltitude(body.alt);
      if (!alt.valid) return fail(400, alt.error, { subject });
      sets.push("alt = ?");
      values.push(alt.value);
    }
    if (body.side !== undefined) {
      const side = validateSide(body.side);
      if (!side.valid) return fail(400, side.error, { subject });
      sets.push("side = ?");
      values.push(body.side);
    }
    if (sets.length === 0) return fail(400, MESSAGES.nothingToUpdate, { subject });
    sets.push(`updated_at = ${SQL_NOW}`);
    db.prepare(`UPDATE cone SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    const updated = reads.getCone(id);
    return changed(updated, {
      subject,
      detail: {
        before: { lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side },
        after: { lat: updated.lat, lng: updated.lng, alt: updated.alt, side: updated.side },
      },
      events: [["cones", { type: "update", courseId: cone.course_id, cone: updated, cones: reads.getCones(cone.course_id) }]],
    });
  }

  function deleteCone(rawId) {
    const { id, cone, failure } = findCone(rawId);
    if (failure) return failure;
    // Clear a designated start cone in the same transaction so start_cone_id
    // never points at a deleted cone.
    const wasStart = reads.getCourse(cone.course_id)?.start_cone_id === id;
    db.transaction(() => {
      db.prepare("DELETE FROM cone WHERE id = ?").run(id);
      if (wasStart) db.prepare("UPDATE course SET start_cone_id = NULL WHERE id = ?").run(cone.course_id);
    })();
    const events = [["cones", { type: "delete", courseId: cone.course_id, coneId: id, cones: reads.getCones(cone.course_id) }]];
    if (wasStart) events.push(startResetEvent(cone.course_id));
    return changed(undefined, {
      subject: reads.getCourse(cone.course_id)?.name ?? null,
      detail: { lat: cone.lat, lng: cone.lng, side: cone.side },
      events,
    });
  }

  return { listCones, createCone, deleteAllCones, updateCone, deleteCone };
}
