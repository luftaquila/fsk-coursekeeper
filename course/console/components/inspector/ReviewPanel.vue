<script setup>
import { computed, ref } from "vue";
import { formatLogTime, formatMissionDuration, formatMissionTimestamp, formatSnapshotTime } from "../../lib/console-format.mjs";
import { MISSION_STATUS_COLOR, MISSION_STATUS_LABEL } from "../../state/review-store.mjs";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleIcon from "../ConsoleIcon.vue";
import LogsDialog from "../dialogs/LogsDialog.vue";

// Review: the rover's recorded missions (replayed on the map) and its logs.
const { host, review, editor } = useConsoleState();
const {
  missions, missionTotal, selectedMissionId, missionLoading, missionLoadingMore,
  logEntries, logsNewestFirstTrimmed, logUploadedAt, logFetching,
} = review;
const { reviewView } = editor;
const configured = computed(() => host.devices.selected("rover") != null);
const showLogs = ref(false);

function showLogsView() {
  reviewView.value = "logs";
  if (logEntries.value.length === 0) review.refreshLogs();
}
</script>

<template>
  <div class="review" data-testid="review-panel">
    <section v-if="!configured" class="ck-section">
      <div class="ck-empty">
        <strong>No rover is set up</strong>
        Mission records and logs come from the rover. Add its address in the console settings.
      </div>
    </section>

    <template v-else>
      <section class="ck-section tabs">
        <div class="ck-seg" role="tablist" aria-label="Records">
          <button role="tab" :aria-selected="reviewView === 'missions'" :class="['ck-seg-btn', { active: reviewView === 'missions' }]" @click="reviewView = 'missions'">Missions</button>
          <button role="tab" :aria-selected="reviewView === 'logs'" :class="['ck-seg-btn', { active: reviewView === 'logs' }]" @click="showLogsView">Rover logs</button>
        </div>
      </section>

      <section v-if="reviewView === 'missions'" class="ck-section">
        <div v-if="missionLoading" class="ck-empty">Loading…</div>
        <div v-else-if="missions.length === 0" class="ck-empty">No recorded missions yet.</div>
        <ul v-else class="mission-list">
          <li v-for="m in missions" :key="m.id">
            <button :class="['mission', { selected: selectedMissionId === m.id }]" :aria-pressed="selectedMissionId === m.id" @click="review.selectMission(m.id)">
              <span class="ck-row">
                <strong>#{{ m.id }}</strong>
                <span class="ck-grow mission-course">{{ m.course_name || "" }}</span>
                <span class="status" :style="{ background: MISSION_STATUS_COLOR[m.status] }">{{ MISSION_STATUS_LABEL[m.status] || m.status }}</span>
              </span>
              <span class="mission-meta">{{ formatMissionTimestamp(m.started_at) }} · {{ formatMissionDuration(m.started_at, m.ended_at) }} · {{ m.sample_count }} samples</span>
            </button>
          </li>
        </ul>
        <button v-if="missions.length < missionTotal" class="ck-btn block more" :disabled="missionLoadingMore" @click="review.loadMoreMissions()">
          {{ missionLoadingMore ? "Loading…" : `Load more (${missions.length} of ${missionTotal})` }}
        </button>
      </section>

      <section v-else class="ck-section">
        <div class="ck-row wrap">
          <button class="ck-btn primary" :disabled="logFetching" title="Ask the rover to upload its latest log buffer" @click="review.requestLogs()">
            {{ logFetching ? "Fetching…" : "Fetch from rover" }}
          </button>
          <button class="ck-btn" @click="review.refreshLogs()">Reload</button>
          <button class="ck-btn quiet icon" :disabled="logEntries.length === 0" title="Download" aria-label="Download the logs" @click="review.downloadLogs()"><ConsoleIcon name="download" :size="16" /></button>
          <button class="ck-btn quiet" :disabled="logEntries.length === 0" @click="showLogs = true">View all</button>
        </div>
        <p class="ck-hint logs-meta">
          {{ logEntries.length }} lines<template v-if="logUploadedAt"> · uploaded {{ formatSnapshotTime(logUploadedAt) }}</template>
        </p>
        <div v-if="logEntries.length === 0" class="ck-empty">No uploaded logs.</div>
        <ul v-else class="log-list">
          <li v-for="(e, i) in logsNewestFirstTrimmed" :key="i" :class="['log', `log-${(e.level || '').toLowerCase()}`]">
            <span class="log-time">{{ formatLogTime(e.t) }}</span>
            <span class="log-level">{{ e.level }}</span>
            <span class="log-msg">{{ e.msg }}</span>
          </li>
        </ul>
      </section>
    </template>

    <LogsDialog v-if="showLogs" @close="showLogs = false" />
  </div>
</template>

<style scoped>
.tabs { padding-bottom: 0.6rem; }
.mission-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.mission {
  width: 100%; display: flex; flex-direction: column; gap: 0.2rem; text-align: left;
  padding: 0.55rem 0.7rem; border: 1px solid var(--border-color); border-radius: 10px;
  background: var(--bg-secondary); color: var(--text-primary); font: inherit; cursor: pointer;
}
.mission:hover { background: var(--bg-hover); }
.mission.selected { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-secondary)); }
.mission-course { font-size: 0.85rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { padding: 0.05rem 0.5rem; border-radius: 999px; color: #fff; font-size: 0.72rem; font-weight: 700; }
.mission-meta { font-size: 0.75rem; color: var(--text-secondary); }
.more { margin-top: 0.5rem; }
.logs-meta { margin: 0.5rem 0; }
.log-list { list-style: none; margin: 0; padding: 0; font-family: "JetBrains Mono", monospace; font-size: 0.72rem; }
.log { display: grid; grid-template-columns: auto auto 1fr; gap: 0.5rem; padding: 0.2rem 0; border-bottom: 1px solid var(--border-color); }
.log-time { color: var(--text-secondary); white-space: nowrap; }
.log-level { font-weight: 700; }
.log-msg { overflow-wrap: anywhere; }
.log-warn .log-level { color: #d97706; }
.log-error .log-level, .log-fatal .log-level { color: #dc2626; }
@media (max-width: 768px) {
  .log { grid-template-columns: auto 1fr; }
  .log-msg { grid-column: 1 / -1; }
}
</style>
