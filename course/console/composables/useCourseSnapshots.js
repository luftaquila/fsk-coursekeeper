import { ref } from "vue";

// Course cone-set snapshots (create / list / restore / delete). Restore relies on the server's `cones` SSE broadcast to refresh the
// map, so this only orchestrates the API + modal state. Deps:
//   activeCourseId  the course whose snapshots we manage (ref)
//   notifyError     toast on failure
export function useCourseSnapshots({ request, activeCourseId, notifyError }) {
  const showSnapshots = ref(false);
  const snapshotList = ref([]);
  const snapshotReason = ref("");

  async function openSnapshots() {
    if (!activeCourseId.value) return;
    snapshotReason.value = "";
    showSnapshots.value = true;
    await loadSnapshots();
  }

  async function loadSnapshots() {
    if (!activeCourseId.value) return;
    try {
      const res = await request(`/api/courses/${activeCourseId.value}/snapshots`);
      const data = await res.json();
      snapshotList.value = data.snapshots || [];
    } catch (err) { notifyError(err.message); }
  }

  async function createSnapshot() {
    if (!activeCourseId.value) return;
    try {
      await request(`/api/courses/${activeCourseId.value}/snapshots`, {
        method: "POST",
        body: JSON.stringify({ reason: snapshotReason.value || null }),
      });
      snapshotReason.value = "";
      await loadSnapshots();
    } catch (err) { notifyError(err.message); }
  }

  async function restoreSnapshot(sid) {
    if (!activeCourseId.value) return;
    if (!confirm("This clears all current cones and restores this snapshot. Continue?\n(The current state is snapshotted automatically before restoring.)")) return;
    try {
      await request(`/api/courses/${activeCourseId.value}/snapshots/${sid}/restore`, { method: "POST" });
      await loadSnapshots();
      showSnapshots.value = false;
    } catch (err) { notifyError(err.message); }
  }

  async function deleteSnapshot(sid) {
    if (!activeCourseId.value) return;
    if (!confirm("Delete this snapshot?")) return;
    try {
      await request(`/api/courses/${activeCourseId.value}/snapshots/${sid}`, { method: "DELETE" });
      await loadSnapshots();
    } catch (err) { notifyError(err.message); }
  }

  return { showSnapshots, snapshotList, snapshotReason, openSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot };
}
