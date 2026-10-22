import { findCourse, MESSAGES } from "./courses.mjs";
import { changed, fail, ok, parseId, SQL_NOW } from "./result.mjs";
import {
  validateCoordinate,
  validateMemoContent,
  validateMemoDimension,
  validateMemoRotation,
} from "./validation.mjs";

const MEMO_FIELDS = ["lat", "lng", "width", "height", "rotation", "content"];

export function createMemoOperations(db, reads) {
  function findMemo(rawId) {
    const id = parseId(rawId);
    if (id == null) return { failure: fail(400, "Invalid memo ID.") };
    const memo = reads.getMemo(id);
    if (!memo) return { failure: fail(404, "Memo not found.", { detail: { memo_id: id } }) };
    return { id, memo, subject: reads.getCourse(memo.course_id)?.name ?? null };
  }

  function listMemos(rawCourseId) {
    const { id, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    return ok(reads.getMemos(id));
  }

  function createMemo(rawCourseId, body = {}) {
    const { id: courseId, course, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    const { lat, lng } = body;
    const checks = [
      validateCoordinate(lat, lng),
      validateMemoDimension(body.width, "width"),
      validateMemoDimension(body.height, "height"),
      validateMemoRotation(body.rotation),
      validateMemoContent(body.content),
    ];
    const invalid = checks.find((check) => !check.valid);
    if (invalid) return fail(400, invalid.error, { subject: course.name });
    const [, width, height, rotation, content] = checks.map((check) => check.value);
    db.prepare(
      `INSERT INTO memo (course_id, lat, lng, width, height, rotation, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ${SQL_NOW}, ${SQL_NOW})`,
    ).run(courseId, lat, lng, width, height, rotation, content);
    const memo = db.prepare("SELECT * FROM memo WHERE id = last_insert_rowid()").get();
    return changed(memo, {
      status: 201,
      subject: course.name,
      detail: { lat, lng, width, height, rotation },
      events: [["memos", { type: "add", courseId, memo, memos: reads.getMemos(courseId) }]],
    });
  }

  function updateMemo(rawId, body = {}) {
    const { id, memo, subject, failure } = findMemo(rawId);
    if (failure) return failure;
    const sets = [];
    const values = [];
    if (body.lat !== undefined || body.lng !== undefined) {
      const lat = body.lat !== undefined ? body.lat : memo.lat;
      const lng = body.lng !== undefined ? body.lng : memo.lng;
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
    const optional = [
      ["width", () => validateMemoDimension(body.width, "width")],
      ["height", () => validateMemoDimension(body.height, "height")],
      ["rotation", () => validateMemoRotation(body.rotation)],
      ["content", () => validateMemoContent(body.content)],
    ];
    for (const [field, validate] of optional) {
      if (body[field] === undefined) continue;
      const check = validate();
      if (!check.valid) return fail(400, check.error, { subject });
      sets.push(`${field} = ?`);
      values.push(check.value);
    }
    if (sets.length === 0) return fail(400, MESSAGES.nothingToUpdate, { subject });
    sets.push(`updated_at = ${SQL_NOW}`);
    db.prepare(`UPDATE memo SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    const updated = reads.getMemo(id);
    // Record only changed fields; content can be long, so truncate it.
    const changes = {};
    for (const field of MEMO_FIELDS) {
      if (memo[field] !== updated[field]) {
        const truncate = (v) => (field === "content" && typeof v === "string" ? v.slice(0, 100) : v);
        changes[field] = { from: truncate(memo[field]), to: truncate(updated[field]) };
      }
    }
    return changed(updated, {
      subject,
      detail: { changes },
      events: [["memos", { type: "update", courseId: memo.course_id, memo: updated, memos: reads.getMemos(memo.course_id) }]],
    });
  }

  function deleteMemo(rawId) {
    const { id, memo, subject, failure } = findMemo(rawId);
    if (failure) return failure;
    db.prepare("DELETE FROM memo WHERE id = ?").run(id);
    return changed(undefined, {
      subject,
      detail: { lat: memo.lat, lng: memo.lng },
      events: [["memos", { type: "delete", courseId: memo.course_id, memoId: id, memos: reads.getMemos(memo.course_id) }]],
    });
  }

  return { listMemos, createMemo, updateMemo, deleteMemo };
}
