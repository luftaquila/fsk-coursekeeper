<script setup>
import { useConsoleState } from "../../state/console.mjs";
import ConsoleDialog from "../ui/ConsoleDialog.vue";

// The checks before a mission starts or resumes. Blocking failures cannot be
// overridden; the rest can be forced once the operator accepts them.
const { mission } = useConsoleState();
const {
  preflightMode, preflightEmptyRouteMode, preflightChecks, preflightFlash, preflightForce,
  preflightAllOk, preflightHasBlockingFailure, preflightCanConfirm, executedIndex,
} = mission;
</script>

<template>
  <ConsoleDialog :title="preflightMode === 'resume' ? 'Pre-resume check' : 'Preflight check'" width="460px" @close="mission.cancelPreflight()">
    <p v-if="preflightMode === 'resume'" class="note">
      Skips the {{ executedIndex }} completed items and continues only the remaining route stored on the server.
    </p>
    <p v-if="preflightEmptyRouteMode === 'return_only'" class="note">
      Returns from the current position to the mission start point without visiting cones.
    </p>
    <p v-else-if="preflightEmptyRouteMode === 'resolve_uncertain'" class="note">
      Resolves the uncertain last dispense result by operator judgment and completes the mission without further movement.
    </p>
    <ul class="checks" data-testid="preflight-checks">
      <li v-for="c in preflightChecks" :key="c.key" :class="['check', c.ok ? 'ok' : 'fail', { flash: preflightFlash[c.key] }]">
        <span class="mark">{{ c.ok ? "✓" : "✗" }}</span>
        <span class="label">{{ c.label }}</span>
        <span v-if="c.detail" class="detail">{{ c.detail }}</span>
      </li>
    </ul>
    <label v-if="!preflightAllOk && !preflightHasBlockingFailure" class="override">
      <input v-model="preflightForce" type="checkbox" />
      I understand the warnings and want to force the run
    </label>
    <template #footer>
      <button class="ck-btn quiet" @click="mission.cancelPreflight()">Cancel</button>
      <button class="ck-btn primary" :disabled="!preflightCanConfirm" @click="mission.confirmPreflight()">
        {{ preflightMode === "resume" ? "Resume mission" : "Run" }}
      </button>
    </template>
  </ConsoleDialog>
</template>

<style scoped>
.note { margin-bottom: 0.6rem; padding: 0.5rem 0.7rem; border-radius: 8px; background: var(--bg-primary); font-size: 0.82rem; }
.checks { list-style: none; margin: 0; padding: 0; }
.check { display: grid; grid-template-columns: 1.2rem 1fr auto; gap: 0.5rem; align-items: baseline; padding: 0.4rem 0.2rem; border-bottom: 1px solid var(--border-color); font-size: 0.86rem; }
.check .mark { font-weight: 800; }
.check.ok .mark { color: #16a34a; }
.check.fail .mark { color: #dc2626; }
.detail { font-family: "JetBrains Mono", monospace; font-size: 0.74rem; color: var(--text-secondary); text-align: right; }
.check.flash { animation: flash 1.2s ease; }
@keyframes flash { 0%, 60% { background: rgba(245, 158, 11, 0.25); } 100% { background: transparent; } }
.override { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.75rem; padding: 0.5rem 0.6rem; border-radius: 8px; background: rgba(239, 68, 68, 0.08); font-size: 0.84rem; }
</style>
