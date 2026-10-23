<script setup>
import { computed, ref } from "vue";
import { useNotification } from "fsk-coursekeeper/console/notify.mjs";
import { deviceUrlProblem, saveSettings } from "./settings.mjs";

const props = defineProps({
  settings: { type: Object, required: true },
  storage: { type: Object, required: true },
  persistent: { type: Boolean, required: true },
});
const emit = defineEmits(["close"]);
const { error: notifyError } = useNotification();

const devices = ref(props.settings.devices.map((device) => ({ ...device })));
const vworldKey = ref(props.settings.vworldKey);
const busy = ref(false);
const importInput = ref(null);

const problems = computed(() => devices.value.map((device) => deviceUrlProblem(device.url.trim())));
const canSave = computed(() => !busy.value && problems.value.every((problem) => problem == null));

function addDevice(kind) {
  devices.value.push({ id: crypto.randomUUID(), kind, label: kind === "rover" ? "Rover" : "GPS unit", url: "" });
}

function removeDevice(index) {
  devices.value.splice(index, 1);
}

// Device connections and the basemap are set up when the console starts.
function save() {
  const saved = saveSettings({
    devices: devices.value.map((device) => ({
      id: device.id,
      kind: device.kind,
      label: device.label.trim() || (device.kind === "rover" ? "Rover" : "GPS unit"),
      url: device.url.trim().replace(/\/+$/, ""),
    })),
    vworldKey: vworldKey.value.trim(),
  });
  if (!saved) {
    notifyError("This browser blocked saving settings.");
    return;
  }
  window.location.reload();
}

async function exportDatabase() {
  busy.value = true;
  try {
    const bytes = await props.storage.exportDatabase();
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.sqlite3" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `fsk-coursekeeper-${new Date().toISOString().slice(0, 10)}.sqlite3`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    notifyError(`Export failed: ${error.message}`);
  } finally {
    busy.value = false;
  }
}

async function importDatabase(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!window.confirm("Replace every course in this browser with the selected backup?")) return;
  busy.value = true;
  try {
    await props.storage.importDatabase(new Uint8Array(await file.arrayBuffer()));
    window.location.reload();
  } catch (error) {
    notifyError(`Import failed: ${error.message}`);
    busy.value = false;
  }
}
</script>

<template>
  <div class="settings-backdrop" @click.self="emit('close')">
    <section class="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <h2 id="settings-title">Settings</h2>

      <h3>Devices</h3>
      <p class="hint">Device API addresses on your tailnet, e.g. <code>https://fsk-coursekeeper-rover.your-tailnet.ts.net</code>.</p>
      <div v-for="(device, index) in devices" :key="device.id" class="device-row">
        <select v-model="device.kind" aria-label="Device type">
          <option value="rover">Rover</option>
          <option value="gps">GPS unit</option>
        </select>
        <input v-model="device.label" class="device-label" placeholder="Name" aria-label="Device name" />
        <input v-model="device.url" class="device-url" placeholder="https://…" aria-label="Device address" />
        <button class="btn btn-ghost btn-sm" aria-label="Remove device" @click="removeDevice(index)">×</button>
        <p v-if="device.url && problems[index]" class="device-problem">{{ problems[index] }}</p>
      </div>
      <div class="row">
        <button class="btn btn-ghost btn-sm" @click="addDevice('rover')">+ Rover</button>
        <button class="btn btn-ghost btn-sm" @click="addDevice('gps')">+ GPS unit</button>
      </div>

      <h3>Map</h3>
      <label class="field">
        VWorld API key
        <input v-model="vworldKey" placeholder="Leave empty to use Google imagery" />
      </label>
      <p class="hint">VWorld imagery matches Korean survey coordinates; the key must be registered for this site's domain.</p>

      <h3>Courses</h3>
      <p class="hint">Courses are stored in this browser. Back them up to move them to another computer.</p>
      <div class="row">
        <button class="btn btn-ghost btn-sm" :disabled="busy || !persistent" @click="exportDatabase">Export backup</button>
        <button class="btn btn-ghost btn-sm" :disabled="busy || !persistent" @click="importInput.click()">Restore backup</button>
        <input ref="importInput" type="file" accept=".sqlite3,application/vnd.sqlite3" hidden @change="importDatabase" />
      </div>

      <div class="actions">
        <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="!canSave" @click="save">Save and reload</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(var(--ck-header-h, 0px) + 1rem) 1rem 1rem;
  background: rgba(0, 0, 0, 0.45);
}
.settings {
  width: min(640px, 100%);
  max-height: 100%;
  overflow: auto;
  padding: 1.25rem;
  border-radius: 12px;
  background: var(--bg-card);
  color: var(--text-primary);
  box-shadow: var(--shadow-hover);
}
h2 { margin: 0 0 0.75rem; font-size: 1.15rem; }
h3 { margin: 1rem 0 0.35rem; font-size: 0.95rem; }
.hint { margin: 0 0 0.5rem; color: var(--text-secondary); font-size: 0.85rem; }
.device-row {
  display: grid;
  grid-template-columns: 7rem 8rem 1fr auto;
  gap: 0.4rem;
  margin-bottom: 0.4rem;
}
.device-problem { grid-column: 1 / -1; margin: 0; color: var(--accent-danger); font-size: 0.8rem; }
.row, .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.actions { justify-content: flex-end; margin-top: 1.25rem; }
.field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.9rem; }
input, select {
  min-width: 0;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
}
@media (max-width: 560px) {
  .device-row { grid-template-columns: 1fr 1fr auto; }
  .device-url { grid-column: 1 / -1; grid-row: 2; }
}
</style>
