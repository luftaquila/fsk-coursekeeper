<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { formatAlt, formatLatLng } from "../../geo.mjs";
import { formatSnapshotTime } from "../lib/console-format.mjs";
import { NAV_LIGHT_MODES } from "../state/rover-store.mjs";
import { useConsoleState } from "../state/console.mjs";
import ConsoleIcon from "./ConsoleIcon.vue";
import BatteryDialog from "./dialogs/BatteryDialog.vue";
import CalibrationDialog from "./dialogs/CalibrationDialog.vue";
import StatusRows from "./ui/StatusRows.vue";

// Device setup and detail, opened from a header badge: the rover (status,
// corrections, battery, lights, calibration, versions) and the GPS unit
// (status, NGII login, survey points for a base station).
const state = useConsoleState();
const { host, rover, gps, status, editor, mapActions } = state;
const { success: notifySuccess, error: notifyError } = state.notify;
const { roverStatus } = rover;
const { drawer } = editor;

const hasRover = computed(() => host.devices.selected("rover") != null);
const hasGps = computed(() => host.devices.selected("gps") != null);
const close = () => { drawer.value = null; };

// The unit's configuration and survey points back both panels (the rover's
// base-station source needs them), so they reload on open and on reconnect.
watch(drawer, (open) => { if (open && hasGps.value) gps.loadConfig(); }, { immediate: true });
watch(gps.receiverConnected, (now, prev) => { if (now && !prev && drawer.value) gps.loadConfig(); });

/* ── NGII logins, one per device ──────────────────── */
const roverLogin = ref("");
const gpsLogin = ref("");
const loginSaving = ref(false);
watch(() => roverStatus.value.ntrip_username, (v) => { roverLogin.value = v ?? ""; }, { immediate: true });
watch(() => gps.gpsUnitConfig.value.ntrip_username, (v) => { gpsLogin.value = v ?? ""; }, { immediate: true });
async function saveLogin(kind) {
  const username = (kind === "rover" ? roverLogin : gpsLogin).value.trim();
  loginSaving.value = true;
  try {
    await (kind === "rover" ? rover : gps).setNtripUsername(username);
    const device = kind === "rover" ? "rover" : "GPS unit";
    notifySuccess(username ? `Saved the ${device}'s NGII login.` : `Cleared the ${device}'s NGII login.`);
  } catch (err) {
    notifyError(err.message || "Failed to save the NGII login.");
  } finally {
    loginSaving.value = false;
  }
}

/* ── Dialogs ──────────────────────────────────────── */
const showCalibration = ref(false);
const showBattery = ref(false);

