export function createCourseReads(db) {
  const statements = {
    courses: db.prepare(`SELECT c.id, c.name, c.created_at, c.updated_at, c.reverse, c.start_cone_id,
           COUNT(cn.id) AS cone_count
    FROM course c
    LEFT JOIN cone cn ON cn.course_id = c.id
    GROUP BY c.id
    ORDER BY c.id`),
    course: db.prepare("SELECT * FROM course WHERE id = ?"),
    cones: db.prepare("SELECT * FROM cone WHERE course_id = ? ORDER BY id"),
    cone: db.prepare("SELECT * FROM cone WHERE id = ?"),
    memos: db.prepare("SELECT * FROM memo WHERE course_id = ? ORDER BY id"),
    memo: db.prepare("SELECT * FROM memo WHERE id = ?"),
    marker: db.prepare("SELECT * FROM route_marker WHERE id = ?"),
    markers: db.prepare("SELECT * FROM route_marker WHERE course_id = ? ORDER BY id"),
    steps: db.prepare("SELECT marker_id FROM route_step WHERE course_id = ? ORDER BY position"),
  };

  return {
    listCourses: () => statements.courses.all(),
    getCourse: (id) => statements.course.get(id),
    getCones: (courseId) => statements.cones.all(courseId),
    getCone: (id) => statements.cone.get(id),
    getMemos: (courseId) => statements.memos.all(courseId),
    getMemo: (id) => statements.memo.get(id),
    getRouteMarker: (id) => statements.marker.get(id),
    getRoute: (courseId) => ({
      markers: statements.markers.all(courseId),
      steps: statements.steps.all(courseId).map((row) => row.marker_id),
    }),
  };
}
