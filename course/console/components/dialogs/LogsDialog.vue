<script setup>
import { formatLogTime, formatSnapshotTime } from "../../lib/console-format.mjs";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleDialog from "../ui/ConsoleDialog.vue";

// Every uploaded rover log line, newest first.
const emit = defineEmits(["close"]);
const { review } = useConsoleState();
const { logEntries, logsNewestFirst, logUploadedAt, logFetching } = review;
</script>

<template>
  <ConsoleDialog title="Rover logs" width="980px" @close="emit('close')">
    <div class="ck-row wrap toolbar">
      <button class="ck-btn primary" :disabled="logFetching" @click="review.requestLogs()">{{ logFetching ? "Fetching…" : "Fetch from rover" }}</button>
      <button class="ck-btn" @click="review.refreshLogs()">Reload</button>
      <button class="ck-btn" :disabled="logEntries.length === 0" @click="review.downloadLogs()">Download</button>
      <span class="ck-hint">{{ logEntries.length }} lines<template v-if="logUploadedAt"> · uploaded {{ formatSnapshotTime(logUploadedAt) }}</template></span>
    </div>
    <div v-if="logEntries.length === 0" class="ck-empty">No uploaded logs.</div>
    <div v-else class="logs">
      <div v-for="(e, i) in logsNewestFirst" :key="i" :class="['log', `log-${(e.level || '').toLowerCase()}`]">
        <span class="log-time">{{ formatLogTime(e.t) }}</span>
        <span class="log-level">{{ e.level }}</span>
        <span class="log-node">{{ e.node }}</span>
        <span class="log-msg">{{ e.msg }}</span>
      </div>
    </div>
  </ConsoleDialog>
</template>

<style scoped>
.toolbar { margin-bottom: 0.6rem; }
.logs { font-family: "JetBrains Mono", monospace; font-size: 0.75rem; }
.log { display: grid; grid-template-columns: auto auto 8rem 1fr; gap: 0.6rem; padding: 0.2rem 0; border-bottom: 1px solid var(--border-color); }
.log-time, .log-node { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.log-level { font-weight: 700; }
.log-msg { overflow-wrap: anywhere; }
.log-warn .log-level { color: #d97706; }
.log-error .log-level, .log-fatal .log-level { color: #dc2626; }
@media (max-width: 768px) {
  .log { grid-template-columns: auto auto 1fr; }
  .log-msg { grid-column: 1 / -1; }
}
</style>
