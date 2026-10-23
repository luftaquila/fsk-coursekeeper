<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { formatAlt, formatLatLng } from "../../../geo.mjs";
import { ROUTE_MODE } from "../../../route-mode.mjs";
import { SIDES } from "../../state/editor-store.mjs";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleIcon from "../ConsoleIcon.vue";
import SnapshotsDialog from "../dialogs/SnapshotsDialog.vue";

// Design: the selection, the active course, its route markers and its cones.
const state = useConsoleState();
const { course, editor, access, mapActions } = state;
const {
  activeCourseId, activeCourse, activeCones, activeConeSideRanks, activeRoute, routeMarkerById,
  hasMarkerRoute, centerline, routeMode, routeError,
} = course;
const { selectedConeId, multiSelectedIds, rotating } = editor;

const SIDE_LABEL = Object.fromEntries(SIDES.map((s) => [s.key, s.label]));
const coneName = (cone) => `${SIDE_LABEL[cone.side]} #${activeConeSideRanks.value.get(cone.id) || 0}`;

/* ── New course (empty state) ─────────────────────── */
const newCourseName = ref("");
async function createCourse() {
  const name = newCourseName.value.trim();
  if (name && await course.createCourse(name)) newCourseName.value = "";
}

/* ── Single selection ─────────────────────────────── */
const selectedCone = computed(() => (selectedConeId.value ? activeCones.value.find((c) => c.id === selectedConeId.value) : null));
const editLat = ref("");
const editLng = ref("");
const editSide = ref("left");
// The coordinates at selection: lat/lng are sent only when the operator edited
// them, so a stale form never reverts a move another operator made meanwhile.
let latOrig = "";
let lngOrig = "";
function loadForm(cone) {
  editLat.value = latOrig = cone.lat.toString();
  editLng.value = lngOrig = cone.lng.toString();
  editSide.value = cone.side;
}
watch(selectedConeId, (id) => {
  const cone = activeCones.value.find((c) => c.id === id);
  if (cone) loadForm(cone);
  if (id) nextTick(() => document.querySelector(`[data-cone-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
});
const dirty = computed(() => !!selectedCone.value
  && (editSide.value !== selectedCone.value.side || editLat.value !== latOrig || editLng.value !== lngOrig));

async function saveCone() {
  const id = selectedConeId.value;
  if (!id) return;
  const body = { side: editSide.value };
  if (editLat.value !== latOrig || editLng.value !== lngOrig) {
    const lat = parseFloat(editLat.value);
    const lng = parseFloat(editLng.value);
    if (isNaN(lat) || isNaN(lng)) return;
    body.lat = lat;
    body.lng = lng;
  }
  if (await course.updateCone(id, body)) editor.clearSelection();
}
async function deleteCone(id) {
  if (await course.deleteCone(id) && selectedConeId.value === id) editor.clearSelection();
}
const isStartCone = computed(() => selectedConeId.value != null && activeCourse.value?.start_cone_id === selectedConeId.value);

/* ── Multi selection ──────────────────────────────── */
const rotateInput = ref("");
function applyRotation() {
  const deg = parseFloat(rotateInput.value);
  if (isNaN(deg) || deg === 0) return;
  mapActions.rotateSelectionBy?.(deg);
  rotateInput.value = "";
}
async function deleteSelected() {
  const ids = [...multiSelectedIds.value];
  if (ids.length === 0 || !confirm(`Delete ${ids.length} selected cones?`)) return;
  rotating.value = false;
  await course.deleteCones(ids);
  editor.clearSelection();
}

/* ── Course ───────────────────────────────────────── */
const showSnapshots = ref(false);
const sideCounts = computed(() => {
  const counts = { left: 0, center: 0, right: 0 };
  for (const c of activeCones.value) counts[c.side] = (counts[c.side] || 0) + 1;
  return counts;
});
const ROUTE_MODE_LABEL = {
  [ROUTE_MODE.AUTO]: "Auto centerline",
  [ROUTE_MODE.ORIENTED]: "Marker-oriented",
  [ROUTE_MODE.GUIDED]: "Marker route",
};
const centerlineText = computed(() => {
  if (activeCones.value.length < 6) return "Centerline needs 6 or more cones";
  if (!centerline.value?.ok) return "No centerline";
  return `${Math.round(centerline.value.length)} m · ${ROUTE_MODE_LABEL[routeMode.value] || ROUTE_MODE_LABEL[ROUTE_MODE.AUTO]}`;
});

async function deleteRouteMarker(marker) {
  if (!confirm(`Delete route marker "${marker.label || marker.id}" and all of its visits?`)) return;
  await course.deleteRouteMarker(marker);
}

/* ── Cones ────────────────────────────────────────── */
const coneFilter = ref("all");
watch(activeCourseId, () => { coneFilter.value = "all"; });
const filteredCones = computed(() => (coneFilter.value === "all" ? activeCones.value : activeCones.value.filter((c) => c.side === coneFilter.value)));
async function deleteAllCones() {
  const count = activeCones.value.length;
  if (count === 0 || !confirm(`Delete all ${count} cones in this course? Undo brings them back.`)) return;
  rotating.value = false;
  if (await course.deleteAllCones()) editor.clearSelection();
}
</script>

<template>
  <div class="design" data-testid="design-panel">
    <section v-if="!activeCourse" class="ck-section">
      <div class="ck-empty"><strong>No course selected</strong></div>
      <form class="ck-row" @submit.prevent="createCourse">
        <input v-model="newCourseName" class="ck-input ck-grow" placeholder="New course name" maxlength="100" aria-label="New course name" />
        <button class="ck-btn primary" type="submit" :disabled="!newCourseName.trim()">Create</button>
      </form>
    </section>

    <template v-else>
      <!-- Selection -->
      <section v-if="selectedCone" class="ck-section selection" data-testid="selection">
        <div class="ck-section-head">
          <h3 class="selection-title"><span :class="['ck-side', selectedCone.side]">{{ coneName(selectedCone) }}</span></h3>
          <button class="ck-btn quiet icon" aria-label="Clear the selection" title="Clear the selection (Esc)" @click="editor.clearSelection()"><ConsoleIcon name="close" :size="16" /></button>
        </div>
        <div class="ck-stack">
          <div class="ck-seg sides" role="radiogroup" aria-label="Side">
            <button v-for="s in SIDES" :key="s.key" role="radio" :aria-checked="editSide === s.key"
              :class="['ck-seg-btn', { active: editSide === s.key }]" @click="editSide = s.key">{{ s.label }}</button>
          </div>
          <div class="coords">
            <label class="ck-field">Latitude<input v-model="editLat" class="ck-input mono" type="number" step="any" /></label>
            <label class="ck-field">Longitude<input v-model="editLng" class="ck-input mono" type="number" step="any" /></label>
          </div>
          <p v-if="selectedCone.alt != null" class="ck-hint">Altitude {{ formatAlt(selectedCone.alt) }} m (RTK, read-only)</p>
          <div class="ck-row wrap">
            <button class="ck-btn primary" :disabled="!dirty" @click="saveCone">Save</button>
            <button class="ck-btn danger" @click="deleteCone(selectedCone.id)"><ConsoleIcon name="trash" :size="15" />Delete</button>
            <button
              v-if="!hasMarkerRoute" :class="['ck-btn', { active: isStartCone }]" :aria-pressed="isStartCone"
              title="The centerline starts at the point nearest this cone"
              @click="course.toggleStartCone(selectedCone.id)"
            >{{ isStartCone ? "Start cone ✓" : "Set as start" }}</button>
          </div>
        </div>
      </section>

      <section v-else-if="multiSelectedIds.size > 0" class="ck-section selection" data-testid="selection">
        <div class="ck-section-head">
          <h3 class="selection-title">{{ multiSelectedIds.size }} cones selected</h3>
          <button class="ck-btn quiet icon" aria-label="Clear the selection" title="Clear the selection (Esc)" @click="editor.clearSelection()"><ConsoleIcon name="close" :size="16" /></button>
        </div>
        <div class="ck-row wrap">
          <button
            :class="['ck-btn', { active: rotating }]" :aria-pressed="rotating" :disabled="multiSelectedIds.size < 2"
            title="Turn the selection with the handle on the map; hold Shift for 5° steps" @click="rotating = !rotating"
          >
            <ConsoleIcon name="rotate" :size="15" />{{ rotating ? "Stop rotating" : "Rotate" }}
          </button>
          <button class="ck-btn danger" @click="deleteSelected"><ConsoleIcon name="trash" :size="15" />Delete</button>
        </div>
        <form v-if="rotating" class="ck-row rotate-exact" @submit.prevent="applyRotation">
          <label class="ck-field ck-grow">Exact angle (°, clockwise)
            <input v-model="rotateInput" class="ck-input" type="number" step="any" placeholder="e.g. 90" />
          </label>
          <button class="ck-btn" type="submit">Apply</button>
        </form>
      </section>

      <!-- Course -->
      <section class="ck-section">
        <div class="ck-section-head">
          <h3 class="course-title">{{ activeCourse.name }}</h3>
          <div class="ck-row">
            <button v-if="access.canManageCourse.value" class="ck-btn quiet" title="Saved versions of this course's cones" @click="showSnapshots = true"><ConsoleIcon name="snapshot" :size="15" />Snapshots</button>
          </div>
        </div>
        <div class="stats">
          <span><strong>{{ activeCones.length }}</strong> cones</span>
          <span class="ck-side left">L {{ sideCounts.left }}</span>
          <span class="ck-side center">C {{ sideCounts.center }}</span>
          <span class="ck-side right">R {{ sideCounts.right }}</span>
        </div>
        <p class="ck-hint centerline-line">{{ centerlineText }}</p>
      </section>

      <!-- Route markers -->
      <details class="ck-section route" :open="activeRoute.markers.length > 0">
        <summary class="ck-section-head">
          <span class="ck-section-title">Route markers <span class="count">{{ activeRoute.markers.length }}</span></span>
          <button class="ck-btn quiet" :class="{ active: editor.tool.value === 'marker' }" @click.prevent="editor.setTool('marker')"><ConsoleIcon name="marker" :size="15" />Place</button>
        </summary>
        <p class="ck-hint">With two or more visits, the centerline follows the visit order. One marker can be visited more than once.</p>
        <p v-if="routeError" class="route-error">{{ routeError }}</p>
        <div v-for="(marker, i) in activeRoute.markers" :key="marker.id" class="ck-row marker-row">
          <span class="marker-index">M{{ i + 1 }}</span>
          <input :value="marker.label" class="ck-input ck-grow" maxlength="50" aria-label="Route marker name" @change="course.updateRouteMarker(marker, { label: $event.target.value })" />
          <button class="ck-btn quiet icon" title="Add a visit at the end" aria-label="Add a visit" @click="course.appendRouteVisit(marker.id)"><ConsoleIcon name="plus" :size="15" /></button>
          <button class="ck-btn quiet icon" title="Delete the marker and its visits" aria-label="Delete the marker" @click="deleteRouteMarker(marker)"><ConsoleIcon name="trash" :size="15" /></button>
        </div>
        <ol v-if="activeRoute.steps.length" class="steps">
          <li v-for="(markerId, index) in activeRoute.steps" :key="`${index}-${markerId}`" class="ck-row step-row">
            <span class="step-rank">{{ index + 1 }}</span>
            <span class="ck-grow">{{ routeMarkerById.get(markerId)?.label || `M${markerId}` }}</span>
            <button class="ck-btn quiet icon" :disabled="index === 0" aria-label="Move earlier" @click="course.moveRouteVisit(index, -1)">↑</button>
            <button class="ck-btn quiet icon" :disabled="index === activeRoute.steps.length - 1" aria-label="Move later" @click="course.moveRouteVisit(index, 1)">↓</button>
            <button class="ck-btn quiet icon" aria-label="Delete this visit" @click="course.removeRouteVisit(index)"><ConsoleIcon name="close" :size="14" /></button>
          </li>
        </ol>
        <div v-if="activeRoute.steps.length" class="ck-row end">
          <button class="ck-btn quiet" @click="course.saveRouteSteps([])">Clear visits</button>
        </div>
      </details>

      <!-- Cones -->
      <section class="ck-section cones">
        <div class="ck-section-head">
          <span class="ck-section-title">Cones</span>
          <div class="ck-seg" role="radiogroup" aria-label="Filter cones by side">
            <button role="radio" :aria-checked="coneFilter === 'all'" :class="['ck-seg-btn', { active: coneFilter === 'all' }]" @click="coneFilter = 'all'">All</button>
            <button v-for="s in SIDES" :key="s.key" role="radio" :aria-checked="coneFilter === s.key"
              :class="['ck-seg-btn', { active: coneFilter === s.key }]" :title="s.label" @click="coneFilter = s.key">{{ s.short }}</button>
          </div>
        </div>
        <div v-if="filteredCones.length === 0" class="ck-empty">
          <template v-if="activeCones.length === 0">No cones yet.</template>
          <template v-else>No {{ SIDE_LABEL[coneFilter]?.toLowerCase() }} cones.</template>
        </div>
        <ul v-else class="cone-list">
          <li
            v-for="cone in filteredCones" :key="cone.id" :data-cone-id="cone.id"
            :class="['cone-row', { selected: selectedConeId === cone.id || multiSelectedIds.has(cone.id) }]"
            data-testid="cone-row" @click="mapActions.panToCone?.(cone)"
          >
            <span :class="['ck-side', cone.side, 'cone-name']">{{ coneName(cone) }}</span>
            <span class="cone-coords">{{ formatLatLng(cone.lat, cone.lng) }}</span>
            <button class="ck-btn quiet icon cone-del" :aria-label="`Delete ${coneName(cone)}`" title="Delete (undo with Ctrl+Z)" @click.stop="deleteCone(cone.id)"><ConsoleIcon name="close" :size="14" /></button>
          </li>
        </ul>
        <div v-if="activeCones.length > 0" class="ck-row end">
          <button class="ck-btn quiet danger-text" @click="deleteAllCones">Delete all cones</button>
        </div>
      </section>
    </template>

    <SnapshotsDialog v-if="showSnapshots" @close="showSnapshots = false" />
  </div>
</template>

<style scoped>
.selection { background: color-mix(in srgb, var(--accent-primary) 6%, var(--bg-secondary)); }
.selection-title, .course-title { font-size: 1rem; font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sides { align-self: flex-start; }
.coords { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
.coords .ck-input { width: 100%; min-width: 0; }
.mono { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.78rem; }
.rotate-exact { margin-top: 0.6rem; align-items: flex-end; }
.stats { display: flex; gap: 0.9rem; align-items: baseline; font-size: 0.88rem; }
.centerline-line { margin-top: 0.3rem; }
.route summary { list-style: none; cursor: pointer; }
.route summary::-webkit-details-marker { display: none; }
.route:not([open]) summary { margin-bottom: 0; }
.count { margin-left: 0.3rem; color: var(--text-tertiary, var(--text-secondary)); }
.route-error { margin: 0.4rem 0; font-size: 0.8rem; color: var(--accent-danger, #ef4444); }
.marker-row { margin-top: 0.4rem; }
.marker-index, .step-rank { flex: none; width: 2rem; font-family: "JetBrains Mono", monospace; font-size: 0.78rem; color: var(--text-secondary); }
.steps { list-style: none; margin: 0.6rem 0 0; padding: 0; border-top: 1px dashed var(--border-color); }
.step-row { padding: 0.15rem 0; font-size: 0.85rem; }
.end { justify-content: flex-end; margin-top: 0.4rem; }
.cone-list { list-style: none; margin: 0; padding: 0; }
.cone-row {
  display: flex; align-items: center; gap: 0.6rem; min-height: 36px; padding: 0 0.25rem 0 0.5rem;
  border-radius: 8px; cursor: pointer; font-size: 0.85rem;
}
.cone-row:hover { background: var(--bg-hover); }
.cone-row.selected { background: color-mix(in srgb, var(--accent-primary) 12%, transparent); }
.cone-name { flex: none; width: 5.5rem; }
.cone-coords { flex: 1; min-width: 0; font-family: "JetBrains Mono", monospace; font-size: 0.76rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cone-del { opacity: 0.6; }
.cone-row:hover .cone-del { opacity: 1; }
.danger-text { color: var(--accent-danger, #ef4444); }
@media (any-pointer: coarse) {
  .cone-row { min-height: 44px; }
  .cone-del { opacity: 1; }
}
</style>
