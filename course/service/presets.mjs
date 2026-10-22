import { findCourse } from "./courses.mjs";
import { changed, fail, ok, parseId } from "./result.mjs";
import { sha256Hex } from "./sha256.mjs";

export const MISSION_MAX_OCCURRENCES = 1000;
export const MISSION_MAX_PRESETS_PER_COURSE = 20;
const FINISH_BEHAVIORS = new Set(["stop", "return_to_start"]);

const REVISION_CONFLICT = "Another operator changed this preset. Reload the latest presets.";

// Opaque optimistic-concurrency token; identical to the digest previously
// computed with Node's crypto, so tokens issued before stay comparable.
function presetRevision(preset, items) {
  return sha256Hex(JSON.stringify({
    id: preset.id,
    course_id: preset.course_id,
    name: preset.name,
    finish_behavior: preset.finish_behavior,
    items: items.map((item) => ({
      id: item.id,
      position: item.position,
      cone_id: item.cone_id,
      cone_id_snapshot: item.cone_id_snapshot,
      lat_snapshot: item.lat_snapshot,
      lng_snapshot: item.lng_snapshot,
      alt_snapshot: item.alt_snapshot,
      side_snapshot: item.side_snapshot,
    })),
  }));
}

export function createPresetOperations(db, reads) {
  const selectPresets = db.prepare("SELECT * FROM mission_route_preset WHERE course_id=? ORDER BY name,id");
  const selectItems = db.prepare(`SELECT i.*, c.lat AS live_lat, c.lng AS live_lng,
      c.alt AS live_alt, c.side AS live_side, c.course_id AS live_course_id
      FROM mission_route_preset_item i LEFT JOIN cone c ON c.id=i.cone_id
      WHERE i.preset_id=? ORDER BY i.position`);

  // An item is stale when its cone was deleted (FK SET NULL) or now belongs to
  // another course; stale items report their stored snapshot instead.
  function presetsForCourse(courseId) {
    return selectPresets.all(courseId).map((preset) => {
      let stale = false;
      const storedItems = selectItems.all(preset.id);
      const items = storedItems.map((item) => {
        const isStale = item.cone_id == null || item.live_course_id !== preset.course_id;
        if (isStale) stale = true;
        return {
          id: item.id,
          position: item.position,
          cone_id: item.cone_id,
          cone_id_snapshot: item.cone_id_snapshot,
          lat: isStale ? item.lat_snapshot : item.live_lat,
          lng: isStale ? item.lng_snapshot : item.live_lng,
          alt: isStale ? item.alt_snapshot : item.live_alt,
          side: isStale ? item.side_snapshot : item.live_side,
          stale: isStale,
        };
      });
      return { ...preset, preset_revision: presetRevision(preset, storedItems), stale, items };
    });
  }

  // Each item must name a cone of this course whose coordinates still match
  // what the operator reviewed.
  function resolveConeItems(courseId, items) {
    if (!Array.isArray(items) || items.length === 0 || items.length > MISSION_MAX_OCCURRENCES) {
      return { failure: fail(400, `A cone route must have between 1 and ${MISSION_MAX_OCCURRENCES.toLocaleString("en-US")} items.`) };
    }
    const cones = new Map(reads.getCones(courseId).map((c) => [c.id, c]));
    const resolved = [];
    for (const [position, item] of items.entries()) {
      const coneId = Number(item?.cone_id ?? item);
      const cone = cones.get(coneId);
      if (!Number.isInteger(coneId) || !cone) {
        return {
          failure: fail(409, `Item ${position + 1} refers to a cone that is not in this course.`, {
            body: { reason: "missing_cone", position, cone_id: coneId },
          }),
        };
      }
      const hasSnapshot = item && typeof item === "object" && !Array.isArray(item)
        && Object.hasOwn(item, "lat") && Object.hasOwn(item, "lng")
        && Object.hasOwn(item, "alt") && Object.hasOwn(item, "side");
      const expectedAlt = item?.alt == null ? null : Number(item.alt);
      const currentAlt = cone.alt == null ? null : Number(cone.alt);
      const snapshotMatches = hasSnapshot
        && Number.isFinite(item.lat) && Number(item.lat) === Number(cone.lat)
        && Number.isFinite(item.lng) && Number(item.lng) === Number(cone.lng)
        && (expectedAlt == null || Number.isFinite(expectedAlt))
        && expectedAlt === currentAlt
        && item.side === cone.side;
      if (!snapshotMatches) {
        return {
          failure: fail(409, `Cone ${position + 1} changed after the preflight check. Review the latest route.`, {
            body: {
              reason: "cone_snapshot_mismatch",
              position,
              cone_id: coneId,
              current_cone: { cone_id: cone.id, lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side },
            },
          }),
        };
      }
      resolved.push(cone);
    }
    return { cones: resolved };
  }

  function revisionConflict(subject, currentRevision) {
    return fail(409, REVISION_CONFLICT, {
      subject,
      body: { reason: "preset_revision_mismatch", current_preset_revision: currentRevision },
    });
  }

  function listPresets(rawCourseId) {
    const { id, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    return ok({ presets: presetsForCourse(id) });
  }

  function savePreset(courseId, presetId, body, actor) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) return fail(400, "Preset name must be 1 to 100 characters.");
    const finishBehavior = body.finish_behavior ?? "stop";
    if (!FINISH_BEHAVIORS.has(finishBehavior)) return fail(400, "Invalid finish behavior.");
    const { cones, failure } = resolveConeItems(courseId, body.items);
    if (failure) return failure;
    const conflictingName = db.prepare(`SELECT id FROM mission_route_preset
      WHERE course_id=? AND name=? COLLATE NOCASE`).get(courseId, name);
    if (conflictingName && conflictingName.id !== presetId) {
      return fail(409, "A mission preset with this name already exists.", { subject: name, body: { reason: "duplicate_preset_name" } });
    }
    const now = Date.now();
    return db.transaction(() => {
      let id = presetId;
      let before = null;
      if (presetId != null) {
        const existing = db.prepare("SELECT * FROM mission_route_preset WHERE id=?").get(presetId);
        if (!existing || existing.course_id !== courseId) return fail(404, "Preset not found.");
        before = presetsForCourse(courseId).find((preset) => preset.id === presetId) || existing;
        if (typeof body.expected_preset_revision !== "string" || body.expected_preset_revision !== before.preset_revision) {
          return revisionConflict(existing.name, before.preset_revision);
        }
        db.prepare("UPDATE mission_route_preset SET name=?,finish_behavior=?,updated_at=?,actor=? WHERE id=?")
          .run(name, finishBehavior, now, actor, presetId);
        db.prepare("DELETE FROM mission_route_preset_item WHERE preset_id=?").run(presetId);
      } else {
        const presetCount = db.prepare("SELECT COUNT(*) AS count FROM mission_route_preset WHERE course_id=?").get(courseId).count;
        if (presetCount >= MISSION_MAX_PRESETS_PER_COURSE) {
          return fail(409, `A course can store at most ${MISSION_MAX_PRESETS_PER_COURSE} mission presets.`, {
            subject: name,
            body: { reason: "preset_limit" },
          });
        }
        const info = db.prepare(`INSERT INTO mission_route_preset
          (course_id,name,finish_behavior,created_at,updated_at,actor) VALUES (?,?,?,?,?,?)`)
          .run(courseId, name, finishBehavior, now, now, actor);
        id = Number(info.lastInsertRowid);
      }
      const insert = db.prepare(`INSERT INTO mission_route_preset_item
        (id,preset_id,position,cone_id,cone_id_snapshot,lat_snapshot,lng_snapshot,alt_snapshot,side_snapshot)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      cones.forEach((cone, position) => insert.run(
        globalThis.crypto.randomUUID(), id, position, cone.id, cone.id, cone.lat, cone.lng, cone.alt, cone.side,
      ));
      const after = presetsForCourse(courseId).find((preset) => preset.id === id);
      const detail = {
        preset_id: id,
        course_id: courseId,
        finish_behavior: after.finish_behavior,
        waypoint_count: after.items.length,
        after: { name: after.name, preset_revision: after.preset_revision },
      };
      if (before) {
        delete detail.finish_behavior;
        delete detail.waypoint_count;
        detail.before = { name: before.name, finish_behavior: before.finish_behavior, waypoint_count: before.items?.length };
        detail.after = { ...detail.after, finish_behavior: after.finish_behavior, waypoint_count: after.items.length };
      }
      return changed(after, { status: before ? 200 : 201, subject: after.name, detail });
    })();
  }

  function createPreset(rawCourseId, body = {}, { actor = null } = {}) {
    const { id, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    return savePreset(id, null, body, actor);
  }

  function updatePreset(rawCourseId, rawPresetId, body = {}, { actor = null } = {}) {
    const { id, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    const presetId = parseId(rawPresetId);
    if (presetId == null) return fail(400, "Invalid preset ID.");
    return savePreset(id, presetId, body, actor);
  }

  function deletePreset(rawCourseId, rawPresetId, body = {}) {
    const { id: courseId, failure } = findCourse(reads, rawCourseId);
    if (failure) return failure;
    const presetId = parseId(rawPresetId);
    if (presetId == null) return fail(400, "Invalid preset ID.");
    const before = presetsForCourse(courseId).find((preset) => preset.id === presetId);
    if (!before) return fail(404, "Preset not found.");
    if (typeof body.expected_preset_revision !== "string" || body.expected_preset_revision !== before.preset_revision) {
      return revisionConflict(before.name, before.preset_revision);
    }
    db.prepare("DELETE FROM mission_route_preset WHERE id=?").run(presetId);
    return changed(undefined, {
      status: 204,
      subject: before.name,
      detail: {
        preset_id: presetId,
        course_id: courseId,
        before: { name: before.name, finish_behavior: before.finish_behavior, waypoint_count: before.items.length },
      },
    });
  }

  return { listPresets, createPreset, updatePreset, deletePreset, presetsForCourse };
}
