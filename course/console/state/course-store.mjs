import { computed, onScopeDispose, ref, watch } from "vue";
import { buildSideRanks } from "../../cone-index.mjs";
import { resolveCourseRoute, ROUTE_MODE } from "../../route-mode.mjs";
import { courseDirectionOptions } from "../lib/course-display.mjs";
import { loadPref, savePref } from "./prefs.mjs";

// Course data of the host: courses, their cones, memos and route markers, the
// active course, and every edit. Each edit records its inverse in `edits`.
// Confirmation prompts belong to the caller.
export function createCourseStore({ host, notify, edits }) {
  const request = (endpoint, options) => host.course.request(endpoint, options);
  const { success: notifySuccess, error: notifyError, warning: notifyWarn } = notify;

  const courses = ref([]);
  const conesMap = ref({});
  const memosMap = ref({}); // courseId → memo[] { id, course_id, lat, lng, width, height, content, rotation }
  const routeMap = ref({}); // courseId → { markers, steps }; steps may repeat marker ids
  // Courses drawn next to the active one.
  const visibility = ref(loadPref("overlays", {}, (v) => JSON.parse(v) || {}));
  const activeCourseId = ref(null);
  const loading = ref(true);
  const publishingId = ref(null);
  // Set while the operator drags, resizes or types into a memo of the active
  // course, so a `memos` echo cannot replace the array mid-gesture; the PATCH
  // echo after the gesture settles the final state.
  let memoBusy = false;

  watch(visibility, (v) => savePref("overlays", JSON.stringify(v)), { deep: true });
  watch(activeCourseId, (v) => { if (v != null) savePref("activeCourseId", v); });

  const activeCourse = computed(() => courses.value.find((c) => c.id === activeCourseId.value));
  const activeCones = computed(() => conesMap.value[activeCourseId.value] || []);
  // Memos ignore cone visibility; a selected course always shows them.
  const activeMemos = computed(() => {
    const id = activeCourseId.value;
    if (!id) return [];
    return memosMap.value[id] || [];
  });
  const activeRoute = computed(() => routeMap.value[activeCourseId.value] || { markers: [], steps: [] });
  const routeMarkerById = computed(() => new Map(activeRoute.value.markers.map((marker) => [marker.id, marker])));
  // Two or more visits mean the markers, not the stored course row, decide the
  // start and the travel direction.
  const hasMarkerRoute = computed(() => activeRoute.value.steps.length >= 2);
  // Per-side #N of every cone of the active course, for O(1) lookup.
  const activeConeSideRanks = computed(() => buildSideRanks(activeCones.value));

  // Listeners for wholesale cone replacement of one course (id) or all (null).
  const conesListeners = new Set();
  function onConesReplaced(fn) {
    conesListeners.add(fn);
    return () => conesListeners.delete(fn);
  }
  const emitConesReplaced = (courseId) => { for (const fn of conesListeners) fn(courseId); };

  /* ── Data fetch ───────────────────────────────────── */
  async function fetchAll() {
    try {
      const res = await request("/api/courses");
      courses.value = await res.json();
      // Fan every course's cones, memos and route out concurrently.
      await Promise.all(courses.value.map(async (c) => {
        const [cones, memos, route] = await Promise.all([
          request(`/api/courses/${c.id}/cones`).then((r) => r.json()).catch(() => []),
          request(`/api/courses/${c.id}/memos`).then((r) => r.json()).catch(() => []),
          request(`/api/courses/${c.id}/route`).then((r) => r.json()).catch(() => ({ markers: [], steps: [] })),
        ]);
        conesMap.value[c.id] = cones;
        memosMap.value[c.id] = memos;
        routeMap.value[c.id] = route;
      }));
      if (!activeCourseId.value && courses.value.length) {
        // Restore the last-used course so a refresh keeps the operator's course.
        const saved = Number(loadPref("activeCourseId", null));
        const match = Number.isInteger(saved) && courses.value.find((c) => c.id === saved);
        activeCourseId.value = match ? saved : courses.value[0].id;
      }
    } catch {} finally { loading.value = false; }
  }

  /* ── Courses ──────────────────────────────────────── */
  async function createCourse(name) {
    try {
      const res = await request("/api/courses", { method: "POST", body: JSON.stringify({ name }) });
      const created = await res.json();
      activeCourseId.value = created.id;
      return created;
    } catch (err) { notifyError(err.message); return null; }
  }

  async function renameCourse(id, name) {
    try {
      await request(`/api/courses/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      return true;
    } catch (err) { notifyError(err.message); return false; }
  }

  async function deleteCourse(id) {
    try {
      await request(`/api/courses/${id}`, { method: "DELETE" });
      if (activeCourseId.value === id) {
        activeCourseId.value = courses.value.find((c) => c.id !== id)?.id || null;
      }
    } catch (err) { notifyError(err.message); }
  }

  async function togglePublication(course) {
    if (publishingId.value != null) return;
    publishingId.value = course.id;
    try {
      const response = await request(`/api/courses/${course.id}/publication`, {
        method: "PATCH", body: JSON.stringify({ is_public: !course.is_public }),
      });
      const updated = await response.json();
      const row = courses.value.find((c) => c.id === course.id);
      if (row) row.is_public = updated.is_public;
      notifySuccess(updated.is_public ? "Course published." : "Course unpublished.");
    } catch (error) { notifyError(error.message); }
    finally { publishingId.value = null; }
  }

  function toggleVisibility(courseId) {
    if (courseId === activeCourseId.value) return;
    visibility.value[courseId] = !visibility.value[courseId];
  }

  // Start cone and travel direction live on the course row, shared by every
  // operator. The change applies locally at once so a rapid second tap toggles
  // from the new state; only the changed fields roll back on failure.
  async function saveCourseDirection(id, patch) {
    const i = courses.value.findIndex((c) => c.id === id);
    if (i < 0) return;
    const before = courses.value[i];
    const next = { ...before };
    if ("reverse" in patch) next.reverse = patch.reverse ? 1 : 0;
    if ("start_cone_id" in patch) next.start_cone_id = patch.start_cone_id;
    courses.value[i] = next;
    try {
      await request(`/api/courses/${id}/direction`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    } catch (err) {
      const j = courses.value.findIndex((c) => c.id === id);
      if (j >= 0) {
        const rolled = { ...courses.value[j] };
        if ("reverse" in patch) rolled.reverse = before.reverse;
        if ("start_cone_id" in patch) rolled.start_cone_id = before.start_cone_id;
        courses.value[j] = rolled;
      }
      notifyWarn(err.message || "Failed to save the travel direction.");
    }
  }

  // Sets the cone as the start, or clears it back to the automatic start gate.
  function toggleStartCone(coneId) {
    const id = activeCourseId.value;
    if (id == null || coneId == null) return;
    const next = activeCourse.value?.start_cone_id === coneId ? null : coneId;
    saveCourseDirection(id, { start_cone_id: next });
  }

  /* ── Route markers ────────────────────────────────── */
  async function fetchRoute(courseId) {
    if (!courseId) return;
    try {
      const res = await request(`/api/courses/${courseId}/route`);
      routeMap.value[courseId] = await res.json();
    } catch (err) {
      notifyError(err.message);
    }
  }

  async function addRouteMarker(lat, lng) {
    const courseId = activeCourseId.value;
    if (!courseId) return;
    try {
      const n = activeRoute.value.markers.length + 1;
      await request(`/api/courses/${courseId}/route/markers`, {
        method: "POST",
        body: JSON.stringify({ lat, lng, label: `M${n}` }),
      });
      await fetchRoute(courseId);
    } catch (err) { notifyError(err.message); }
  }

  async function updateRouteMarker(marker, patch) {
    try {
      await request(`/api/route/markers/${marker.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await fetchRoute(marker.course_id);
    } catch (err) {
      notifyError(err.message);
      const current = routeMap.value[marker.course_id] || { markers: [], steps: [] };
      routeMap.value[marker.course_id] = { markers: current.markers.map((item) => ({ ...item })), steps: current.steps.slice() };
    }
  }

  async function deleteRouteMarker(marker) {
    try {
      const res = await request(`/api/route/markers/${marker.id}`, { method: "DELETE" });
      routeMap.value[marker.course_id] = await res.json();
    } catch (err) { notifyError(err.message); }
  }

  async function saveRouteSteps(steps) {
    const courseId = activeCourseId.value;
    if (!courseId) return;
    try {
      const res = await request(`/api/courses/${courseId}/route/steps`, {
        method: "PUT", body: JSON.stringify({ steps }),
      });
      routeMap.value[courseId] = await res.json();
    } catch (err) { notifyError(err.message); }
  }

  function appendRouteVisit(markerId) {
    saveRouteSteps([...activeRoute.value.steps, markerId]);
  }

  function moveRouteVisit(index, delta) {
    const steps = activeRoute.value.steps.slice();
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    saveRouteSteps(steps);
  }

  function removeRouteVisit(index) {
    const steps = activeRoute.value.steps.slice();
    steps.splice(index, 1);
    saveRouteSteps(steps);
  }

  /* ── Centerline ───────────────────────────────────── */
  // Computed from the active course's cones and route markers; recompute is
  // debounced and rides cone/route/direction changes, never mid-drag.
  const centerline = ref(null); // { ok, closed, length, points } | null
  const routeMode = ref(ROUTE_MODE.AUTO); // which engine produced `centerline`
  const routeError = ref("");
  let centerlineTimer = null;

  // Start point and direction options, shared by the map and the ZIP export.
  function courseDirOpts(courseId, cones) {
    const course = courses.value.find((c) => c.id === courseId);
    return course ? courseDirectionOptions(course, cones) : {};
  }

  function scheduleCenterline() {
    if (centerlineTimer) clearTimeout(centerlineTimer);
    centerlineTimer = setTimeout(recomputeCenterline, 250);
  }

  function recomputeCenterline() {
    centerlineTimer = null;
    const cones = activeCones.value;
    routeError.value = "";
    if (cones.length < 6) {
      centerline.value = null;
      routeMode.value = ROUTE_MODE.AUTO;
      return;
    }
    // Markers that only orient one loop keep the centerline engine; markers
    // that re-use pavement go to the router. No markers: the stored course row.
    try {
      const resolved = resolveCourseRoute(cones, activeRoute.value.markers, activeRoute.value.steps, {
        step: 1.0,
        fallback: courseDirOpts(activeCourseId.value, cones),
      });
      centerline.value = resolved.centerline;
      routeMode.value = resolved.mode;
    } catch (err) {
      centerline.value = null;
      routeMode.value = ROUTE_MODE.GUIDED;
      routeError.value = err?.message || String(err);
    }
  }

  watch(activeCones, scheduleCenterline);
  watch(activeRoute, scheduleCenterline, { deep: true });
  // This client's own direction edit or another operator's (courses echo).
  watch(
    () => {
      const c = courses.value.find((cc) => cc.id === activeCourseId.value);
      return c ? `${c.reverse}|${c.start_cone_id}` : "";
    },
    scheduleCenterline,
  );
  onScopeDispose(() => { if (centerlineTimer) clearTimeout(centerlineTimer); });

  /* ── Cones ────────────────────────────────────────── */
  function coneById(courseId, id) {
    return (conesMap.value[courseId] || []).find((c) => c.id === id);
  }

  // alt is kept only for cones captured from an RTK device.
  async function addCone(lat, lng, side, alt) {
    if (!activeCourseId.value) return;
    try {
      const res = await request(`/api/courses/${activeCourseId.value}/cones`, {
        method: "POST", body: JSON.stringify({ lat, lng, side, alt }),
      });
      const created = await res.json().catch(() => null);
      if (created && created.id != null) {
        const cid = created.id;
        edits.push("Add cone", () => request(`/api/cones/${cid}`, { method: "DELETE" }));
      }
    } catch (err) { notifyError(err.message); }
  }

  // Sends lat/lng only when the caller changed them, so a side-only edit never
  // reverts a move another operator made after the selection.
  async function updateCone(id, body) {
    const before = coneById(activeCourseId.value, id);
    try {
      await request(`/api/cones/${id}`, {
        method: "PATCH", body: JSON.stringify(body),
      });
      if (before) edits.push("Edit cone", () => request(`/api/cones/${id}`, {
        method: "PATCH", body: JSON.stringify({ lat: before.lat, lng: before.lng, side: before.side }),
      }));
      return true;
    } catch (err) { notifyError(err.message); return false; }
  }

  async function deleteCone(id) {
    const courseId = activeCourseId.value;
    const before = coneById(courseId, id);
    try {
      await request(`/api/cones/${id}`, { method: "DELETE" });
      if (before) edits.push("Delete cone", () => request(`/api/courses/${courseId}/cones`, {
        method: "POST", body: JSON.stringify({ lat: before.lat, lng: before.lng, side: before.side, alt: before.alt }),
      }));
      return true;
    } catch (err) { notifyError(err.message); return false; }
  }

  // `cones` echoes rebuild the map, so only the requests and the undo entry run here.
  async function deleteCones(ids) {
    const courseId = activeCourseId.value;
    const idSet = new Set(ids);
    const removed = (conesMap.value[courseId] || [])
      .filter((c) => idSet.has(c.id))
      .map((c) => ({ lat: c.lat, lng: c.lng, side: c.side }));
    try {
      await Promise.all(ids.map((id) => request(`/api/cones/${id}`, { method: "DELETE" })));
      if (removed.length) edits.push(`Delete ${removed.length} cones`, () => Promise.all(
        removed.map((r) => request(`/api/courses/${courseId}/cones`, { method: "POST", body: JSON.stringify(r) })),
      ));
    } catch (err) {
      notifyError(`Failed to delete cones: ${err.message}`);
    }
  }

  async function deleteAllCones() {
    const courseId = activeCourseId.value;
    if (!courseId) return false;
    const all = (conesMap.value[courseId] || []).map((c) => ({ lat: c.lat, lng: c.lng, side: c.side, alt: c.alt }));
    if (all.length === 0) return false;
    try {
      await request(`/api/courses/${courseId}/cones`, { method: "DELETE" });
      edits.push(`Delete all ${all.length} cones`, () => Promise.all(
        all.map((c) => request(`/api/courses/${courseId}/cones`, { method: "POST", body: JSON.stringify(c) })),
      ));
      return true;
    } catch (err) {
      notifyError(`Failed to delete all cones: ${err.message}`);
      return false;
    }
  }

  // Saves new positions; `before` holds the positions to undo to. Throws so the
  // caller can roll back its markers and word the failure.
  async function moveCones(updates, before, label) {
    await Promise.all(updates.map((u) =>
      request(`/api/cones/${u.id}`, { method: "PATCH", body: JSON.stringify({ lat: u.lat, lng: u.lng }) }),
    ));
    if (before.length) edits.push(label, () => Promise.all(
      before.map((b) => request(`/api/cones/${b.id}`, { method: "PATCH", body: JSON.stringify({ lat: b.lat, lng: b.lng }) })),
    ));
  }

  /* ── Memos ────────────────────────────────────────── */
  // A geo-anchored label layer, separate from cones: memos are always editable.
  function findMemo(id) {
    return (memosMap.value[activeCourseId.value] || []).find((m) => m.id === id);
  }

  async function addMemo(body) {
    const courseId = activeCourseId.value;
    if (!courseId) return null;
    try {
      const res = await request(`/api/courses/${courseId}/memos`, {
        method: "POST",
        body: JSON.stringify({ ...body, content: "" }),
      });
      const created = await res.json().catch(() => null);
      if (created && created.id != null) {
        // Show it before the echo arrives (the echo replacing the array is harmless).
        const list = memosMap.value[courseId] || (memosMap.value[courseId] = []);
        if (!list.some((x) => x.id === created.id)) list.push(created);
        edits.push("Add memo", () => request(`/api/memos/${created.id}`, { method: "DELETE" }));
        return created;
      }
    } catch (err) { notifyError(err.message); }
    return null;
  }

  async function deleteMemo(id) {
    const before = findMemo(id);
    try {
      await request(`/api/memos/${id}`, { method: "DELETE" });
      if (before) edits.push("Delete memo", () => request(`/api/courses/${before.course_id}/memos`, {
        method: "POST",
        body: JSON.stringify({ lat: before.lat, lng: before.lng, width: before.width, height: before.height, content: before.content }),
      }));
    } catch (err) { notifyError(err.message); }
  }

  // Saves `patch`; undo re-applies `revert`. Throws so the caller can restore its copy.
  async function patchMemo(id, patch, revert, label) {
    await request(`/api/memos/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    edits.push(label, () => request(`/api/memos/${id}`, { method: "PATCH", body: JSON.stringify(revert) }));
  }

  function setMemoBusy(busy) { memoBusy = busy; }

  /* ── Events ───────────────────────────────────────── */
  function parseSSE(e) {
    try { return JSON.parse(e.data); } catch { return null; }
  }

  function attachEvents(stream) {
    stream.addEventListener("init", (e) => {
      const data = parseSSE(e);
      if (data) courses.value = data.courses;
    });

    stream.addEventListener("courses", (e) => {
      const data = parseSSE(e);
      if (!data) return;
      courses.value = data.courses;
      for (const id of Object.keys(conesMap.value)) {
        if (!data.courses.find((c) => c.id === parseInt(id))) {
          delete conesMap.value[id];
          delete memosMap.value[id];
          delete routeMap.value[id];
          delete visibility.value[id];
        }
      }
      if (activeCourseId.value && !data.courses.find((c) => c.id === activeCourseId.value)) {
        activeCourseId.value = data.courses[0]?.id || null;
      }
    });

    stream.addEventListener("cones", (e) => {
      const data = parseSSE(e);
      if (!data) return;
      conesMap.value[data.courseId] = data.cones;
      // Cone edits broadcast only `cones`, so keep the list's "(N)" count live here.
      const course = courses.value.find((c) => c.id === data.courseId);
      if (course) course.cone_count = data.cones.length;
      emitConesReplaced(data.courseId);
    });

    stream.addEventListener("memos", (e) => {
      const data = parseSSE(e);
      if (!data) return;
      if (memoBusy && data.courseId === activeCourseId.value) return;
      memosMap.value[data.courseId] = data.memos;
    });

    stream.addEventListener("route", (e) => {
      const data = parseSSE(e);
      if (!data) return;
      routeMap.value[data.courseId] = { markers: data.markers || [], steps: data.steps || [] };
    });
  }

  // Events sent while the link was down are lost; reload everything.
  async function resync() {
    await fetchAll();
    emitConesReplaced(null);
  }

  return {
    request,
    courses, conesMap, memosMap, routeMap, visibility, activeCourseId, loading, publishingId,
    activeCourse, activeCones, activeMemos, activeRoute, routeMarkerById, hasMarkerRoute, activeConeSideRanks,
    centerline, routeMode, routeError, recomputeCenterline, courseDirOpts,
    fetchAll, resync, attachEvents, onConesReplaced,
    createCourse, renameCourse, deleteCourse, togglePublication, toggleVisibility, toggleStartCone,
    fetchRoute, addRouteMarker, updateRouteMarker, deleteRouteMarker, saveRouteSteps,
    appendRouteVisit, moveRouteVisit, removeRouteVisit,
    addCone, updateCone, deleteCone, deleteCones, deleteAllCones, moveCones,
    findMemo, addMemo, deleteMemo, patchMemo, setMemoBusy,
  };
}
