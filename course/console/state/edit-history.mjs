import { ref } from "vue";

// Undo stack of {label, undo} entries; each `undo` reverses one edit through
// the API directly, so undoing never re-enters the recording paths (no redo).
// Deleted cones are restored by re-creating them, so they come back with fresh ids.
const MAX_UNDO = 50;

export function createEditHistory({ notifyError }) {
  const stack = ref([]);

  function push(label, undo) {
    stack.value.push({ label, undo });
    if (stack.value.length > MAX_UNDO) stack.value.shift();
  }

  async function undo() {
    const entry = stack.value.pop();
    if (!entry) return;
    try { await entry.undo(); }
    catch (err) { notifyError(`Undo failed: ${err.message}`); }
  }

  // Entries reference cone ids of one course.
  function clear() { stack.value = []; }

  return { stack, push, undo, clear };
}
