<script setup>
import { onMounted } from "vue";
import { useCourseSnapshots } from "../../composables/useCourseSnapshots.js";
import { formatSnapshotTime } from "../../lib/console-format.mjs";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleDialog from "../ui/ConsoleDialog.vue";

// Saved versions of the active course's cones: take, restore, delete.
const emit = defineEmits(["close"]);
const state = useConsoleState();
const { course } = state;
const { showSnapshots, snapshotList, snapshotReason, openSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } =
  useCourseSnapshots({ request: course.request, activeCourseId: course.activeCourseId, notifyError: state.notify.error });

onMounted(openSnapshots);

async function restore(id) {
  await restoreSnapshot(id);
  if (!showSnapshots.value) emit("close");
}
</script>

<template>
  <ConsoleDialog :title="`${course.activeCourse.value?.name} snapshots`" width="480px" @close="emit('close')">
    <form class="ck-row take" @submit.prevent="createSnapshot">
      <input v-model="snapshotReason" class="ck-input ck-grow" placeholder="Note (optional)" maxlength="200" aria-label="Snapshot note" />
      <button class="ck-btn primary" type="submit">Take snapshot</button>
    </form>
    <div v-if="snapshotList.length === 0" class="ck-empty">No snapshots of this course yet.</div>
    <ul v-else class="snapshots">
      <li v-for="s in snapshotList" :key="s.id" class="snapshot">
        <div class="snapshot-main">
          <div class="ck-row">
            <strong>{{ formatSnapshotTime(s.taken_at) }}</strong>
            <span class="ck-badge">{{ s.cone_count }} cones</span>
          </div>
          <div v-if="s.reason" class="snapshot-reason">{{ s.reason }}</div>
          <div v-if="s.actor" class="ck-hint">{{ s.actor }}</div>
        </div>
        <div class="ck-row">
          <button class="ck-btn" @click="restore(s.id)">Restore</button>
          <button class="ck-btn quiet danger-text" @click="deleteSnapshot(s.id)">Delete</button>
        </div>
      </li>
    </ul>
  </ConsoleDialog>
</template>

<style scoped>
.take { margin-bottom: 0.75rem; }
.snapshots { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.snapshot { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.7rem; border: 1px solid var(--border-color); border-radius: 10px; }
.snapshot-main { flex: 1; min-width: 0; }
.snapshot-reason { margin-top: 0.15rem; font-size: 0.85rem; overflow-wrap: anywhere; }
.danger-text { color: var(--accent-danger, #ef4444); }
</style>
