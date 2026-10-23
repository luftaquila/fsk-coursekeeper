<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useCourseImportExport } from "../../composables/useCourseImportExport.js";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleIcon from "../ConsoleIcon.vue";

// The active course and everything about the course list: switch, create,
// import, rename, show alongside, publish, export, delete.
const state = useConsoleState();
const { host, course, mission, access } = state;
const { error: notifyError } = state.notify;
const { courses, conesMap, memosMap, routeMap, activeCourseId, activeCourse, visibility, centerline, publishingId } = course;

const open = ref(false);
const root = ref(null);
const newCourseName = ref("");
const editingId = ref(null);
const editName = ref("");
const { importInput, exportingId, exportCourse, triggerImport, importCourse } = useCourseImportExport({
  request: course.request, courses, conesMap, memosMap, routeMap, activeCourseId, newCourseName, notifyError,
});

const summary = computed(() => {
  const c = activeCourse.value;
  if (!c) return null;
  const parts = [`${c.cone_count ?? (conesMap.value[c.id] || []).length} cones`];
  if (centerline.value?.ok) parts.push(`${Math.round(centerline.value.length)} m`);
  return parts.join(" · ");
});

function toggle() {
  open.value = !open.value;
}
function onDocPointer(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false;
}
function onKey(e) {
  if (e.key === "Escape" && open.value && !editingId.value) { open.value = false; e.stopPropagation(); }
}
watch(open, (v) => {
  if (v) {
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKey, true);
  } else {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey, true);
    editingId.value = null;
  }
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointer, true);
  document.removeEventListener("keydown", onKey, true);
});

function choose(id) {
  activeCourseId.value = id;
  open.value = false;
}

async function create() {
  const name = newCourseName.value.trim();
  if (!name) return;
  if (await course.createCourse(name)) {
    newCourseName.value = "";
    open.value = false;
  }
}

function startRename(c) {
  editingId.value = c.id;
  editName.value = c.name;
  nextTick(() => root.value?.querySelector(".rename-input")?.select());
}
async function saveRename(id) {
  const name = editName.value.trim();
  if (!name) return;
  if (await course.renameCourse(id, name)) editingId.value = null;
}

async function remove(c) {
  // The rover keeps a copy of the route, but the operator still needs the course
  // while that mission can run.
  if (mission.activeMission.value?.course_id === c.id) {
    notifyError("A course used by an active mission cannot be deleted.");
    return;
  }
  const count = c.cone_count ?? (conesMap.value[c.id] || []).length;
  if (!confirm(`Delete course "${c.name}" with its ${count} cones, memos, route markers, snapshots and mission presets? This cannot be undone.`)) return;
  await course.deleteCourse(c.id);
}

const shown = (c) => c.id === activeCourseId.value || visibility.value[c.id] === true;
</script>

