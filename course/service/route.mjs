import { findCourse, MESSAGES } from "./courses.mjs";
import { changed, fail, ok, parseId, SQL_NOW } from "./result.mjs";
import { validateCoordinate, validateRouteMarkerLabel } from "./validation.mjs";

const MAX_MARKERS = 200;
const MAX_STEPS = 500;

export function createRouteOperations(db, reads) {
  function findMarker(rawId) {
    const id = parseId(rawId);
    if (id == null) return { failure: fail(400, "Invalid route marker ID.") };
    const marker = reads.getRouteMarker(id);
    if (!marker) return { failure: fail(404, "Route marker not found.", { detail: { marker_id: id } }) };
    return { id, marker, course: reads.getCourse(marker.course_id) };
  }

  function getRoute(rawId) {
    const { id, failure } = findCourse(reads, rawId);
    if (failure) return failure;
    return ok(reads.getRoute(id));
  }

  function setRouteSteps(rawId, body = {}) {
    const { id, course, failure } = findCourse(reads, rawId);
    if (failure) return failure;
    const steps = body.steps;
    if (!Array.isArray(steps) || steps.length > MAX_STEPS || steps.some((markerId) => !Number.isInteger(markerId))) {
      return fail(400, `Invalid route order (integer marker IDs, at most ${MAX_STEPS} steps).`, {
        subject: course.name,
        detail: { requested: steps },
      });
    }
    const allowed = new Set(db.prepare("SELECT id FROM route_marker WHERE course_id = ?").all(id).map((row) => row.id));
    if (steps.some((markerId) => !allowed.has(markerId))) {
      return fail(400, "The route includes a marker from another course or one that does not exist.", {
        subject: course.name,
        detail: { requested: steps },
      });
    }
    const before = reads.getRoute(id).steps;
    const route = db.transaction(() => {
      db.prepare("DELETE FROM route_step WHERE course_id = ?").run(id);
      const insert = db.prepare("INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)");
      steps.forEach((markerId, position) => insert.run(id, position, markerId));
      return reads.getRoute(id);
    })();
    return changed(route, {
      subject: course.name,
      detail: { before, after: steps },
      events: [["route", { type: "steps", courseId: id, ...route }]],
    });
  }

  function createRouteMarker(rawCourseId, body = {}) {
    const { id: courseId, course, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    const coordinate = validateCoordinate(body.lat, body.lng);
    if (!coordinate.valid) {
      return fail(400, coordinate.error, { subject: course.name, detail: { lat: body.lat, lng: body.lng } });
    }
    const label = validateRouteMarkerLabel(body.label);
    if (!label.valid) return fail(400, label.error, { subject: course.name });
    const markerCount = db.prepare("SELECT COUNT(*) AS n FROM route_marker WHERE course_id = ?").get(courseId).n;
    if (markerCount >= MAX_MARKERS) {
      return fail(400, `A course can have at most ${MAX_MARKERS} route markers.`, {
        subject: course.name,
        detail: { marker_count: markerCount },
      });
    }
    const info = db
      .prepare("INSERT INTO route_marker (course_id, lat, lng, label) VALUES (?, ?, ?, ?)")
      .run(courseId, body.lat, body.lng, label.value);
    const marker = reads.getRouteMarker(Number(info.lastInsertRowid));
    const route = reads.getRoute(courseId);
    return changed(marker, {
      status: 201,
      subject: course.name,
      detail: { marker_id: marker.id, lat: body.lat, lng: body.lng, label: label.value },
      events: [["route", { type: "marker_add", courseId, ...route }]],
    });
  }

  function updateRouteMarker(rawId, body = {}) {
    const { id, marker, course, failure } = findMarker(rawId);
    if (failure) return failure;
    const sets = [];
    const values = [];
    if (body.lat !== undefined || body.lng !== undefined) {
      const lat = body.lat ?? marker.lat;
      const lng = body.lng ?? marker.lng;
      const coordinate = validateCoordinate(lat, lng);
      if (!coordinate.valid) {
        return fail(400, coordinate.error, { subject: course?.name, detail: { marker_id: id, lat, lng } });
      }
      if (body.lat !== undefined) {
        sets.push("lat = ?");
        values.push(body.lat);
      }
      if (body.lng !== undefined) {
        sets.push("lng = ?");
        values.push(body.lng);
      }
    }
    if (body.label !== undefined) {
      const label = validateRouteMarkerLabel(body.label);
      if (!label.valid) return fail(400, label.error, { subject: course?.name, detail: { marker_id: id } });
      sets.push("label = ?");
      values.push(label.value);
    }
    if (!sets.length) return fail(400, MESSAGES.nothingToUpdate, { subject: course?.name, detail: { marker_id: id } });
    sets.push(`updated_at = ${SQL_NOW}`);
    db.prepare(`UPDATE route_marker SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    const updated = reads.getRouteMarker(id);
    const route = reads.getRoute(marker.course_id);
    return changed(updated, {
      subject: course?.name,
      detail: {
        marker_id: id,
        before: { lat: marker.lat, lng: marker.lng, label: marker.label },
        after: { lat: updated.lat, lng: updated.lng, label: updated.label },
      },
      events: [["route", { type: "marker_update", courseId: marker.course_id, ...route }]],
    });
  }

  function deleteRouteMarker(rawId) {
    const { id, marker, course, failure } = findMarker(rawId);
    if (failure) return failure;
    const removedVisits = reads.getRoute(marker.course_id).steps.filter((markerId) => markerId === id).length;
    const route = db.transaction(() => {
      db.prepare("DELETE FROM route_marker WHERE id = ?").run(id);
      // ON DELETE CASCADE removes the visits; compact positions to keep exports stable.
      const steps = db
        .prepare("SELECT marker_id FROM route_step WHERE course_id = ? ORDER BY position")
        .all(marker.course_id);
      db.prepare("DELETE FROM route_step WHERE course_id = ?").run(marker.course_id);
      const insert = db.prepare("INSERT INTO route_step (course_id, position, marker_id) VALUES (?, ?, ?)");
      steps.forEach((row, position) => insert.run(marker.course_id, position, row.marker_id));
      return reads.getRoute(marker.course_id);
    })();
    return changed(route, {
      subject: course?.name,
      detail: { marker_id: id, lat: marker.lat, lng: marker.lng, label: marker.label, removed_visits: removedVisits },
      events: [["route", { type: "marker_delete", courseId: marker.course_id, ...route }]],
    });
  }

  return { getRoute, setRouteSteps, createRouteMarker, updateRouteMarker, deleteRouteMarker };
}
