import { findCourse } from "./courses.mjs";
import { changed, fail, ok, parseId, SQL_NOW } from "./result.mjs";
import { validateCoordinate } from "./validation.mjs";

export function createSnapshotOperations(db, reads) {
  const insertSnapshot = db.prepare(
    "INSERT INTO course_snapshot (course_id, taken_at, actor, reason, cones_json) VALUES (?, ?, ?, ?, ?)",
  );
  const selectForCourse = db.prepare(
    `SELECT id, course_id, taken_at, actor, reason,
          json_array_length(cones_json) AS cone_count
   FROM course_snapshot WHERE course_id = ? ORDER BY taken_at DESC LIMIT 100`,
  );
  const selectById = db.prepare(
    "SELECT id, course_id, taken_at, actor, reason, cones_json FROM course_snapshot WHERE id = ?",
  );

  // Returns the new snapshot id, or null for a course without cones.
  function takeCourseSnapshot(courseId, actor, reason) {
    const cones = reads.getCones(courseId);
    if (cones.length === 0) return null;
    const simplified = cones.map((c) => ({ lat: c.lat, lng: c.lng, alt: c.alt, side: c.side }));
    const info = insertSnapshot.run(courseId, Date.now(), actor || null, reason || null, JSON.stringify(simplified));
    return Number(info.lastInsertRowid);
  }

  function findSnapshot(rawCourseId, rawSnapshotId) {
    const courseId = parseId(rawCourseId);
    const snapshotId = parseId(rawSnapshotId);
    if (courseId == null || snapshotId == null) return { failure: fail(400, "Invalid ID.") };
    const found = findCourse(reads, courseId);
    if (found.failure) return found;
    const snapshot = selectById.get(snapshotId);
    if (!snapshot || snapshot.course_id !== courseId) {
      return { failure: fail(404, "Snapshot not found.", { subject: found.course.name, detail: { snapshot_id: snapshotId } }) };
    }
    return { courseId, course: found.course, snapshotId, snapshot };
  }

  function listSnapshots(rawCourseId) {
    const { id, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    return ok({ snapshots: selectForCourse.all(id) });
  }

  function createSnapshot(rawCourseId, body = {}, { actor = null } = {}) {
    const { id, course, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    const coneCount = reads.getCones(id).length;
    if (coneCount === 0) return fail(400, "A course without cones cannot be snapshotted.", { subject: course.name });
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : null;
    const snapshotId = takeCourseSnapshot(id, actor, reason);
    return changed({ id: snapshotId }, {
      status: 201,
      subject: course.name,
      detail: { snapshot_id: snapshotId, cone_count: coneCount, reason },
    });
  }

  function restoreSnapshot(rawCourseId, rawSnapshotId, { actor = null } = {}) {
    const { courseId, course, snapshotId, snapshot, failure } = findSnapshot(rawCourseId, rawSnapshotId);
    if (failure) return failure;
    let cones;
    try {
      cones = JSON.parse(snapshot.cones_json);
    } catch {
      cones = null;
    }
    if (!Array.isArray(cones)) {
      return fail(500, "The snapshot data is corrupted.", { subject: course.name, detail: { snapshot_id: snapshotId } });
    }
    let skippedCones = 0;
    const restored = db.transaction(() => {
      // Keep the current state as a safety net before overwriting it.
      takeCourseSnapshot(courseId, actor, `pre-restore of #${snapshotId}`);
      db.prepare("DELETE FROM cone WHERE course_id = ?").run(courseId);
      const insert = db.prepare(
        `INSERT INTO cone (course_id, lat, lng, alt, side, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ${SQL_NOW}, ${SQL_NOW})`,
      );
      // Snapshots are written from validated cones, but a damaged row must not be
      // restored as-is. Older snapshots have no alt; keep it null.
      for (const cone of cones) {
        if (!validateCoordinate(cone.lat, cone.lng).valid) {
          skippedCones++;
          continue;
        }
        insert.run(courseId, cone.lat, cone.lng, typeof cone.alt === "number" ? cone.alt : null, cone.side);
      }
      // Cones get fresh ids, so the designated start cone no longer exists.
      db.prepare("UPDATE course SET start_cone_id = NULL WHERE id = ?").run(courseId);
      return reads.getCones(courseId);
    })();
    return changed({ cones: restored }, {
      subject: course.name,
      detail: { snapshot_id: snapshotId, cone_count: cones.length },
      warnings: skippedCones ? [{ skipped_invalid_cones: skippedCones, snapshot_id: snapshotId }] : [],
      events: [
        ["cones", { type: "restore", courseId, cones: restored }],
        ["courses", { type: "start_reset", course: reads.getCourse(courseId), courses: reads.listCourses() }],
      ],
    });
  }

  function deleteSnapshot(rawCourseId, rawSnapshotId) {
    const { course, snapshotId, failure } = findSnapshot(rawCourseId, rawSnapshotId);
    if (failure) return failure;
    db.prepare("DELETE FROM course_snapshot WHERE id = ?").run(snapshotId);
    return changed(undefined, { status: 204, subject: course.name, detail: { snapshot_id: snapshotId } });
  }

  return { takeCourseSnapshot, listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot };
}
