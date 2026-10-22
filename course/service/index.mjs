// Course data operations shared by every host. The service is synchronous over a
// better-sqlite3-compatible handle and knows nothing about users, permissions,
// publication, or transport; hosts add those around the returned results.
import { createConeOperations } from "./cones.mjs";
import { createCourseOperations } from "./courses.mjs";
import { createMemoOperations } from "./memos.mjs";
import { createPresetOperations } from "./presets.mjs";
import { createCourseReads } from "./reads.mjs";
import { parseId } from "./result.mjs";
import { createRouteOperations } from "./route.mjs";
import { createSnapshotOperations } from "./snapshots.mjs";

export { COURSE_INDEXES, COURSE_TABLES, initializeCourseSchema } from "./schema.mjs";
export { MISSION_MAX_OCCURRENCES, MISSION_MAX_PRESETS_PER_COURSE } from "./presets.mjs";
export * from "./validation.mjs";

export function createCourseService(db) {
  const reads = createCourseReads(db);
  const operations = {
    ...createCourseOperations(db, reads),
    ...createRouteOperations(db, reads),
    ...createConeOperations(db, reads),
    ...createMemoOperations(db, reads),
    ...createSnapshotOperations(db, reads),
    ...createPresetOperations(db, reads),
  };

  // Unexpected storage failures propagate as exceptions; tag them with the
  // affected course name so hosts can attribute the failure in their audit.
  const courseName = (courseId) => reads.getCourse(parseId(courseId))?.name ?? null;
  const subjects = {
    byBodyName: (body) => body?.name ?? null,
    byCourse: courseName,
    byCone: (id) => courseName(reads.getCone(parseId(id))?.course_id),
    byMemo: (id) => courseName(reads.getMemo(parseId(id))?.course_id),
    byMarker: (id) => courseName(reads.getRouteMarker(parseId(id))?.course_id),
  };
  const subjectOf = {
    createCourse: subjects.byBodyName,
    importCourse: subjects.byBodyName,
    updateCone: subjects.byCone,
    deleteCone: subjects.byCone,
    updateMemo: subjects.byMemo,
    deleteMemo: subjects.byMemo,
    updateRouteMarker: subjects.byMarker,
    deleteRouteMarker: subjects.byMarker,
  };
  const service = { reads };
  for (const [name, operation] of Object.entries(operations)) {
    const resolve = subjectOf[name] || subjects.byCourse;
    service[name] = (...args) => {
      try {
        return operation(...args);
      } catch (error) {
        if (error && typeof error === "object" && !("subject" in error)) {
          try {
            error.subject = resolve(...args);
          } catch {
            error.subject = null;
          }
        }
        throw error;
      }
    };
  }
  return service;
}
