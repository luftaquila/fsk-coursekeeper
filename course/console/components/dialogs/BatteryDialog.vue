<script setup>
import { ref } from "vue";
import { useConsoleState } from "../../state/console.mjs";
import ConsoleDialog from "../ui/ConsoleDialog.vue";

// Scales the battery reading to a multimeter measurement.
const emit = defineEmits(["close"]);
const state = useConsoleState();
const { rover } = state;
const { roverStatus } = rover;

// Starts from the displayed voltage: the operator only nudges the digits.
const v = roverStatus.value.battery?.voltage;
const measured = ref(typeof v === "number" ? v.toFixed(2) : "");
const submitting = ref(false);

async function save() {
  const measuredV = Number(measured.value);
  if (!Number.isFinite(measuredV) || measuredV < 15 || measuredV > 32) {
    state.notify.warning("The measured value must be a number from 15 to 32 V.");
    return;
  }
  submitting.value = true;
  try {
    await rover.request("/api/rover/calibrate-battery", { method: "POST", body: JSON.stringify({ measured_v: measuredV }) });
    emit("close");
  } catch (err) {
    state.notify.error(err.message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <ConsoleDialog title="Battery voltage calibration" width="400px" :closable="!submitting" @close="emit('close')">
    <div class="ck-rows current">
      <span class="k">Displayed</span><span class="v">{{ roverStatus.battery?.voltage != null ? `${roverStatus.battery.voltage.toFixed(2)} V` : "—" }}</span>
      <template v-if="roverStatus.battery?.voltage_raw != null">
        <span class="k">ADC</span><span class="v">{{ roverStatus.battery.voltage_raw.toFixed(2) }} V</span>
      </template>
      <span class="k">Gain</span><span class="v">{{ roverStatus.battery?.gain != null ? roverStatus.battery.gain.toFixed(4) : "—" }}</span>
    </div>
    <label class="ck-field">Measured voltage (V)
      <input v-model="measured" class="ck-input" type="number" step="0.01" min="15" max="32" :disabled="submitting" @keyup.enter="save" />
    </label>
    <template #footer>
      <button class="ck-btn quiet" :disabled="submitting" @click="emit('close')">Cancel</button>
      <button class="ck-btn primary" :disabled="submitting || !measured" @click="save">{{ submitting ? "Saving…" : "Save" }}</button>
    </template>
  </ConsoleDialog>
</template>

<style scoped>
.current { margin-bottom: 0.9rem; padding: 0.5rem 0.7rem; border-radius: 8px; background: var(--bg-primary); }
</style>
