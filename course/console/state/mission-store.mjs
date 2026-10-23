import { computed, onScopeDispose, ref, watch } from "vue";
import { haversine } from "../../geo.mjs";
import { optimizeConeRoute } from "../lib/mission-route.mjs";
import {
  buildMissionCreatePayload,
  missionRouteCourseMismatch,
  buildMissionCommandPayload,
  buildMissionPresetDeletePayload,
  buildMissionPresetPayload,
  buildMissionRemainingPayload,
  captureMissionAuthorityFence,
  captureMissionAuthorityRequest,
  captureMissionCreateRouteAuthority,
  mergeMissionSummary,
  missionAbsentSnapshotDecision,
  missionAuthorityFenceMatches,
  missionAuthorityKey,
  missionAuthorityRequestCanApply,
  missionBuilderSubmission,
  missionCommandResponseDecision,
  missionEndAwaitingState,
  missionEndReconcileIsCurrent,
  missionEndReconcileShouldRetry,
  missionEndRequestFailureState,
  missionEndResponseDecision,
  missionCreateRouteAuthorityMatches,
  missionHttpResponseAuthorityDecision,
  missionCommandToken,
  missionCommandTokenAfterSync,
  missionCourseId,
  missionCreateSettlementDecision,
  missionDraftMatches,
  missionDraftToken,
  missionEmptyResumeMode,
  missionMotionConfirmedHeld,
  missionNeedsManualRelease,
  missionPathActionDisabled,
  missionPathGeometry,
  missionPreflightCanConfirm,
  missionPreflightDistanceAllowed,
  missionPreflightRouteCheck,
  missionPreflightTarget,
  missionRestoreDecision,
  missionSnapshotMatchesSummary,
  missionSummaryRefreshDecision,
  splitMissionStatusPayload,
  presetResponseIsCurrent,
  reconcileMissionEndAuthorityRequest,
  shouldAbandonMissionForCourseSwitch,
  shouldConsumeLegacyMissionIndexEvent,
  trackManualControlRequest,
  waitForManualControlDrain,
} from "../lib/mission-session.mjs";
import { ACTIVE_NAV_STATES, BATTERY_WARN_PERCENT, formatDurationSec, isValidRoverPos } from "../lib/rover-ui.mjs";

