// REST surface of the course service. Every host serves these exact routes, so
// the console issues the same requests whether the data lives on a server or in
// the browser. `run(service, params, body, context)` returns a service result.
//   read          reads log only unexpected failures (unless logRejections)
//   courseValue   "course" | "courses": the response carries course rows
export const COURSE_ROUTES = [
  { method: "GET", path: "/api/courses", action: "course.list", read: true, courseValue: "courses",
    run: (s) => s.listCourses() },
  { method: "POST", path: "/api/courses", action: "course.create", courseValue: "course",
    run: (s, p, body) => s.createCourse(body) },
  { method: "POST", path: "/api/courses/import", action: "course.import", courseValue: "course",
    run: (s, p, body) => s.importCourse(body) },
  { method: "PATCH", path: "/api/courses/:id", action: "course.rename", courseValue: "course",
    run: (s, p, body) => s.renameCourse(p.id, body) },
  { method: "PATCH", path: "/api/courses/:id/direction", action: "course.direction", courseValue: "course",
    run: (s, p, body) => s.setCourseDirection(p.id, body) },
  { method: "GET", path: "/api/courses/:id/export", action: "course.export",
    run: (s, p) => s.exportCourse(p.id) },
  { method: "DELETE", path: "/api/courses/:id", action: "course.delete",
    run: (s, p) => s.deleteCourse(p.id) },

  { method: "GET", path: "/api/courses/:id/route", action: "course_route.read", read: true, logRejections: true,
    run: (s, p) => s.getRoute(p.id) },
  { method: "PUT", path: "/api/courses/:id/route/steps", action: "course_route.update",
    run: (s, p, body) => s.setRouteSteps(p.id, body) },
  { method: "POST", path: "/api/courses/:id/route/markers", action: "route_marker.create",
    run: (s, p, body) => s.createRouteMarker(p.id, body) },
  { method: "PATCH", path: "/api/route/markers/:id", action: "route_marker.update",
    run: (s, p, body) => s.updateRouteMarker(p.id, body) },
  { method: "DELETE", path: "/api/route/markers/:id", action: "route_marker.delete",
    run: (s, p) => s.deleteRouteMarker(p.id) },

  { method: "GET", path: "/api/courses/:id/cones", action: "cone.list", read: true,
    run: (s, p) => s.listCones(p.id) },
  { method: "POST", path: "/api/courses/:id/cones", action: "cone.create",
    run: (s, p, body) => s.createCone(p.id, body) },
  { method: "DELETE", path: "/api/courses/:id/cones", action: "cone.delete_all",
    run: (s, p) => s.deleteAllCones(p.id) },
  { method: "PATCH", path: "/api/cones/:id", action: "cone.update",
    run: (s, p, body) => s.updateCone(p.id, body) },
  { method: "DELETE", path: "/api/cones/:id", action: "cone.delete",
    run: (s, p) => s.deleteCone(p.id) },

  { method: "GET", path: "/api/courses/:id/memos", action: "memo.list", read: true,
    run: (s, p) => s.listMemos(p.id) },
  { method: "POST", path: "/api/courses/:id/memos", action: "memo.create",
    run: (s, p, body) => s.createMemo(p.id, body) },
  { method: "PATCH", path: "/api/memos/:id", action: "memo.update",
    run: (s, p, body) => s.updateMemo(p.id, body) },
  { method: "DELETE", path: "/api/memos/:id", action: "memo.delete",
    run: (s, p) => s.deleteMemo(p.id) },

  { method: "GET", path: "/api/courses/:id/snapshots", action: "course.snapshot.list", read: true,
    run: (s, p) => s.listSnapshots(p.id) },
  { method: "POST", path: "/api/courses/:id/snapshots", action: "course.snapshot.create",
    run: (s, p, body, context) => s.createSnapshot(p.id, body, { actor: context.actor }) },
  { method: "POST", path: "/api/courses/:id/snapshots/:sid/restore", action: "course.snapshot.restore",
    run: (s, p, body, context) => s.restoreSnapshot(p.id, p.sid, { actor: context.actor }) },
  { method: "DELETE", path: "/api/courses/:id/snapshots/:sid", action: "course.snapshot.delete",
    run: (s, p) => s.deleteSnapshot(p.id, p.sid) },

  { method: "GET", path: "/api/courses/:id/mission-presets", action: "mission.preset.list", read: true,
    run: (s, p) => s.listPresets(p.id) },
  { method: "POST", path: "/api/courses/:id/mission-presets", action: "mission.preset.create",
    run: (s, p, body, context) => s.createPreset(p.id, body, { actor: context.actor }) },
  { method: "PUT", path: "/api/courses/:id/mission-presets/:pid", action: "mission.preset.update",
    run: (s, p, body, context) => s.updatePreset(p.id, p.pid, body, { actor: context.actor }) },
  { method: "DELETE", path: "/api/courses/:id/mission-presets/:pid", action: "mission.preset.delete",
    run: (s, p, body) => s.deletePreset(p.id, p.pid, body) },
];

// HTTP rendering of a service result, shared by every transport.
export function resultResponse(result) {
  if (!result.ok) {
    return result.body
      ? { status: result.status, json: { message: result.error, ...result.body } }
      : { status: result.status, text: result.error };
  }
  const headers = result.filename
    ? { "Content-Disposition": `attachment; filename="${encodeURIComponent(result.filename)}"` }
    : {};
  if (result.value === undefined) return { status: result.status, text: "", headers };
  return { status: result.status, json: result.value, headers };
}
