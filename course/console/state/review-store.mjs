import { computed, onScopeDispose, ref } from "vue";
import { formatLogTime, formatMissionTimestamp } from "../lib/console-format.mjs";

export const MISSION_STATUS_LABEL = { running: "Running", paused: "Paused", interrupted: "Interrupted", completed: "Completed", stopped: "Stopped", error: "Error" };
export const MISSION_STATUS_COLOR = { running: "#3b82f6", paused: "#a855f7", interrupted: "#f97316", completed: "#22c55e", stopped: "#f59e0b", error: "#ef4444" };

const MISSION_PAGE = 50;

// The rover's mission records with telemetry replay, and its uploaded logs.
export function createReviewStore({ notify, rover }) {
  const { error: notifyError } = notify;
  const request = rover.request;

  const missions = ref([]);
  const missionTotal = ref(0);
  const selectedMissionId = ref(null);
  const missionDetail = ref(null);
  const missionSamples = ref([]);
  const missionLoading = ref(false);
  const missionLoadingMore = ref(false);

  async function loadMissions() {
    missionLoading.value = true;
    try {
      const res = await request(`/api/missions?limit=${MISSION_PAGE}&offset=0`);
      const data = await res.json();
      missions.value = data.missions || [];
      missionTotal.value = data.total || 0;
    } catch (err) { notifyError(err.message); }
    finally { missionLoading.value = false; }
  }

  async function loadMoreMissions() {
    if (missionLoadingMore.value || missions.value.length >= missionTotal.value) return;
    missionLoadingMore.value = true;
    try {
      const res = await request(`/api/missions?limit=${MISSION_PAGE}&offset=${missions.value.length}`);
      const data = await res.json();
      missions.value = [...missions.value, ...(data.missions || [])];
      missionTotal.value = data.total || missions.value.length;
    } catch (err) { notifyError(err.message); }
    finally { missionLoadingMore.value = false; }
  }

  async function selectMission(id) {
    if (selectedMissionId.value === id) return;
    selectedMissionId.value = id;
    stopReplay();
    try {
      const [d, t] = await Promise.all([
        request(`/api/missions/${id}`).then((r) => r.json()),
        request(`/api/missions/${id}/telemetry`).then((r) => r.json()),
      ]);
      missionDetail.value = d;
      missionSamples.value = t.samples || [];
      replayIdx.value = 0;
    } catch (err) { notifyError(err.message); }
  }

  function clearSelection() {
    stopReplay();
    selectedMissionId.value = null;
    missionDetail.value = null;
    missionSamples.value = [];
  }

  /* ── Replay ───────────────────────────────────────── */
  const replayPlaying = ref(false);
  const replayIdx = ref(0);
  const replaySpeed = ref(1);
  let playTimer = null;

  function scheduleReplayStep() {
    const i = replayIdx.value;
    if (i >= missionSamples.value.length - 1) { stopReplay(); return; }
    const dt = Math.max(0, (missionSamples.value[i + 1].t || 0) - (missionSamples.value[i].t || 0));
    const interval = Math.max(16, Math.min(2000, dt / Math.max(1, replaySpeed.value)));
    playTimer = setTimeout(() => {
      if (!replayPlaying.value) return;
      replayIdx.value = Math.min(missionSamples.value.length - 1, replayIdx.value + 1);
      scheduleReplayStep();
    }, interval);
  }
  function startReplay() {
    if (missionSamples.value.length === 0) return;
    if (replayIdx.value >= missionSamples.value.length - 1) replayIdx.value = 0;
    replayPlaying.value = true;
    scheduleReplayStep();
  }
  function stopReplay() {
    replayPlaying.value = false;
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
  }
  function togglePlay() { if (replayPlaying.value) stopReplay(); else startReplay(); }

  const currentSample = computed(() => missionSamples.value[replayIdx.value] || null);
  const currentSampleTime = computed(() => (currentSample.value ? formatMissionTimestamp(currentSample.value.t) : "—"));
  const currentSampleState = computed(() => currentSample.value?.nav_state || "—");
  const currentSampleFix = computed(() => currentSample.value?.fix_status || "—");

  /* ── Rover logs ───────────────────────────────────── */
  const logEntries = ref([]);
  // The ROS log buffer arrives oldest-first; panels show the most recent first.
  const logsNewestFirst = computed(() => [...logEntries.value].reverse());
  const logsNewestFirstTrimmed = computed(() => [...logEntries.value].slice(-50).reverse());
  const logUploadedAt = ref(0);
  const logFetching = ref(false);

  async function refreshLogs() {
    try {
      const res = await request("/api/rover/logs");
      const data = await res.json();
      logEntries.value = data.entries || [];
      logUploadedAt.value = data.uploaded_at || 0;
    } catch (err) { notifyError(err.message); }
  }

  async function requestLogs() {
    logFetching.value = true;
    try {
      await request("/api/rover/logs/fetch", { method: "POST" });
      // Wait briefly for the rover to upload, then refresh.
      setTimeout(async () => {
        await refreshLogs();
        logFetching.value = false;
      }, 1500);
    } catch (err) {
      logFetching.value = false;
      notifyError(err.message);
    }
  }

  function downloadLogs() {
    const text = logEntries.value
      .map((e) => `${formatLogTime(e.t)} [${e.level}] [${e.node}] ${e.msg}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `rover-log-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  onScopeDispose(stopReplay);

  return {
    missions, missionTotal, selectedMissionId, missionDetail, missionSamples, missionLoading, missionLoadingMore,
    loadMissions, loadMoreMissions, selectMission, clearSelection,
    replayPlaying, replayIdx, replaySpeed, togglePlay, stopReplay,
    currentSample, currentSampleTime, currentSampleState, currentSampleFix,
    logEntries, logsNewestFirst, logsNewestFirstTrimmed, logUploadedAt, logFetching,
    refreshLogs, requestLogs, downloadLogs,
  };
}