// The rover's mission session as the console sees it: the planned or server
// route, mission authority and its fences, the preflight check, start / resume /
// pause / end, manual control, and the rover's event stream. The durable mission
// record on the rover is the only lifecycle authority (lib/mission-session.mjs).
export function createMissionStore({ notify, course, rover }) {
  const { success: notifySuccess, error: notifyError, warning: notifyWarn } = notify;
  const { courses, conesMap, activeCourseId, activeCones } = course;
  const courseRequest = course.request;
  const { roverStatus, stopping, emergencyStopLatched, pumpOn } = rover;
  const roverRequest = rover.request;

  const roverMode = ref("none"); // none | path-ready | executing | stopped | manual
  const pathWaypoints = ref([]);
  const missionFinishBehavior = ref("stop");
  const showMissionBuilder = ref(false);
  const missionBuilderItems = ref([]);
  const missionBuilderEditing = ref(false);
  const missionBuilderBusy = ref(false);
  const missionBuilderBase = ref(null);
  const missionPresets = ref([]);
  const missionPresetBusy = ref(false);
  const missionEndBusy = ref(false);
  const missionEndAwaitingAckId = ref(null);
  const missionEndAwaitingCommandId = ref(null);
  let missionEndReconcileTimer = null;
  let missionEndReconcileEpoch = 0;
  const pathPresetReference = ref(null);
  let missionPresetRequestSeq = 0;
  const executedIndex = ref(0);
  const pathProgress = ref(0);
  const manualThrottle = ref(0);
  const manualSteering = ref(0);
  const manualAuthorityReleaseBusy = ref(false);
  let manualFailCount = 0;

  // sprayResults: Map<globalWaypointIdx, { outcome, at }>
  const sprayResults = ref(new Map());
  // Pre-flight checklist modal state
  const showPreflight = ref(false);
  const preflightForce = ref(false);
  const preflightMode = ref("execute"); // "execute" | "resume"
  const preflightRouteAlreadySynced = ref(false);
  const preflightMissionToken = ref(null);
  const preflightMissionDraft = ref(null);
  const preflightAuthorityToken = ref(null);
  const preflightEmptyRouteMode = ref(null);
  // Distance from rover's last reported position to the next-target waypoint.
  // Only meaningful while a mission is actually being driven.
  const currentTargetDistance = computed(() => {
    if (roverMode.value !== "executing") return null;
    const idx = executedIndex.value;
    const lp = roverStatus.value.last_position;
    if (!lp) return null;
    if (pathWaypoints.value.length === 0
        && missionFinishBehavior.value === "return_to_start" && pathStart.value) {
      return haversine(lp, pathStart.value);
    }
    if (idx < 0 || idx >= pathWaypoints.value.length) return null;
    return haversine(lp, pathWaypoints.value[idx]);
  });

  const missionETA = computed(() => {
    if (roverMode.value !== "executing") return null;
    const total = pathMetrics.value.totalDist;
    if (total <= 0) return null;
    const speed = roverStatus.value.gps?.speed;
    if (!speed || speed < 0.05) return null;
    const remaining = total * Math.max(0, (100 - pathProgress.value) / 100);
    return formatDurationSec(remaining / speed);
  });
  const remainingDistanceM = computed(() => {
    if (roverMode.value !== "executing") return null;
    const total = pathMetrics.value.totalDist;
    if (total <= 0) return null;
    return total * Math.max(0, (100 - pathProgress.value) / 100);
  });
  const pathStart = ref(null); // { lat, lng } — preserved across compute/execute/resume for re-rendering
  const pathReturnOrigin = ref(null); // fixed origin for an empty return-only leg; never chase live GPS while rendering
  // Drawn route and its distances: cumDist[i] from the start to waypoint i, total
  // including an explicit return-to-start segment.
  const pathGeometry = computed(() => missionPathGeometry({
    pathStart: pathStart.value,
    waypoints: pathWaypoints.value,
    finishBehavior: missionFinishBehavior.value,
    returnOrigin: pathReturnOrigin.value,
  }));
  const pathMetrics = computed(() => {
    const geometry = pathGeometry.value;
    if (!geometry) return { cumDist: [], totalDist: 0 };
    if (geometry.returnOnly) return { cumDist: [], totalDist: haversine(geometry.points[0], geometry.points[1]) };
    const waypoints = pathWaypoints.value;
    const cumDist = new Array(waypoints.length);
    let acc = haversine(pathStart.value, waypoints[0]);
    cumDist[0] = acc;
    for (let i = 1; i < waypoints.length; i++) {
      acc += haversine(waypoints[i - 1], waypoints[i]);
      cumDist[i] = acc;
    }
    const totalDist = acc + (missionFinishBehavior.value === "return_to_start"
      ? haversine(waypoints[waypoints.length - 1], pathStart.value) : 0);
    return { cumDist, totalDist };
  });
  const pathDistance = computed(() => pathMetrics.value.totalDist);
  let executionStartIdx = 0; // global waypoint index the current execute/resume call started from
  let displayedMissionId = null;
  let displayedMissionAuthorityKey = null;
  let pathMissionBase = null;
  let localMissionCreatePending = false;
  let localMissionRouteGeneration = 0;
  let localMissionCreateRequestSeq = 0;
  let roverStatusMissionRequestSeq = 0;
  let activeMissionSnapshotRequestSeq = 0;
  let activeMissionSnapshotRequestKey = null;
  let missionMutationRequestSeq = 0;
  let missionAuthorityGeneration = 0;
  const activeMissionAuthority = ref(null);
  let observedMissionAuthorityKey = missionAuthorityKey(null);
  const terminalMissionIds = new Set();
  let controlInterval = null;
  const pendingManualControlRequests = new Set();
  const activeMission = computed(() => roverStatus.value.active_mission || null);
  const missionHeld = computed(() => missionMotionConfirmedHeld(activeMissionAuthority.value));

  function rememberTerminalMission(id) {
    if (!Number.isInteger(id)) return;
    terminalMissionIds.add(id);
    if (terminalMissionIds.size > 128) terminalMissionIds.delete(terminalMissionIds.values().next().value);
  }

  function observeMissionAuthority(mission, { advanceAuthority = true } = {}) {
    const nextKey = missionAuthorityKey(mission);
    if (nextKey == null) return false;
    if (advanceAuthority && nextKey !== observedMissionAuthorityKey) missionAuthorityGeneration += 1;
    activeMissionAuthority.value = mission;
    observedMissionAuthorityKey = nextKey;
    const awaiting = missionEndAwaitingState({
      awaitingMissionId: missionEndAwaitingAckId.value,
      awaitingCommandId: missionEndAwaitingCommandId.value,
      authorityMission: mission,
    });
    missionEndAwaitingAckId.value = awaiting.missionId;
    missionEndAwaitingCommandId.value = awaiting.commandId;
    return true;
  }

  function beginMissionAuthorityRequest(mission = activeMissionAuthority.value) {
    const token = captureMissionAuthorityRequest({
      requestId: ++missionMutationRequestSeq,
      authorityGeneration: missionAuthorityGeneration,
      mission,
    });
    if (!token) {
      throw Object.assign(new Error("Cannot confirm the current mission authority. Reload the latest state."), {
        reason: "mission_authority_unavailable",
      });
    }
    return token;
  }

  function missionAuthorityRequestIsCurrent(token) {
    return missionAuthorityRequestCanApply({
      token,
      latestRequestId: missionMutationRequestSeq,
      currentAuthorityGeneration: missionAuthorityGeneration,
      currentMission: activeMissionAuthority.value,
    });
  }

  function missionAuthorityFenceIsCurrent(token) {
    return missionAuthorityFenceMatches({
      token,
      currentAuthorityGeneration: missionAuthorityGeneration,
      currentMission: activeMissionAuthority.value,
    });
  }

  function currentMissionAuthorityFence(mission = activeMissionAuthority.value) {
    return captureMissionAuthorityFence({
      authorityGeneration: missionAuthorityGeneration,
      mission,
    });
  }

  function resolveMissionHttpSnapshot(responseMission, token, options = {}) {
    const decision = missionHttpResponseAuthorityDecision({
      token,
      latestRequestId: missionMutationRequestSeq,
      currentAuthorityGeneration: missionAuthorityGeneration,
      currentMission: activeMissionAuthority.value,
      responseMission,
      terminalMissionIds,
    });
    if (decision.installResponse) {
      installActiveMissionSnapshot(responseMission, options);
      return responseMission;
    }
    if (decision.responseMatchesCurrent
        && missionAuthorityKey(activeMission.value) === missionAuthorityKey(responseMission)) {
      return activeMission.value;
    }
    reconcileRoverMode(roverStatus.value);
    return null;
  }

  function missionAuthorityAdvancedError(token) {
    return Object.assign(new Error("The mission changed during the request. Check the latest state."), {
      reason: "mission_authority_advanced",
      missionAuthorityRequestToken: token,
    });
  }

  function invalidateLocalMissionRouteAuthority() {
    localMissionRouteGeneration += 1;
  }
  const pathButtonDisabled = computed(() => missionPathActionDisabled({
    activeConeCount: activeCones.value.length,
    activeMission: activeMission.value,
    roverMode: roverMode.value,
    stopping: stopping.value,
    emergencyStopped: emergencyStopLatched.value,
  }));

  const pathBtnLabel = computed(() => {
    // 글로벌 비상정지 래치가 잡혀 있는 동안에는 모든 미션 버튼이 정지 명령이
    // 텔레메트리로 확인될 때까지 같은 상태로 보여야 운영자가 두 버튼을 보고
    // 모순된 단계로 오해하지 않는다.
    if (stopping.value && (roverMode.value === "executing" || roverMode.value === "stopped")) {
      return "Requesting stop...";
    }
    if (emergencyStopLatched.value && (roverMode.value === "stopped" || roverMode.value === "path-ready")) {
      return "Release E-stop first";
    }
    if (roverMode.value === "executing") {
      // 일시정지 중에는 메인 버튼이 상태만 표시하고, 재개는 전용 버튼이 담당.
      if (roverStatus.value.nav_state === "PAUSED") return "Paused";
      // executePath 직후 nav_state 가 IDLE 인 ~수초 동안은 0% 가 아니라
      // "Requesting start..." 로 노출. rover 가 CALIBRATING 으로 들어가면 화해 함수가
      // 진행률 라벨을 자동 갱신.
      if (!ACTIVE_NAV_STATES.has(roverStatus.value.nav_state)) return "Requesting start...";
      return `Running ${pathProgress.value}%`;
    }
    if (roverMode.value === "stopped") return activeMission.value?.status === "ready" ? "Start mission" : "Resume mission";
    if (roverMode.value === "path-ready") return "Run route";
    return "Plan route";
  });

  const pathBtnClass = computed(() => {
    if (roverMode.value === "executing") return "btn-primary";
    if (roverMode.value === "stopped") return "btn-primary";
    if (roverMode.value === "path-ready") return "btn-primary";
    return "btn-ghost";
  });
  // Tracks which check keys flipped recently — used to flash the row so the
  // operator notices RTK/NTRIP degrading mid-modal instead of acting on stale info.
  const preflightFlash = ref({});

  // Pre-flight checklist derived from current rover state + planned path.
  const preflightChecks = computed(() => {
    const s = roverStatus.value;
    const wps = pathWaypoints.value;
    // Resume always starts at the first server-authoritative pending occurrence;
    // an empty return-only mission instead checks the current-to-start leg, while
    // an uncertainty resolution explicitly performs no motion.
    const targetDecision = missionPreflightTarget({
      mode: preflightMode.value,
      waypoints: wps,
      finishBehavior: missionFinishBehavior.value,
      missionStart: activeMission.value?.start_position,
      emptyRouteMode: preflightEmptyRouteMode.value,
    });
    const first = targetDecision.target;
    const firstDist = first && s.last_position
      ? haversine({ lat: s.last_position.lat, lng: s.last_position.lng }, first)
      : null;
    const batteryOk = !s.battery || s.battery.percent == null || s.battery.percent > BATTERY_WARN_PERCENT;
    const resolvingUncertain = targetDecision.kind === "resolve_uncertain";
    const returningOnly = targetDecision.kind === "return_only";
    const routeCheck = missionPreflightRouteCheck({
      mode: preflightMode.value === "execute" ? "execute" : "resume",
      waypoints: wps,
      finishBehavior: missionFinishBehavior.value,
      returnPoint: activeMission.value?.start_position || s.last_position,
    });
    return [
      { key: "connected", label: "Rover SSE connection", ok: !!s.connected, blocking: true },
      { key: "estop", label: "E-stop released", ok: !emergencyStopLatched.value, blocking: true,
        detail: emergencyStopLatched.value ? "E-stop is latched. Check the physical state, then release it." : "Released" },
      { key: "protocol", label: "Mission protocol v2", ok: s.mission_protocol?.compatible === true, blocking: true,
        detail: s.mission_protocol?.connected == null
          ? "Version not received"
          : `rover v${s.mission_protocol.connected} / required v${s.mission_protocol.required}` },
      { key: "fix", label: "RTK Fixed GPS", ok: s.fix_status === "rtk_fixed",
        detail: s.fix_status ? s.fix_status.replace(/_/g, " ").toUpperCase() : "Unknown" },
      { key: "ntrip", label: "NTRIP connection", ok: s.ntrip_connected === true,
        detail: (() => {
          if (s.ntrip_connected === null) return "Unknown";
          const caster = s.ntrip?.host ? `${s.ntrip.host}${s.ntrip.mountpoint ? '/' + s.ntrip.mountpoint : ''}` : null;
          if (s.ntrip_connected) return caster ? `${caster} · ok` : "ok";
          const retry = s.ntrip?.fail_count ? ` · retries ${s.ntrip.fail_count}` : "";
          return caster ? `${caster} · off${retry}` : `off${retry}`;
        })() },
      { key: "firstwp", label: resolvingUncertain ? "Resolve uncertain dispense result"
        : (returningOnly ? "Distance to start point" : "Distance to first waypoint"),
        ok: missionPreflightDistanceAllowed({ kind: targetDecision.kind, distance: firstDist }),
        detail: resolvingUncertain ? "The operator resolves the uncertain result without further movement or dispensing."
          : (firstDist != null ? `${firstDist.toFixed(1)} m${returningOnly ? " · mission start point" : ""}` : "No position received") },
      { key: "route", label: "Route segment distance", ok: routeCheck.ok,
        detail: routeCheck.ok ? "All segments within 50 m"
          : (Number.isFinite(routeCheck.distance)
            ? `${routeCheck.reason === "return_segment_too_long" ? "Return segment" : `To cone ${routeCheck.index + 1}`}: ${routeCheck.distance.toFixed(1)} m`
            : "Check route coordinates") },
      { key: "battery", label: "Battery", ok: batteryOk,
        detail: s.battery && s.battery.percent != null ? `${s.battery.percent}%` : "Not received" },
    ];
  });
  const preflightAllOk = computed(() => preflightChecks.value.every((c) => c.ok));
  const preflightHasBlockingFailure = computed(() =>
    preflightChecks.value.some((check) => check.blocking === true && !check.ok));
  const preflightCanConfirm = computed(() =>
    missionPreflightCanConfirm(preflightChecks.value, preflightForce.value));

  // Flash a check row when it changes ok-state during an open modal so the
  // operator sees the transition even if they're focused on the button.
  let lastPreflightOk = {};
  watch(preflightChecks, (next) => {
    if (!showPreflight.value) {
      lastPreflightOk = Object.fromEntries(next.map((c) => [c.key, c.ok]));
      return;
    }
    const flashes = {};
    for (const c of next) {
      const prev = lastPreflightOk[c.key];
      if (prev !== undefined && prev !== c.ok) flashes[c.key] = Date.now();
      if (c.blocking === true && !c.ok) preflightForce.value = false;
    }
    lastPreflightOk = Object.fromEntries(next.map((c) => [c.key, c.ok]));
    if (Object.keys(flashes).length > 0) {
      preflightFlash.value = { ...preflightFlash.value, ...flashes };
      // Clear the flash class after the animation completes so a second
      // transition can re-trigger it.
      setTimeout(() => {
        const stale = Date.now() - 1200;
        preflightFlash.value = Object.fromEntries(
          Object.entries(preflightFlash.value).filter(([, at]) => at > stale)
        );
      }, 1300);
    }
  }, { deep: true });

  watch(showPreflight, (open) => {
    if (open) {
      lastPreflightOk = Object.fromEntries(preflightChecks.value.map((c) => [c.key, c.ok]));
      preflightFlash.value = {};
    }
  });
  // 미션 취소로 코스 전환을 되돌릴 때 재할당이 이 watcher 를 다시 트리거하므로,
  // 그 1회는 플래그로 무시한다 (되돌림에 clearPath/미션 폐기가 돌면 안 된다).
  let revertingCourseSwitch = false;
  let aligningMissionCourse = false;
  // Notified once a course switch is accepted (with the new course id).
  const courseSwitchListeners = new Set();
  function onCourseSwitch(fn) {
    courseSwitchListeners.add(fn);
    return () => courseSwitchListeners.delete(fn);
  }

  function alignCourseToMission(mission) {
    const nextCourseId = missionCourseId(activeCourseId.value, mission);
    if (nextCourseId === activeCourseId.value) return;
    if (!courses.value.some((course) => course.id === nextCourseId)) return;
    aligningMissionCourse = true;
    activeCourseId.value = nextCourseId;
  }

  watch(activeCourseId, (value, previous) => {
    if (value !== previous) invalidateLocalMissionRouteAuthority();
  }, { flush: "sync" });

  watch(activeCourseId, async (v, prev) => {
    if (revertingCourseSwitch) { revertingCourseSwitch = false; return; }
    const missionAlignment = aligningMissionCourse;
    aligningMissionCourse = false;
    // 미션 진행(executing)·중단(stopped) 중의 코스 전환은 아래 clearPath() 가 서버
    // 미션까지 폐기하는 파괴적 작업 — abandonMission 과 동일하게 반드시 확인을 받고,
    // 취소하거나 서버 종료가 실패하면 전환 자체를 이전 코스로 되돌린다.
    if (shouldAbandonMissionForCourseSwitch({ missionAlignment, roverMode: roverMode.value })) {
      const revert = () => { revertingCourseSwitch = true; activeCourseId.value = prev; };
      if (!window.confirm("Switching courses ends and discards the current mission.\nIt can no longer be resumed. Continue?")) { revert(); return; }
      const missionId = activeMissionAuthority.value?.id;
      if (missionId) {
        revert();
        if (missionEndBusy.value || missionEndAwaitingAckId.value === missionId) {
          notifyWarn("Waiting for the rover to confirm the mission end.");
          return;
        }
        missionEndBusy.value = true;
        cancelMissionEndReconcile();
        missionEndAwaitingAckId.value = missionId;
        missionEndAwaitingCommandId.value = null;
        let authorityToken = null;
        try {
          authorityToken = beginMissionAuthorityRequest(activeMissionAuthority.value);
          const response = await roverRequest(`/api/missions/${missionId}/end`, { method: "POST" });
          const data = await response.json();
          if (applyMissionCommandResponse(data, "end", authorityToken)) {
            notifyWarn("Switch courses again after the rover confirms the mission end.");
          }
        } catch (err) {
          await reconcileMissionEndRequestFailure(missionId);
          notifyWarn(`Failed to end mission: ${err.message}`);
        } finally {
          missionEndBusy.value = false;
        }
        return;
      }
    }
    missionPresets.value = [];
    missionPresetRequestSeq += 1;
    // A server-active mission owns both route and course. Its internal course
    // alignment must refresh course-scoped UI without clearing or abandoning the
    // mission path that restoreActiveMission is installing in the same tick.
    if (!missionAlignment) clearPath();
    for (const fn of courseSwitchListeners) fn(v);
  });
  async function loadMissionPresets() {
    const courseId = activeCourseId.value;
    const requestId = ++missionPresetRequestSeq;
    missionPresets.value = [];
    if (!courseId) return;
    try {
      const response = await courseRequest(`/api/courses/${courseId}/mission-presets`);
      const presets = (await response.json()).presets || [];
      if (presetResponseIsCurrent({
        requestId,
        latestRequestId: missionPresetRequestSeq,
        requestedCourseId: courseId,
        activeCourseId: activeCourseId.value,
      })) missionPresets.value = presets;
    } catch (error) {
      if (presetResponseIsCurrent({
        requestId,
        latestRequestId: missionPresetRequestSeq,
        requestedCourseId: courseId,
        activeCourseId: activeCourseId.value,
      })) notifyError(`Failed to load presets: ${error.message}`);
    }
  }

  function coneRouteItem(cone) {
    return {
      cone_id: cone.id, lat: cone.lat, lng: cone.lng, alt: cone.alt, side: cone.side,
    };
  }

  function openMissionBuilder() {
    if (!activeCourseId.value) return;
    const mission = activeMission.value;
    missionBuilderEditing.value = !!mission && missionHeld.value;
    missionBuilderBusy.value = false;
    missionBuilderBase.value = missionBuilderEditing.value ? missionDraftToken(mission) : null;
    if (missionBuilderEditing.value) {
      missionBuilderItems.value = mission.waypoints
        .filter((waypoint) => waypoint.state === "pending" || waypoint.state === "active")
        .map((waypoint) => ({ ...waypoint, waypoint_id: waypoint.id }));
      missionFinishBehavior.value = mission.finish_behavior;
    } else if (pathWaypoints.value.length > 0) {
      missionBuilderItems.value = pathWaypoints.value.map((waypoint) => ({ ...waypoint }));
    } else {
      const start = roverStatus.value.last_position || activeCones.value[0] || null;
      missionBuilderItems.value = optimizeConeRoute(activeCones.value, start).map(coneRouteItem);
      missionFinishBehavior.value = "stop";
    }
    showMissionBuilder.value = true;
    loadMissionPresets();
  }

  function installMissionBuilderPayload({ items, finishBehavior, presetReference = null }) {
    invalidateLocalMissionRouteAuthority();
    const editing = missionBuilderEditing.value;
    const completed = editing && activeMission.value
      ? activeMission.value.waypoints.filter((waypoint) => waypoint.state === "completed")
      : [];
    pathWaypoints.value = [
      ...completed,
      ...items.map((item) => ({ ...item, state: item.state === "active" ? "active" : "pending" })),
    ];
    missionFinishBehavior.value = finishBehavior;
    pathPresetReference.value = presetReference
      ? { ...presetReference, courseId: activeCourseId.value }
      : null;
    const start = activeMission.value?.start_position || roverStatus.value.last_position || pathWaypoints.value[0];
    pathStart.value = start ? { lat: start.lat, lng: start.lng } : null;
    pathReturnOrigin.value = pathWaypoints.value.length === 0 && finishBehavior === "return_to_start"
      ? (roverStatus.value.last_position ? { ...roverStatus.value.last_position } : null)
      : null;
    executedIndex.value = completed.length;
    executionStartIdx = completed.length;
    pathMissionBase = editing ? missionBuilderBase.value : null;
    roverMode.value = editing ? "stopped" : "path-ready";
  }

  async function submitMissionBuilder(payload, { run = false } = {}) {
    if (missionBuilderBusy.value) return;
    const submission = missionBuilderSubmission({ editing: missionBuilderEditing.value, run });
    if (!submission.persist) {
      installMissionBuilderPayload(payload);
      showMissionBuilder.value = false;
      missionBuilderBase.value = null;
      if (submission.next === "execute") openPreflight("execute");
      return;
    }

    const mission = activeMission.value;
    const draft = missionBuilderBase.value;
    missionBuilderBusy.value = true;
    // Close before the request so an incoming authoritative mission response
    // cannot leave an editable stale copy mounted behind the result.
    showMissionBuilder.value = false;
    try {
      const edited = await syncMissionRemaining(mission, {
        draft,
        items: payload.items,
        finishBehavior: payload.finishBehavior,
      });
      missionBuilderBase.value = missionDraftToken(edited);
      notifySuccess("Saved the remaining mission route.");
      if (submission.next === "resume") {
        openPreflight(edited.status === "ready" ? "start-existing" : "resume", {
          routeAlreadySynced: submission.routeAlreadySynced,
          emptyRouteMode: payload.emptyRouteMode,
        });
      }
    } catch (error) {
      missionBuilderBase.value = null;
      notifyError(`Failed to save the remaining route: ${error.message}`);
      if (error.data?.reason === "cone_snapshot_mismatch") {
        await course.resync();
        notifyWarn("Reloaded the changed cone positions. Review the latest route and apply it again.");
      }
      // A 409 response intentionally contains no route body. Fetch the current
      // authority before allowing any further start/resume action.
      await fetchRoverStatus();
    } finally {
      missionBuilderBusy.value = false;
    }
  }

  async function applyMissionBuilder(payload) {
    await submitMissionBuilder(payload);
  }

  async function runMissionBuilder(payload) {
    await submitMissionBuilder(payload, { run: true });
  }

  async function saveMissionPreset({ name, items, finishBehavior }) {
    if (missionPresetBusy.value) return;
    missionPresetBusy.value = true;
    try {
      const existing = missionPresets.value.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
      const presetsPath = `/api/courses/${activeCourseId.value}/mission-presets`;
      await courseRequest(existing ? `${presetsPath}/${existing.id}` : presetsPath, {
        method: existing ? "PUT" : "POST",
        body: JSON.stringify(buildMissionPresetPayload({
          courseId: activeCourseId.value,
          name,
          finishBehavior,
          items,
          existing,
        })),
      });
      notifySuccess(`${existing ? "Updated" : "Saved"} mission preset '${name}'.`);
      await loadMissionPresets();
    } catch (error) {
      notifyError(`Failed to save preset: ${error.message}`);
      await loadMissionPresets();
    } finally {
      missionPresetBusy.value = false;
    }
  }

  async function deleteMissionPreset(id) {
    if (missionPresetBusy.value) return;
    if (!window.confirm("Delete this mission preset?")) return;
    const preset = missionPresets.value.find((item) => item.id === id);
    if (!preset) {
      notifyWarn("The preset list changed. Reloading the latest list.");
      await loadMissionPresets();
      return;
    }
    missionPresetBusy.value = true;
    try {
      await courseRequest(`/api/courses/${preset.course_id}/mission-presets/${id}`, {
        method: "DELETE",
        body: JSON.stringify(buildMissionPresetDeletePayload(preset)),
      });
      await loadMissionPresets();
    } catch (error) {
      notifyError(`Failed to delete preset: ${error.message}`);
      await loadMissionPresets();
    } finally {
      missionPresetBusy.value = false;
    }
  }
  function moveWaypoint(idx, delta) {
    const target = idx + delta;
    if (target < 0 || target >= pathWaypoints.value.length) return;
    const next = [...pathWaypoints.value];
    [next[idx], next[target]] = [next[target], next[idx]];
    invalidateLocalMissionRouteAuthority();
    pathPresetReference.value = null;
    pathWaypoints.value = next;
  }
  function clearPath({ endMissionOnServer = true } = {}) {
    // Local overlays are never allowed to destroy server mission state. Ending a
    // mission is only performed by the explicit, confirmed abandon action.
    void endMissionOnServer;
    invalidateLocalMissionRouteAuthority();
    pathStart.value = null;
    pathReturnOrigin.value = null;
    pathPresetReference.value = null;
    pathWaypoints.value = [];
    pathMissionBase = null;
    displayedMissionId = null;
    displayedMissionAuthorityKey = null;
    executionStartIdx = 0;
    executedIndex.value = 0;
    pathProgress.value = 0;
    missionFinishBehavior.value = "stop";
    showMissionBuilder.value = false;
    missionBuilderBase.value = null;
    clearSprayResults();
    if (roverMode.value !== "manual") roverMode.value = "none";
  }

  // "End mission" 버튼 핸들러. 보존된(비상정지·중단) 미션을 폐기하는 파괴적 작업이라
  // 반드시 확인을 받는다.
  async function abandonMission() {
    if (missionEndBusy.value || missionEndAwaitingAckId.value === activeMissionAuthority.value?.id) return;
    if (!window.confirm("This ends and discards the current mission.\nIt can no longer be resumed. Continue?")) return;
    const missionId = activeMissionAuthority.value?.id;
    if (!missionId) return;
    missionEndBusy.value = true;
    cancelMissionEndReconcile();
    missionEndAwaitingAckId.value = missionId;
    missionEndAwaitingCommandId.value = null;
    let authorityToken = null;
    try {
      authorityToken = beginMissionAuthorityRequest(activeMissionAuthority.value);
      const response = await roverRequest(`/api/missions/${missionId}/end`, { method: "POST" });
      const data = await response.json();
      if (applyMissionCommandResponse(data, "end", authorityToken)) {
        notifyWarn("Mission end requested. The route and controls stay as they are until the rover confirms the stop.");
      }
    } catch (err) {
      await reconcileMissionEndRequestFailure(missionId);
      notifyWarn(`Failed to end mission: ${err.message}`);
    } finally {
      missionEndBusy.value = false;
    }
  }

  function onPathBtn() {
    if (roverMode.value === "executing") return; // 실행 중에는 무시
    if (roverMode.value === "stopped") {
      openPreflight(activeMission.value?.status === "ready" ? "start-existing" : "resume");
      return;
    }
    if (roverMode.value === "path-ready") { openPreflight("execute"); return; }
    if (roverMode.value === "none") { openMissionBuilder(); }
  }

  function openPreflight(mode, { routeAlreadySynced = false, emptyRouteMode = null } = {}) {
    preflightMode.value = mode;
    preflightRouteAlreadySynced.value = routeAlreadySynced;
    preflightMissionToken.value = mode === "execute" ? null : missionCommandToken(activeMission.value);
    preflightMissionDraft.value = mode === "execute" ? null : missionDraftToken(activeMission.value);
    preflightAuthorityToken.value = mode === "execute" ? null : currentMissionAuthorityFence();
    preflightEmptyRouteMode.value = emptyRouteMode || missionEmptyResumeMode(activeMission.value);
    preflightForce.value = false;
    showPreflight.value = true;
  }

  function cancelPreflight() {
    showPreflight.value = false;
    preflightMissionToken.value = null;
    preflightMissionDraft.value = null;
    preflightAuthorityToken.value = null;
    preflightEmptyRouteMode.value = null;
  }

  async function confirmPreflight() {
    if (!preflightCanConfirm.value) {
      notifyError(preflightHasBlockingFailure.value
        ? "A mission cannot start or resume until the E-stop is released."
        : "Resolve the failed checks or explicitly accept the remaining warnings.");
      return;
    }
    if (preflightMode.value !== "execute"
        && !missionAuthorityFenceIsCurrent(preflightAuthorityToken.value)) {
      cancelPreflight();
      notifyError("The mission changed during the preflight check. Check again with the latest state.");
      return;
    }
    const force = preflightForce.value && !preflightAllOk.value;
    showPreflight.value = false;
    const commandToken = preflightMissionToken.value;
    const commandDraft = preflightMissionDraft.value;
    const authorityFence = preflightAuthorityToken.value;
    const emptyRouteMode = preflightEmptyRouteMode.value;
    preflightMissionToken.value = null;
    preflightMissionDraft.value = null;
    preflightAuthorityToken.value = null;
    preflightEmptyRouteMode.value = null;
    if (preflightMode.value === "resume") {
      await resumePath({ force, routeAlreadySynced: preflightRouteAlreadySynced.value, commandToken, commandDraft, authorityFence, emptyRouteMode });
    } else if (preflightMode.value === "start-existing") {
      await startExistingPath({ force, routeAlreadySynced: preflightRouteAlreadySynced.value, commandToken, commandDraft, authorityFence, emptyRouteMode });
    } else {
      await executePath({ force });
    }
  }

  async function syncMissionRemaining(mission, {
    draft = pathMissionBase,
    items = null,
    finishBehavior = missionFinishBehavior.value,
  } = {}) {
    const authorityToken = beginMissionAuthorityRequest(mission);
    const remaining = items || pathWaypoints.value.filter((waypoint) =>
      waypoint.state === "pending" || waypoint.state === "active");
    assertRouteMatchesCourse(remaining, mission.course_id);
    const body = buildMissionRemainingPayload({
      draft,
      mission,
      finishBehavior,
      items: remaining,
    });
    const response = await roverRequest(`/api/missions/${mission.id}/remaining`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const edited = await response.json();
    const authoritativeMission = resolveMissionHttpSnapshot(edited, authorityToken);
    if (!authoritativeMission) throw missionAuthorityAdvancedError(authorityToken);
    return authoritativeMission;
  }

  const MISSION_COMMAND_LABELS = {
    start: "mission start",
    resume: "mission resume",
    pause: "mission pause",
    end: "mission end",
  };

  function applyMissionCommandResponse(data, action, authorityToken) {
    const decision = action === "end"
      ? missionEndResponseDecision(data, terminalMissionIds)
      : missionCommandResponseDecision(data);
    if (decision.mission && decision.keepMission !== false) {
      resolveMissionHttpSnapshot(decision.mission, authorityToken);
    }
    if (action === "end") {
      const awaiting = missionEndAwaitingState({
        awaitingMissionId: missionEndAwaitingAckId.value,
        awaitingCommandId: missionEndAwaitingCommandId.value,
        authorityMission: activeMissionAuthority.value,
        responseDecision: decision,
      });
      missionEndAwaitingAckId.value = awaiting.missionId;
      missionEndAwaitingCommandId.value = awaiting.commandId;
      cancelMissionEndReconcile();
      if (!decision.mission && decision.releaseAwaitingAcknowledgement
          && missionAuthorityRequestIsCurrent(authorityToken)) {
        missionEndAwaitingAckId.value = null;
        missionEndAwaitingCommandId.value = null;
      }
    }
    if (decision.failed) {
      notifyError(`The ${MISSION_COMMAND_LABELS[action] || "mission"} command did not reach the rover. `
        + "The rover may keep moving. Check the screen and the field, and be ready to stop it safely.");
      if (!decision.mission) void fetchRoverStatus();
      return false;
    }
    return true;
  }

  function applyMissionEndFailureAuthority(missionId, authorityMission) {
    const awaiting = missionEndRequestFailureState({
      awaitingMissionId: missionEndAwaitingAckId.value,
      awaitingCommandId: missionEndAwaitingCommandId.value,
      requestedMissionId: missionId,
      authorityMission,
    });
    missionEndAwaitingAckId.value = awaiting.missionId;
    missionEndAwaitingCommandId.value = awaiting.commandId;
    cancelMissionEndReconcile();
  }

  function cancelMissionEndReconcile() {
    missionEndReconcileEpoch += 1;
    if (missionEndReconcileTimer != null) {
      clearTimeout(missionEndReconcileTimer);
      missionEndReconcileTimer = null;
    }
  }

  function scheduleMissionEndReconcile(missionId) {
    if (missionEndReconcileTimer != null || !missionEndReconcileShouldRetry({
      awaitingMissionId: missionEndAwaitingAckId.value,
      requestedMissionId: missionId,
    })) return;
    const expectedEpoch = missionEndReconcileEpoch;
    missionEndReconcileTimer = setTimeout(() => {
      missionEndReconcileTimer = null;
      void reconcileMissionEndRequestFailure(missionId, expectedEpoch);
    }, 1000);
  }

  async function reconcileMissionEndRequestFailure(
    missionId,
    expectedEpoch = missionEndReconcileEpoch,
  ) {
    const authorityGenerationAtStart = missionAuthorityGeneration;
    const applyFailureAuthority = (authorityMission) => {
      applyMissionEndFailureAuthority(missionId, authorityMission);
      reconcileRoverMode(roverStatus.value);
    };
    const result = await reconcileMissionEndAuthorityRequest({
      requestedMissionId: missionId,
      expectedEpoch,
      authorityGenerationAtStart,
      getCurrentState: () => ({
        epoch: missionEndReconcileEpoch,
        awaitingMissionId: missionEndAwaitingAckId.value,
        authorityGeneration: missionAuthorityGeneration,
        authorityMission: activeMissionAuthority.value,
      }),
      fetchActiveMission: async () => {
        const response = await roverRequest("/api/missions/active", { method: "GET" });
        const data = await response.json();
        return data.mission || null;
      },
    });
    if (result.outcome === "stale") return;
    if (result.outcome === "retry") {
      // Keep the destructive-action lock until an authoritative active snapshot
      // or terminal SSE resolves the uncertain End request.
      scheduleMissionEndReconcile(missionId);
      return;
    }
    if (result.installResponse) {
      installActiveMissionSnapshot(result.authorityMission);
      if (!missionEndReconcileIsCurrent({
        expectedEpoch,
        currentEpoch: missionEndReconcileEpoch,
        awaitingMissionId: missionEndAwaitingAckId.value,
        requestedMissionId: missionId,
      })) return;
    }
    applyFailureAuthority(result.authorityMission);
  }

  async function startExistingPath(opts = {}) {
    const mission = activeMission.value;
    if (!mission) return;
    let authorityToken = null;
    try {
      if (!missionAuthorityFenceIsCurrent(opts.authorityFence)) {
        throw missionAuthorityAdvancedError(opts.authorityFence);
      }
      const preflightCommandBody = buildMissionCommandPayload({
        token: opts.commandToken,
        missionId: mission.id,
        force: opts.force,
      });
      roverMode.value = "executing";
      const edited = opts.routeAlreadySynced ? mission : await syncMissionRemaining(mission, { draft: opts.commandDraft });
      const commandAuthorityFence = opts.routeAlreadySynced
        ? opts.authorityFence
        : currentMissionAuthorityFence(edited);
      const commandBody = opts.routeAlreadySynced ? preflightCommandBody : buildMissionCommandPayload({
        token: missionCommandTokenAfterSync({
          routeAlreadySynced: opts.routeAlreadySynced,
          preflightToken: opts.commandToken,
          editedMission: edited,
        }),
        missionId: edited.id,
        force: opts.force,
      });
      authorityToken = beginMissionAuthorityRequest(edited);
      if (!missionAuthorityFenceIsCurrent(commandAuthorityFence)) {
        throw missionAuthorityAdvancedError(authorityToken);
      }
      const response = await roverRequest(`/api/missions/${edited.id}/start`, {
        method: "POST",
        body: JSON.stringify(commandBody),
      });
      const data = await response.json();
      applyMissionCommandResponse(data, "start", authorityToken);
    } catch (error) {
      authorityToken = error.missionAuthorityRequestToken || authorityToken;
      if (missionAuthorityRequestIsCurrent(authorityToken)) roverMode.value = "stopped";
      else reconcileRoverMode(roverStatus.value);
      notifyError(error.message);
    }
  }

  // Throws the same reason a course host reports for a stale route, so callers
  // reload the cones and ask the operator to review the route again.
  function assertRouteMatchesCourse(items, courseId) {
    const mismatch = missionRouteCourseMismatch(items, conesMap.value[courseId] || []);
    if (!mismatch) return;
    throw Object.assign(new Error(`Cone ${mismatch.position + 1} changed after the preflight check. Review the latest route.`), {
      status: 409,
      data: { reason: "cone_snapshot_mismatch", ...mismatch },
    });
  }

  async function executePath(opts = {}) {
    if (pathWaypoints.value.length === 0) return;
    executedIndex.value = 0;
    executionStartIdx = 0;
    pathProgress.value = 0;
    clearSprayResults();
    roverMode.value = "executing";
    const createRequestId = ++localMissionCreateRequestSeq;
    const routeToken = captureMissionCreateRouteAuthority({
      requestId: createRequestId,
      courseId: activeCourseId.value,
      routeGeneration: localMissionRouteGeneration,
    });
    localMissionCreatePending = true;
    let authorityToken = null;
    try {
      authorityToken = beginMissionAuthorityRequest(activeMissionAuthority.value);
      const course = courses.value.find((c) => c.id === activeCourseId.value);
      if (!course) throw new Error("Course not found.");
      assertRouteMatchesCourse(pathWaypoints.value, course.id);
      const createResponse = await roverRequest("/api/missions", {
        method: "POST",
        body: JSON.stringify(buildMissionCreatePayload({
          course,
          finishBehavior: missionFinishBehavior.value,
          items: pathWaypoints.value,
          presetReference: pathPresetReference.value?.courseId === activeCourseId.value
            ? pathPresetReference.value : null,
        })),
      });
      const created = await createResponse.json();
      // Keep the course as it was at mission creation, best effort: a host may not
      // let this operator take snapshots, and the mission itself holds the route.
      void courseRequest(`/api/courses/${course.id}/snapshots`, {
        method: "POST",
        body: JSON.stringify({ reason: `auto: create mission #${created.mission?.id ?? created.id}` }),
      }).catch(() => {});
      const mission = resolveMissionHttpSnapshot(created, authorityToken, { expectedLocalMission: true });
      if (!mission) throw missionAuthorityAdvancedError(authorityToken);
      if (!missionCreateRouteAuthorityMatches({
        token: routeToken,
        latestRequestId: localMissionCreateRequestSeq,
        currentCourseId: activeCourseId.value,
        currentRouteGeneration: localMissionRouteGeneration,
      })) {
        roverMode.value = "stopped";
        notifyWarn("The mission was created but not started because the reviewed course or route changed. Check the latest route.");
        return;
      }
      authorityToken = beginMissionAuthorityRequest(mission);
      const startResponse = await roverRequest(`/api/missions/${mission.id}/start`, {
        method: "POST",
        body: JSON.stringify(buildMissionCommandPayload({
          token: missionCommandToken(mission),
          missionId: mission.id,
          force: opts.force,
        })),
      });
      const started = await startResponse.json();
      applyMissionCommandResponse(started, "start", authorityToken);
    } catch (err) {
      authorityToken = err.missionAuthorityRequestToken || authorityToken;
      if (missionAuthorityRequestIsCurrent(authorityToken)) {
        roverMode.value = activeMission.value ? "stopped" : "path-ready";
      } else {
        reconcileRoverMode(roverStatus.value);
      }
      notifyError(err.message);
      if (err.data?.reason === "cone_snapshot_mismatch") {
        await course.resync();
      }
    } finally {
      const settlement = missionCreateSettlementDecision({
        requestId: createRequestId,
        latestRequestId: localMissionCreateRequestSeq,
        authorityMission: activeMissionAuthority.value,
        hasFullSnapshot: activeMission.value != null,
      });
      if (createRequestId === localMissionCreateRequestSeq) localMissionCreatePending = false;
      if (settlement.clearLocalRoute) clearPath({ endMissionOnServer: false });
      if (settlement.recoverSnapshot) void fetchActiveMissionSnapshot(activeMissionAuthority.value);
    }
  }

  async function resumePath(opts = {}) {
    const mission = activeMission.value;
    if (!mission) {
      notifyError("No active mission to resume.");
      return;
    }
    let authorityToken = null;
    try {
      if (!missionAuthorityFenceIsCurrent(opts.authorityFence)) {
        throw missionAuthorityAdvancedError(opts.authorityFence);
      }
      const preflightCommandBody = buildMissionCommandPayload({
        token: opts.commandToken,
        missionId: mission.id,
        force: opts.force,
      });
      const remaining = pathWaypoints.value.filter((waypoint) =>
        waypoint.state === "pending" || waypoint.state === "active");
      executionStartIdx = pathWaypoints.value.length - remaining.length;
      executedIndex.value = executionStartIdx;
      roverMode.value = "executing";
      const edited = opts.routeAlreadySynced ? mission : await syncMissionRemaining(mission, { draft: opts.commandDraft });
      const commandAuthorityFence = opts.routeAlreadySynced
        ? opts.authorityFence
        : currentMissionAuthorityFence(edited);
      const commandBody = opts.routeAlreadySynced ? preflightCommandBody : buildMissionCommandPayload({
        token: missionCommandTokenAfterSync({
          routeAlreadySynced: opts.routeAlreadySynced,
          preflightToken: opts.commandToken,
          editedMission: edited,
        }),
        missionId: edited.id,
        force: opts.force,
      });
      authorityToken = beginMissionAuthorityRequest(edited);
      if (!missionAuthorityFenceIsCurrent(commandAuthorityFence)) {
        throw missionAuthorityAdvancedError(authorityToken);
      }
      const resumeResponse = await roverRequest(`/api/missions/${edited.id}/resume`, {
        method: "POST",
        body: JSON.stringify(commandBody),
      });
      const resumed = await resumeResponse.json();
      applyMissionCommandResponse(resumed, "resume", authorityToken);
    } catch (err) {
      authorityToken = err.missionAuthorityRequestToken || authorityToken;
      if (missionAuthorityRequestIsCurrent(authorityToken)) roverMode.value = "stopped";
      else reconcileRoverMode(roverStatus.value);
      notifyError(err.message);
    }
  }
  function updatePathProgress(lat, lng) {
    const { cumDist: pathCumDist, totalDist: pathTotalDist } = pathMetrics.value;
    if (pathTotalDist === 0) return;
    if (pathWaypoints.value.length === 0) {
      if (missionFinishBehavior.value !== "return_to_start" || !pathStart.value) return;
      const remaining = haversine({ lat, lng }, pathStart.value);
      const walked = Math.max(0, pathTotalDist - remaining);
      pathProgress.value = Math.min(100, Math.round((walked / pathTotalDist) * 100));
      return;
    }
    // Interpolate progress using cumulative segment distance. executedIndex is
    // advanced monotonically by the rover:waypoint SSE event, never by proximity.
    const idx = executedIndex.value;
    const prevPoint = idx === 0 ? pathStart.value : pathWaypoints.value[idx - 1];
    const prevCum = idx === 0 ? 0 : pathCumDist[idx - 1];
    const nextPoint = idx < pathWaypoints.value.length ? pathWaypoints.value[idx] : pathStart.value;
    const segLen = haversine(prevPoint, nextPoint);
    const traversed = segLen > 0 ? Math.min(segLen, haversine(prevPoint, { lat, lng })) : 0;
    const walked = prevCum + traversed;
    pathProgress.value = Math.min(100, Math.round((walked / pathTotalDist) * 100));
  }

  function onWaypointReached(localIdx) {
    // Navigator reports local indices into the waypoint list it received; map
    // those back onto the global list and advance monotonically.
    const globalIdx = executionStartIdx + localIdx;
    if (globalIdx + 1 > executedIndex.value && globalIdx < pathWaypoints.value.length) {
      executedIndex.value = globalIdx + 1;
      const { cumDist, totalDist } = pathMetrics.value;
      if (totalDist > 0) {
        const walked = cumDist[executedIndex.value - 1] ?? totalDist;
        pathProgress.value = Math.min(100, Math.round((walked / totalDist) * 100));
      }
    }
  }

  /* ── Soft pause / resume ──────────────────────────────
     A soft pause holds the mission WITHOUT the E-Stop latch, so the operator can
     drive manually (e.g. around an obstacle) and then resume from the current
     waypoint. Pause is only meaningful while the rover is actually driving the
     mission; resume is offered whenever nav_state is PAUSED. */
  const PAUSABLE_NAV = new Set(["CALIBRATING", "NAVIGATING", "SETTLING", "SPRAYING"]);
  const pauseBusy = ref(false);
  async function pauseMission() {
    if (pauseBusy.value) return;
    if (!activeMission.value?.id) return;
    pauseBusy.value = true;
    try {
      const authorityToken = beginMissionAuthorityRequest(activeMissionAuthority.value);
      const response = await roverRequest(`/api/missions/${activeMission.value.id}/pause`, { method: "POST" });
      const data = await response.json();
      applyMissionCommandResponse(data, "pause", authorityToken);
    } catch (err) {
      notifyError(`Failed to pause: ${err.message}`);
    } finally {
      pauseBusy.value = false;
    }
  }
  async function resumeMission() {
    if (pauseBusy.value || !activeMission.value?.id) return;
    openPreflight("resume");
  }

  /* ── Manual control ───────────────────────────────── */
  function startManualControl() {
    if (manualAuthorityReleaseBusy.value) return;
    if (!roverStatus.value.connected) {
      notifyWarn("The rover is not connected.");
      return;
    }
    // During a soft pause the operator drives manually to clear an obstacle, then
    // resumes — so KEEP the mission overlay/progress. clearPath() would not only
    // wipe the overlay (only rebuilt on mount/SSE-reconnect) but also POST
    // /api/rover/end-mission, abandoning the very mission we want to resume.
    // Outside a pause, manual mode discards any in-progress path pick as before.
    if (!missionHeld.value) clearPath();
    roverMode.value = "manual";
    manualThrottle.value = 0;
    manualSteering.value = 0;
    manualFailCount = 0;
    sendControl();
    controlInterval = setInterval(sendControl, 50);
  }

  function stopManualControl() {
    if (manualAuthorityReleaseBusy.value) return;
    if (controlInterval) { clearInterval(controlInterval); controlInterval = null; }
    manualThrottle.value = 0;
    manualSteering.value = 0;
    manualFailCount = 0;
    sendControl();
    if (roverMode.value === "manual") {
      // Fail the pump off when leaving manual mode. The PUMP toggle only
      // exists in manual mode, so exiting it (operator click OR the 5-fail
      // auto-release above) must not strand a running liquid pump — the same
      // asymmetry we avoid on E-Stop / heartbeat loss. Best-effort: on a lost
      // link this POST also fails, but then the MCU heartbeat fail-safe stops
      // the pump anyway.
      if (pumpOn.value) {
        roverRequest("/api/rover/pump", {
          method: "POST",
          body: JSON.stringify({ on: false }),
        }).catch(() => {});
      }
      roverMode.value = "none";
      // Snap straight back to the server-truth mode — e.g. if the operator was
      // manually clearing an obstacle during a soft pause, this re-shows the
      // Resume button immediately instead of waiting for the next status tick.
      reconcileRoverMode(roverStatus.value);
    }
  }

  async function releaseManualForMissionAuthority() {
    if (manualAuthorityReleaseBusy.value) return;
    manualAuthorityReleaseBusy.value = true;
    if (controlInterval) { clearInterval(controlInterval); controlInterval = null; }
    manualThrottle.value = 0;
    manualSteering.value = 0;
    manualFailCount = 0;
    // A slow non-zero POST may already be in flight when the remote mission
    // snapshot arrives. Wait for every request issued before interval shutdown,
    // then make zero the final manual command observed by the server.
    await waitForManualControlDrain(pendingManualControlRequests);
    try {
      await roverRequest("/api/rover/control", {
        method: "POST",
        body: JSON.stringify({ throttle: 0, steering: 0 }),
      });
    } catch (error) {
      notifyError(`Another operator resumed the mission, so manual control stopped, but the zero command was not confirmed: ${error.message}. `
        + "Check the rover's autonomous driving state and the field immediately.");
    }
    if (pumpOn.value) {
      try {
        await roverRequest("/api/rover/pump", {
          method: "POST",
          body: JSON.stringify({ on: false }),
        });
      } catch (error) {
        notifyError(`Could not confirm the pump stopped during the server mission handover: ${error.message}`);
      }
    }
    manualThrottle.value = 0;
    manualSteering.value = 0;
    roverMode.value = "none";
    manualAuthorityReleaseBusy.value = false;
    reconcileRoverMode(roverStatus.value);
  }

  async function sendControl() {
    try {
      await trackManualControlRequest(pendingManualControlRequests, roverRequest("/api/rover/control", {
        method: "POST",
        body: JSON.stringify({ throttle: manualThrottle.value, steering: manualSteering.value }),
      }));
      manualFailCount = 0;
    } catch {
      manualFailCount++;
      // 5 consecutive failures (~250ms) → auto-release manual control
      if (manualFailCount >= 5 && roverMode.value === "manual") {
        stopManualControl();
        notifyWarn("Rover connection lost; manual control released.");
      }
    }
  }
  /* ── Rover events ─────────────────────────────────── */
  // A corrupt frame returns null so one bad event cannot kill its listener.
  function parseSSE(e) {
    try { return JSON.parse(e.data); } catch { return null; }
  }

  function attachRoverEvents(roverEvents) {
    roverEvents?.addEventListener("rover", (e) => {
      const data = parseSSE(e);
      if (!data || !isValidRoverPos(data.lat, data.lng)) return;
      rover.livePosition.value = { lat: data.lat, lng: data.lng };
      if (roverMode.value === "executing") updatePathProgress(data.lat, data.lng);
    });

    roverEvents?.addEventListener("rover:status", (e) => {
      const data = parseSSE(e);
      if (!data) return;
      const missionStatus = splitMissionStatusPayload(data);
      roverStatus.value = { ...roverStatus.value, ...missionStatus.status };
      if (missionStatus.hasActiveMissionSummary) {
        applyActiveMissionSummary(missionStatus.activeMissionSummary);
      }
      rover.livePosition.value = roverStatus.value.last_position || null;
      // Mission progress tracks the ROVER's position. Doing it here (not only in
      // the "rover" event) keeps the executing overlay advancing even when the
      // receiver is the active source — the server then suppresses the rover's
      // live "rover" event, but rover:status still fires.
      const rlp = data.last_position;
      if (rlp && typeof rlp.lat === "number" && typeof rlp.lng === "number") {
        if (roverMode.value === "executing") updatePathProgress(rlp.lat, rlp.lng);
      }
      // If the rover disconnected mid-manual-control, release immediately.
      if (!data.connected && roverMode.value === "manual") {
        stopManualControl();
      }
      reconcileRoverMode(roverStatus.value);
    });

    roverEvents?.addEventListener("rover:mission", (e) => {
      const data = parseSSE(e);
      const mission = data?.mission;
      if (!mission) {
        applyAuthoritativeMissionAbsence();
        return;
      }
      if (mission.status === "completed") {
        rememberTerminalMission(mission.id);
        if (missionEndAwaitingAckId.value === mission.id) {
          missionEndAwaitingAckId.value = null;
          missionEndAwaitingCommandId.value = null;
          cancelMissionEndReconcile();
        }
        notifySuccess("Mission completed.");
        applyAuthoritativeMissionAbsence();
        return;
      }
      if (mission.status === "cancelled") {
        rememberTerminalMission(mission.id);
        if (missionEndAwaitingAckId.value === mission.id) {
          missionEndAwaitingAckId.value = null;
          missionEndAwaitingCommandId.value = null;
          cancelMissionEndReconcile();
        }
        applyAuthoritativeMissionAbsence();
        return;
      }
      installActiveMissionSnapshot(mission);
      reconcileRoverMode(roverStatus.value);
    });

    roverEvents?.addEventListener("rover:waypoint", (e) => {
      const data = parseSSE(e);
      if (!shouldConsumeLegacyMissionIndexEvent({
        activeMission: activeMission.value,
        connectedProtocol: roverStatus.value.mission_protocol?.connected,
      })) return;
      if (roverMode.value === "executing" && Number.isInteger(data?.index)) {
        onWaypointReached(data.index);
      }
    });

    roverEvents?.addEventListener("rover:skipped", (e) => {
      const data = parseSSE(e);
      if (!shouldConsumeLegacyMissionIndexEvent({
        activeMission: activeMission.value,
        connectedProtocol: roverStatus.value.mission_protocol?.connected,
      })) return;
      if (roverMode.value === "executing" && Number.isInteger(data?.index)) {
        // Stuck-skip: navigator advanced _cur_seg_idx past this waypoint
        // without firing waypoint_reached. Advance executedIndex the same
        // way the reached event would, otherwise the counter sits on the
        // skipped index until the *next* waypoint reports reached — at
        // which point it jumps by 2 and the skip becomes invisible.
        onWaypointReached(data.index);
        notifyWarn(`Skipped waypoint #${data.index + 1} (stuck)`);
      }
    });

    roverEvents?.addEventListener("rover:spray", (e) => {
      const data = parseSSE(e);
      if (!shouldConsumeLegacyMissionIndexEvent({
        activeMission: activeMission.value,
        connectedProtocol: roverStatus.value.mission_protocol?.connected,
      })) return;
      if (!Number.isInteger(data?.waypoint) || !data.outcome) return;
      onSprayResult(data.waypoint, data.outcome);
    });

  }

  function onSprayResult(localIdx, outcome) {
    // Navigator/spray_node publish local indices; translate to the global list.
    const globalIdx = executionStartIdx + localIdx;
    if (globalIdx < 0 || globalIdx >= pathWaypoints.value.length) return;
    sprayResults.value.set(globalIdx, { outcome, at: Date.now() });
    // Trigger reactive update for Map
    sprayResults.value = new Map(sprayResults.value);
  }

  function clearSprayResults() {
    sprayResults.value = new Map();
  }

  function applyAuthoritativeMissionAbsence(options = {}) {
    const authorityMissionId = activeMissionAuthority.value?.id;
    const decision = missionAbsentSnapshotDecision({
      displayedMissionId,
      authorityMissionId,
      awaitingMissionId: missionEndAwaitingAckId.value,
    });
    observeMissionAuthority(null, options);
    if (decision.terminalMissionId != null) rememberTerminalMission(decision.terminalMissionId);
    activeMissionSnapshotRequestSeq += 1;
    activeMissionSnapshotRequestKey = null;
    roverStatus.value = { ...roverStatus.value, active_mission: null };
    missionEndAwaitingAckId.value = null;
    missionEndAwaitingCommandId.value = null;
    cancelMissionEndReconcile();
    if (decision.clearsDisplayedMission) clearPath({ endMissionOnServer: false });
    reconcileRoverMode(roverStatus.value);
  }

  function installActiveMissionSnapshot(mission, options = {}) {
    if (!mission) {
      applyAuthoritativeMissionAbsence(options);
      return;
    }
    if (["completed", "cancelled"].includes(mission.status)) {
      rememberTerminalMission(mission.id);
      applyAuthoritativeMissionAbsence(options);
      return;
    }
    observeMissionAuthority(mission, options);
    roverStatus.value = { ...roverStatus.value, active_mission: mission };
    restoreActiveMission(mission, options);
  }

  async function fetchActiveMissionSnapshot(expectedSummary) {
    const expectedKey = missionAuthorityKey(expectedSummary);
    if (expectedKey == null || activeMissionSnapshotRequestKey === expectedKey) return;
    const requestId = ++activeMissionSnapshotRequestSeq;
    activeMissionSnapshotRequestKey = expectedKey;
    try {
      const response = await roverRequest("/api/missions/active", { method: "GET" });
      const data = await response.json();
      if (requestId !== activeMissionSnapshotRequestSeq
          || missionAuthorityKey(activeMissionAuthority.value) !== expectedKey) return;
      if (!data.mission) {
        applyAuthoritativeMissionAbsence();
        return;
      }
      if (!missionSnapshotMatchesSummary(data.mission, activeMissionAuthority.value)) return;
      installActiveMissionSnapshot(data.mission);
      reconcileRoverMode(roverStatus.value);
    } catch { /* the next status summary retries recovery */ }
    finally {
      if (requestId === activeMissionSnapshotRequestSeq) activeMissionSnapshotRequestKey = null;
    }
  }

  function applyActiveMissionSummary(summary) {
    if (summary == null) {
      applyAuthoritativeMissionAbsence();
      return;
    }
    const refresh = missionSummaryRefreshDecision({
      summary,
      observedAuthorityKey: observedMissionAuthorityKey,
      hasFullSnapshot: activeMission.value != null,
    });
    if (!refresh.valid) return;
    if (refresh.unchanged) {
      if (refresh.recoverSnapshot) void fetchActiveMissionSnapshot(summary);
      return;
    }
    const merged = mergeMissionSummary(activeMission.value, summary);
    if (merged) {
      installActiveMissionSnapshot(merged);
      reconcileRoverMode(roverStatus.value);
      return;
    }
    observeMissionAuthority(summary);
    alignCourseToMission(summary);
    roverStatus.value = { ...roverStatus.value, active_mission: null };
    if (displayedMissionId != null
        || (pathWaypoints.value.length > 0 && !localMissionCreatePending)) {
      clearPath({ endMissionOnServer: false });
    }
    void fetchActiveMissionSnapshot(summary);
  }

  async function fetchRoverStatus() {
    const requestId = ++roverStatusMissionRequestSeq;
    const authorityToken = captureMissionAuthorityRequest({
      requestId,
      authorityGeneration: missionAuthorityGeneration,
      mission: activeMissionAuthority.value,
    });
    try {
      const res = await roverRequest("/api/rover/status", { method: "GET" });
      const data = await res.json();
      const missionStatus = splitMissionStatusPayload(data);
      roverStatus.value = { ...roverStatus.value, ...missionStatus.status };
      // Place the device markers from the cached snapshot on first load, before
      // the next live frame.
      rover.livePosition.value = roverStatus.value.last_position || null;
      // Restore in-flight mission so a tab reload during a mission doesn't lose
      // the path overlay, waypoint counter, or spray markers.
      const missionSnapshotCurrent = missionAuthorityRequestCanApply({
        token: authorityToken,
        latestRequestId: roverStatusMissionRequestSeq,
        currentAuthorityGeneration: missionAuthorityGeneration,
        currentMission: activeMissionAuthority.value,
      });
      if (missionSnapshotCurrent && missionStatus.hasActiveMission) {
        installActiveMissionSnapshot(missionStatus.activeMission);
      }
      reconcileRoverMode(roverStatus.value);
    } catch { /* best-effort */ }
  }

  function restoreActiveMission(mission, { expectedLocalMission = false } = {}) {
    const authorityKey = missionAuthorityKey(mission);
    if (displayedMissionId === mission?.id
        && displayedMissionAuthorityKey === authorityKey) return;
    const missionChanged = displayedMissionId !== mission?.id;
    const decision = missionRestoreDecision({
      mission,
      displayedMissionId,
      localWaypointCount: pathWaypoints.value.length,
    });
    if (!decision.restore) return;

    alignCourseToMission(mission);
    const builderMissionEditable = missionMotionConfirmedHeld(mission);
    if (showMissionBuilder.value
        && (!builderMissionEditable || !missionDraftMatches(missionBuilderBase.value, mission))) {
      showMissionBuilder.value = false;
      missionBuilderBase.value = null;
      notifyWarn("The server mission route changed, so the open draft was closed. Check the latest route.");
    } else if (decision.discardsLocalDraft && !expectedLocalMission && !localMissionCreatePending) {
      notifyWarn("Replaced the local route draft with the server mission another operator activated.");
    }

    displayedMissionId = mission.id;
    displayedMissionAuthorityKey = authorityKey;
    pathPresetReference.value = null;
    pathWaypoints.value = mission.waypoints
      .filter((waypoint) => waypoint.state !== "skipped")
      .map((waypoint) => ({ ...waypoint, waypoint_id: waypoint.id }));
    executedIndex.value = pathWaypoints.value.filter((waypoint) => waypoint.state === "completed").length;
    pathMissionBase = missionDraftToken(mission);
    missionFinishBehavior.value = mission.finish_behavior || "stop";
    const lp = roverStatus.value.last_position;
    pathStart.value = mission.start_position
      || ((lp && isValidRoverPos(lp.lat, lp.lng)) ? lp : pathWaypoints.value[0]);
    if (pathWaypoints.value.length === 0 && missionFinishBehavior.value === "return_to_start" && pathStart.value) {
      if (missionChanged || !pathReturnOrigin.value) {
        pathReturnOrigin.value = lp && isValidRoverPos(lp.lat, lp.lng) ? { lat: lp.lat, lng: lp.lng } : null;
      }
    } else {
      pathReturnOrigin.value = null;
    }

    // Progress from the cumulative path distances.
    const { cumDist, totalDist } = pathMetrics.value;
    if (totalDist > 0 && executedIndex.value > 0) {
      const walked = cumDist[executedIndex.value - 1] ?? totalDist;
      pathProgress.value = Math.min(100, Math.round((walked / totalDist) * 100));
    }

    const restored = new Map();
    pathWaypoints.value.forEach((waypoint, index) => {
      if (waypoint.outcome) restored.set(index, { outcome: waypoint.outcome, at: waypoint.completed_at || 0 });
    });
    sprayResults.value = restored;
  }

  // The durable mission record is the only lifecycle/progress authority. Generic
  // nav telemetry is deliberately ignored here: a delayed IDLE frame cannot
  // complete or restart a mission without a correlated protocol-v2 report.
  function reconcileRoverMode(s) {
    const mission = activeMissionAuthority.value;
    const held = missionMotionConfirmedHeld(mission);
    if (missionNeedsManualRelease({ roverMode: roverMode.value, mission, held })) {
      restoreActiveMission(mission);
      void releaseManualForMissionAuthority();
      return;
    }
    if (roverMode.value === "manual" && (!mission || missionHeld.value)) {
      // Keep the joystick visible while an allowed held-mission reposition is in
      // progress, but never let manual UI suppress a newer server route/course.
      if (mission) restoreActiveMission(mission);
      return;
    }
    if (mission) {
      restoreActiveMission(mission);
      if (["starting", "running", "pausing", "resuming"].includes(mission.status)) {
        roverMode.value = "executing";
      } else if (["ready", "paused", "interrupted"].includes(mission.status)) {
        roverMode.value = "stopped";
      }
      return;
    }
    displayedMissionId = null;
    if (roverMode.value === "executing" || roverMode.value === "stopped") {
      roverMode.value = pathWaypoints.value.length ? "path-ready" : "none";
      pathProgress.value = 0;
    }
  }

  onScopeDispose(() => {
    cancelMissionEndReconcile();
    if (controlInterval) clearInterval(controlInterval);
  });

  return {
    roverMode, pathWaypoints, missionFinishBehavior, pathStart, pathReturnOrigin, pathGeometry, pathDistance,
    executedIndex, pathProgress, sprayResults, currentTargetDistance, missionETA, remainingDistanceM,
    activeMission, activeMissionAuthority, missionHeld, missionEndBusy, missionEndAwaitingAckId,
    pathButtonDisabled, pathBtnLabel, pathBtnClass, onPathBtn, moveWaypoint, clearPath, abandonMission,
    showMissionBuilder, missionBuilderItems, missionBuilderEditing, missionBuilderBusy, missionPresets, missionPresetBusy,
    openMissionBuilder, applyMissionBuilder, runMissionBuilder, saveMissionPreset, deleteMissionPreset,
    showPreflight, preflightForce, preflightMode, preflightEmptyRouteMode, preflightChecks, preflightFlash,
    preflightAllOk, preflightHasBlockingFailure, preflightCanConfirm, cancelPreflight, confirmPreflight,
    PAUSABLE_NAV, pauseBusy, pauseMission, resumeMission,
    manualThrottle, manualSteering, manualAuthorityReleaseBusy, startManualControl, stopManualControl,
    fetchRoverStatus, attachRoverEvents, onCourseSwitch,
  };
}