/* ── Survey points ────────────────────────────────── */
const newPointName = ref("");
async function addPoint() {
  const name = newPointName.value.trim();
  if (name && await gps.addSurveyPoint(name)) newPointName.value = "";
}
async function deletePoint(p) {
  if (!window.confirm(`Delete survey point "${p.name}"?`)) return;
  if (await gps.deleteSurveyPoint(p) && editor.selectedSurveyPointId.value === p.id) editor.selectedSurveyPointId.value = null;
}
// Surveyed points show on the map; following the GPS unit would yank the view back.
function focusPoint(p) {
  if (p.lat == null || p.lng == null) return;
  editor.followReceiver.value = false;
  editor.selectedSurveyPointId.value = p.id;
  mapActions.panToPoint?.(p.lat, p.lng, 17);
}
watch(editor.selectedSurveyPointId, (id) => {
  if (id != null) nextTick(() => document.querySelector(`[data-survey-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
});
</script>

<template>
  <aside v-if="drawer" class="drawer" role="complementary" :aria-label="drawer === 'rover' ? 'Rover' : 'GPS unit'" data-testid="device-drawer">
    <header class="drawer-head">
      <div class="ck-seg">
        <button v-if="hasRover" :class="['ck-seg-btn', { active: drawer === 'rover' }]" @click="drawer = 'rover'"><ConsoleIcon name="rover" :size="15" /> Rover</button>
        <button v-if="hasGps" :class="['ck-seg-btn', { active: drawer === 'gps' }]" @click="drawer = 'gps'"><ConsoleIcon name="gps" :size="15" /> GPS unit</button>
      </div>
      <button class="ck-btn quiet icon" aria-label="Close" title="Close" @click="close"><ConsoleIcon name="close" :size="16" /></button>
    </header>

    <div class="drawer-body">
      <!-- Rover -->
      <template v-if="drawer === 'rover'">
        <section class="ck-section">
          <div class="ck-section-head"><span class="ck-section-title">Status</span></div>
          <template v-if="roverStatus.connected">
            <StatusRows v-if="status.nav.value" :rows="status.nav.value.rows" />
            <StatusRows v-if="status.fix.value" :rows="status.fix.value.rows" class="spaced" />
          </template>
          <p v-else class="ck-hint">
            Offline<template v-if="status.disconnect.value?.ago"> for {{ status.disconnect.value.ago }}</template>
            <template v-if="status.disconnect.value?.label !== 'UNKNOWN'"> ({{ status.disconnect.value?.label }})</template>.
          </p>
        </section>

        <section class="ck-section">
          <div class="ck-section-head"><span class="ck-section-title">Corrections</span></div>
          <p v-if="gps.baseNoReceiver.value" class="alert">The GPS unit is not acting as a base station. Connect it, or switch to NGII.</p>
          <div class="sources" role="radiogroup" aria-label="Rover correction source">
            <label :class="['source', { active: gps.gpsConfig.value.ntrip_source === 'ngii' }]">
              <input type="radio" :checked="gps.gpsConfig.value.ntrip_source === 'ngii'" :disabled="gps.gpsSaving.value" @change="gps.setNtripSource('ngii')" />
              <span><strong>NGII network</strong><span class="ck-hint">Nearest NGII base station, picked automatically</span></span>
            </label>
            <label :class="['source', { active: gps.gpsConfig.value.ntrip_source === 'base', disabled: !gps.hasSurveyedPoint.value }]">
              <input type="radio" :checked="gps.gpsConfig.value.ntrip_source === 'base'" :disabled="gps.gpsSaving.value || !gps.hasSurveyedPoint.value"
                @change="gps.setNtripSource('base', gps.selectedBasePointId.value)" />
              <span><strong>GPS unit as base station</strong><span class="ck-hint">{{ gps.hasSurveyedPoint.value ? "The unit on a surveyed point sends corrections" : "Survey a point with the GPS unit first" }}</span></span>
            </label>
          </div>
          <label v-if="gps.gpsConfig.value.ntrip_source === 'base'" class="ck-field spaced">Base point
            <select v-model.number="gps.selectedBasePointId.value" class="ck-select" :disabled="gps.gpsSaving.value" @change="gps.setNtripSource('base', gps.selectedBasePointId.value)">
              <option v-for="p in gps.surveyedPoints.value" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <form v-else class="spaced" @submit.prevent="saveLogin('rover')">
            <label class="ck-field">Rover NGII login
              <span class="ck-row">
                <input v-model="roverLogin" class="ck-input ck-grow" maxlength="128" autocomplete="off" spellcheck="false" placeholder="NGII account ID" :disabled="loginSaving" />
                <button class="ck-btn primary" type="submit" :disabled="loginSaving || roverLogin.trim() === (roverStatus.ntrip_username ?? '')">Save</button>
              </span>
            </label>
          </form>
        </section>

        <section v-if="roverStatus.connected" class="ck-section">
          <div class="ck-section-head">
            <span class="ck-section-title">Battery</span>
            <button class="ck-btn quiet" @click="showBattery = true">Calibrate voltage</button>
          </div>
          <StatusRows v-if="status.battery.value" :rows="status.battery.value.rows" />
          <p v-else class="ck-hint">No battery reading yet.</p>
        </section>

        <section v-if="roverStatus.connected" class="ck-section">
          <div class="ck-section-head"><span class="ck-section-title">Lights and pump</span></div>
          <div class="lights" role="radiogroup" aria-label="Nav lights">
            <button
              v-for="m in NAV_LIGHT_MODES" :key="m.mode" role="radio"
              :aria-checked="status.navLights.value?.mode === m.mode" :disabled="rover.navLightsBusy.value"
              :class="['ck-btn', { active: status.navLights.value?.mode === m.mode }]" @click="rover.setNavLights(m.mode)"
            >{{ m.label }}</button>
          </div>
          <label class="ck-field spaced">TSAL brightness {{ Math.round(rover.ledBrightness.value / 255 * 100) }}%
            <input type="range" min="0" max="255" step="5" :value="rover.ledBrightness.value" @input="rover.setLedBrightness($event.target.value)" />
          </label>
          <label class="ck-field spaced">Dispense time {{ rover.pumpDuration.value.toFixed(1) }} s
            <input type="range" min="0.5" max="10" step="0.5" :value="rover.pumpDuration.value" @input="rover.setPumpDuration($event.target.value)" />
          </label>
        </section>

        <section class="ck-section">
          <div class="ck-section-head">
            <span class="ck-section-title">Calibration</span>
            <button class="ck-btn" :disabled="!roverStatus.connected" @click="showCalibration = true"><ConsoleIcon name="calibrate" :size="15" />Open</button>
          </div>
          <p class="ck-hint">Antenna offset and wheel encoder scale.</p>
        </section>

        <section class="ck-section">
          <div class="ck-section-head"><span class="ck-section-title">Software</span></div>
          <StatusRows :rows="status.software.value" />
        </section>
      </template>

      <!-- GPS unit -->
      <template v-else-if="drawer === 'gps'">
        <section class="ck-section">
          <div class="ck-section-head">
            <span class="ck-section-title">Status</span>
            <button
              :class="['ck-btn', 'quiet', { active: editor.followReceiver.value }]" :aria-pressed="editor.followReceiver.value"
              :disabled="!gps.receiverCanTrack.value" @click="editor.followReceiver.value = !editor.followReceiver.value"
            ><ConsoleIcon name="follow" :size="15" />Follow</button>
          </div>
          <StatusRows :rows="status.receiver.value" />
        </section>

        <section class="ck-section">
          <form @submit.prevent="saveLogin('gps')">
            <label class="ck-field">NGII login
              <span class="ck-row">
                <input v-model="gpsLogin" class="ck-input ck-grow" maxlength="128" autocomplete="off" spellcheck="false" placeholder="NGII account ID" :disabled="!gps.receiver.value?.online || loginSaving" />
                <button class="ck-btn primary" type="submit" :disabled="!gps.receiver.value?.online || loginSaving || gpsLogin.trim() === (gps.gpsUnitConfig.value.ntrip_username ?? '')">Save</button>
              </span>
            </label>
          </form>
          <p class="ck-hint spaced">The unit needs it for RTK and for surveying base-station positions.</p>
        </section>

        <section class="ck-section">
          <div class="ck-section-head"><span class="ck-section-title">Survey points</span></div>
          <form class="ck-row" @submit.prevent="addPoint">
            <input v-model="newPointName" class="ck-input ck-grow" placeholder="Survey point name" maxlength="100" aria-label="Survey point name" />
            <button class="ck-btn primary" type="submit" :disabled="!newPointName.trim()">Add</button>
          </form>
          <div v-if="gps.surveyPoints.value.length === 0" class="ck-empty">No survey points. A surveyed point lets the unit serve as a base station.</div>
          <ul v-else class="points">
            <li
              v-for="p in gps.surveyPoints.value" :key="p.id" :data-survey-id="p.id"
              :class="['point', { selected: editor.selectedSurveyPointId.value === p.id, clickable: p.lat != null }]"
              data-testid="survey-point" @click="focusPoint(p)"
            >
              <div class="ck-row">
                <strong class="ck-grow">{{ p.name }}</strong>
                <span v-if="gps.gpsConfig.value.active_base_point_id === p.id" class="ck-badge warn">Base station</span>
                <span v-else-if="p.lat == null" class="ck-badge">Not surveyed</span>
                <span v-else class="ck-badge ok">Surveyed</span>
              </div>
              <div v-if="p.lat != null" class="ck-hint mono">
                {{ formatLatLng(p.lat, p.lng) }}<template v-if="p.alt != null"> · {{ formatAlt(p.alt) }} m</template>
                <template v-if="p.h_acc_m != null"> · ±{{ (p.h_acc_m * 100).toFixed(1) }} cm</template>
                <template v-if="p.surveyed_at"> · {{ formatSnapshotTime(p.surveyed_at) }}</template>
              </div>
              <template v-if="gps.surveyingPointId.value === p.id">
                <div class="survey-live">
                  <span>Surveying<template v-if="gps.surveyProgress.value"> · {{ gps.surveyProgress.value.samples }} samples · {{ gps.surveyProgress.value.remaining }} s left</template></span>
                  <div class="survey-bar"><div class="survey-fill" :style="{ width: `${gps.surveyProgress.value?.pct || 0}%` }"></div></div>
                </div>
                <div class="ck-row end"><button class="ck-btn quiet danger-text" @click.stop="gps.cancelSurvey(p)">Cancel survey</button></div>
              </template>
              <div v-else class="ck-row end">
                <button class="ck-btn" :disabled="!gps.receiverConnected.value || gps.baseState.value !== 'idle'" @click.stop="gps.startSurvey(p)">{{ p.lat != null ? "Resurvey" : "Survey" }}</button>
                <button
                  class="ck-btn quiet danger-text" :disabled="gps.gpsConfig.value.active_base_point_id === p.id"
                  :title="gps.gpsConfig.value.active_base_point_id === p.id ? 'The active base station cannot be deleted' : 'Delete'"
                  @click.stop="deletePoint(p)"
                >Delete</button>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <CalibrationDialog v-if="showCalibration" @close="showCalibration = false" />
    <BatteryDialog v-if="showBattery" @close="showBattery = false" />
  </aside>
</template>

<style scoped>
.drawer {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 900;
  width: min(420px, 100%);
  display: flex; flex-direction: column;
  background: var(--bg-secondary); border-left: 1px solid var(--border-color);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.18);
}
.drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border-color); }
.drawer-head .ck-seg-btn { display: inline-flex; align-items: center; gap: 0.3rem; }
.drawer-body { flex: 1; overflow-y: auto; }
.spaced { margin-top: 0.6rem; }
.alert { margin-bottom: 0.6rem; padding: 0.5rem 0.65rem; border-radius: 8px; font-size: 0.82rem; background: rgba(245, 158, 11, 0.14); border: 1px solid rgba(245, 158, 11, 0.45); }
.sources { display: flex; flex-direction: column; gap: 0.4rem; }
.source { display: flex; gap: 0.6rem; align-items: flex-start; padding: 0.55rem 0.65rem; border: 1px solid var(--border-color); border-radius: 10px; cursor: pointer; }
.source.active { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 6%, transparent); }
.source.disabled { opacity: 0.6; cursor: default; }
.source > span { display: flex; flex-direction: column; gap: 0.1rem; font-size: 0.88rem; }
.source input { margin-top: 0.25rem; }
.lights { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.mono { font-family: "JetBrains Mono", monospace; font-size: 0.74rem; }
.points { list-style: none; margin: 0.6rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.point { padding: 0.55rem 0.65rem; border: 1px solid var(--border-color); border-radius: 10px; display: flex; flex-direction: column; gap: 0.3rem; }
.point.clickable { cursor: pointer; }
.point.selected { border-color: #38bdf8; }
.end { justify-content: flex-end; }
.survey-live { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.8rem; }
.survey-bar { height: 6px; border-radius: 3px; background: var(--bg-hover); overflow: hidden; }
.survey-fill { height: 100%; background: var(--accent-primary); transition: width 0.4s linear; }
.danger-text { color: var(--accent-danger, #ef4444); }
@media (max-width: 768px) {
  .drawer { position: fixed; inset: 52px 0 0 0; width: 100%; z-index: 1100; }
}
</style>
