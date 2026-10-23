import { computed, ref, watch } from "vue";
import { loadPref, savePref } from "./prefs.mjs";

// Design builds the course, Operate drives the rover, Review replays missions.
export const MODES = [
  { key: "design", label: "Design", icon: "design" },
  { key: "operate", label: "Operate", icon: "operate", rover: true },
  { key: "review", label: "Review", icon: "review", rover: true },
];

// Map tools. Select is the default and the tool every load starts in: a tap
// selects, a drag pans, and nothing on the map changes.
export const TOOLS = {
  select: { label: "Select", key: "v", icon: "select" },
  add: { label: "Add cones", key: "a", icon: "add", edit: true },
  move: { label: "Move cones", key: "m", icon: "move", edit: true, tip: "dragging a selected cone moves the whole selection" },
  area: { label: "Select area", key: "b", icon: "area", tip: "tap a cone to add or remove it" },
  marker: { label: "Route markers", key: "k", icon: "marker", edit: true, tip: "tap a marker to add another visit" },
  memo: { label: "Memo", key: "t", icon: "memo", edit: true },
  ruler: { label: "Measure distance", key: "r", icon: "ruler" },
  angle: { label: "Measure angle", key: "n", icon: "angle", tip: "the second point is the vertex" },
};
export const MODE_TOOLS = {
  design: ["select", "add", "move", "area", "marker", "memo", "ruler", "angle"],
  operate: ["select", "ruler", "angle"],
  review: ["select", "ruler", "angle"],
};

export const SIDES = [
  { key: "left", label: "Left", short: "L", hotkey: "1" },
  { key: "center", label: "Center", short: "C", hotkey: "2" },
  { key: "right", label: "Right", short: "R", hotkey: "3" },
];

// What the operator is doing in the console: the mode, the map tool, the
// selection, open panels, and per-browser view preferences.
export function createEditorStore({ access }) {
  const storedMode = loadPref("mode", "design");
  const mode = ref(MODES.some((m) => m.key === storedMode) ? storedMode : "design");
  // Without rover access only Design exists.
  const modes = computed(() => MODES.filter((m) => !m.rover || access.canOperateRover.value));
  watch(modes, (list) => {
    if (!list.some((m) => m.key === mode.value)) mode.value = "design";
  }, { immediate: true });
  watch(mode, (v) => savePref("mode", v));

  const tool = ref("select");
  const side = ref("left");
  watch(mode, (next) => {
    if (!MODE_TOOLS[next].includes(tool.value)) tool.value = "select";
  });
  function setTool(next) {
    tool.value = tool.value === next && next !== "select" ? "select" : next;
  }

  const selectedConeId = ref(null);
  const multiSelectedIds = ref(new Set());
  // Spinning the multi-selection around its centroid with the on-map handle.
  const rotating = ref(false);
  const hasSelection = computed(() => selectedConeId.value != null || multiSelectedIds.value.size > 0);
  function clearSelection() {
    rotating.value = false;
    selectedConeId.value = null;
    multiSelectedIds.value = new Set();
  }
  function selectCone(id) {
    rotating.value = false;
    multiSelectedIds.value = new Set();
    selectedConeId.value = id;
  }
  function toggleInSelection(id) {
    const next = new Set(multiSelectedIds.value);
    if (selectedConeId.value != null) next.add(selectedConeId.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedConeId.value = null;
    multiSelectedIds.value = next;
    if (next.size < 2) rotating.value = false;
  }

  const showCenterline = ref(loadPref("showCenterline", true, (v) => v === "true"));
  watch(showCenterline, (v) => savePref("showCenterline", v));
  // 90° steps, shared by every mode (one map).
  const mapBearing = ref(((Number(loadPref("mapBearing", 0, Number)) % 360) + 360) % 360);
  watch(mapBearing, (v) => savePref("mapBearing", v));
  // The map follows at most one device.
  const followRover = ref(loadPref("followRover", false, (v) => v === "true"));
  const followReceiver = ref(loadPref("followReceiver", false, (v) => v === "true"));
  watch(followRover, (v) => { savePref("followRover", v); if (v) followReceiver.value = false; });
  watch(followReceiver, (v) => { savePref("followReceiver", v); if (v) followRover.value = false; });

  const inspectorWidth = ref(Math.max(300, Math.min(Number(loadPref("inspectorWidth", 360, Number)), 600)));
  watch(inspectorWidth, (v) => savePref("inspectorWidth", v));
  const isMobile = ref(false);
  // Pixels of the map hidden under the mobile bottom sheet (0 on desktop).
  const mapCover = ref(0);
  // The device drawer: null, "rover" or "gps".
  const drawer = ref(null);
  const reviewView = ref(loadPref("reviewView", "missions") === "logs" ? "logs" : "missions");
  watch(reviewView, (v) => savePref("reviewView", v));
  const selectedSurveyPointId = ref(null);

  return {
    mode, modes, tool, side, setTool,
    selectedConeId, multiSelectedIds, rotating, hasSelection, clearSelection, selectCone, toggleInSelection,
    showCenterline, mapBearing, followRover, followReceiver,
    inspectorWidth, isMobile, mapCover, drawer, reviewView, selectedSurveyPointId,
  };
}