<template>
  <div ref="root" class="switcher" data-testid="course-switcher">
    <button class="switcher-trigger" :aria-expanded="open" aria-haspopup="dialog" @click="toggle">
      <ConsoleIcon name="layers" :size="16" class="layers" />
      <span class="trigger-text">
        <span class="trigger-name">{{ activeCourse ? activeCourse.name : "No course" }}</span>
        <span v-if="summary" class="trigger-meta">{{ summary }}</span>
      </span>
      <ConsoleIcon name="chevron" :size="16" class="chevron" />
    </button>

    <div v-if="open" class="switcher-panel" role="dialog" aria-label="Courses">
      <form class="create" @submit.prevent="create">
        <input v-model="newCourseName" class="ck-input ck-grow" placeholder="New course name" maxlength="100" aria-label="New course name" />
        <button class="ck-btn primary" type="submit" :disabled="!newCourseName.trim()">Create</button>
        <button
          class="ck-btn icon" type="button" :disabled="!newCourseName.trim()" @click="triggerImport"
          :title="newCourseName.trim() ? 'Import a course JSON under this name' : 'Type a name, then import a course JSON under it'"
          aria-label="Import a course JSON"
        ><ConsoleIcon name="upload" :size="16" /></button>
        <input ref="importInput" type="file" accept=".json" hidden @change="importCourse" />
      </form>

      <ul class="course-list">
        <li v-for="c in courses" :key="c.id" :class="['course-row', { active: c.id === activeCourseId }]" data-testid="course-row">
          <template v-if="editingId === c.id">
            <input
              v-model="editName" class="ck-input ck-grow rename-input" aria-label="Course name" maxlength="100"
              @keydown.enter.prevent="saveRename(c.id)" @keydown.esc.stop.prevent="editingId = null"
            />
            <button class="ck-btn primary" @click="saveRename(c.id)">Save</button>
            <button class="ck-btn quiet" @click="editingId = null">Cancel</button>
          </template>
          <template v-else>
            <button class="course-choose" :aria-current="c.id === activeCourseId" @click="choose(c.id)">
              <span class="course-name">{{ c.name }}</span>
              <span class="course-count">{{ c.cone_count }} cones</span>
              <span v-if="host.features.publication && c.is_public" class="ck-badge info">Public</span>
            </button>
            <div class="course-actions">
              <button
                class="ck-btn quiet icon" :disabled="c.id === activeCourseId" :aria-pressed="shown(c)"
                :title="c.id === activeCourseId ? 'The selected course is always shown' : (shown(c) ? 'Hide from the map' : 'Show on the map with the selected course')"
                :aria-label="`Show ${c.name} on the map`" @click="course.toggleVisibility(c.id)"
              ><ConsoleIcon :name="shown(c) ? 'eye' : 'eye-off'" :size="16" /></button>
              <button class="ck-btn quiet icon" title="Rename" :aria-label="`Rename ${c.name}`" @click="startRename(c)"><ConsoleIcon name="edit" :size="16" /></button>
              <button
                class="ck-btn quiet icon" :disabled="exportingId === c.id" :aria-busy="exportingId === c.id"
                title="Export ZIP (Assetto Corsa track, JSON, preview)" :aria-label="`Export ${c.name}`" @click="exportCourse(c.id)"
              ><ConsoleIcon name="download" :size="16" /></button>
              <button
                v-if="access.canManageCourse.value && host.features.publication"
                class="ck-btn quiet" :disabled="publishingId != null" @click="course.togglePublication(c)"
                :title="c.is_public ? 'Remove from the public course page' : 'Show on the public course page'"
              >{{ c.is_public ? "Unpublish" : "Publish" }}</button>
              <button
                v-if="access.canManageCourse.value" class="ck-btn quiet icon danger-icon"
                title="Delete course" :aria-label="`Delete ${c.name}`" @click="remove(c)"
              ><ConsoleIcon name="trash" :size="16" /></button>
            </div>
          </template>
        </li>
        <li v-if="courses.length === 0" class="ck-empty">No courses yet.</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.switcher { position: relative; min-width: 0; }
.switcher-trigger {
  display: flex; align-items: center; gap: 0.5rem; min-width: 0; max-width: 340px;
  height: 40px; padding: 0 0.6rem 0 0.7rem;
  border: 1px solid var(--border-color); border-radius: 10px;
  background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font: inherit;
}
.switcher-trigger:hover { background: var(--bg-hover); }
.trigger-text { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; line-height: 1.15; }
.trigger-name { font-weight: 700; font-size: 0.9rem; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trigger-meta { font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; }
.chevron { color: var(--text-secondary); }

.switcher-panel {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 1200;
  width: min(460px, calc(100vw - 1.5rem)); max-height: min(70dvh, 560px);
  display: flex; flex-direction: column;
  border: 1px solid var(--border-color); border-radius: 12px;
  background: var(--bg-secondary); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.create { display: flex; gap: 0.4rem; padding: 0.75rem; border-bottom: 1px solid var(--border-color); }
.course-list { list-style: none; margin: 0; padding: 0.35rem; overflow-y: auto; }
.course-row { display: flex; align-items: center; gap: 0.25rem; padding: 0.15rem; border-radius: 9px; }
.course-row.active { background: color-mix(in srgb, var(--accent-primary) 10%, transparent); }
.course-choose {
  flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 0.5rem;
  min-height: 38px; padding: 0 0.5rem; border: none; border-radius: 8px;
  background: transparent; color: var(--text-primary); font: inherit; text-align: left; cursor: pointer;
}
.course-choose:hover { background: var(--bg-hover); }
.course-row.active .course-choose { font-weight: 700; }
.course-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.course-count { flex: none; font-size: 0.75rem; color: var(--text-secondary); font-weight: 400; }
.course-actions { display: flex; align-items: center; gap: 0.1rem; flex: none; }
.danger-icon:hover:not(:disabled) { color: var(--accent-danger, #ef4444); }
@media (max-width: 768px) {
  .switcher-trigger { max-width: 100%; gap: 0.3rem; padding: 0 0.4rem 0 0.55rem; }
  .switcher-trigger .layers { display: none; }
  .trigger-text { overflow: hidden; }
  .trigger-name, .trigger-meta { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .switcher-panel { position: fixed; top: 60px; left: 0.75rem; right: 0.75rem; width: auto; }
}
</style>
