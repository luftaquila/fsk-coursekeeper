<script setup>
import { useConsoleState } from "../../state/console.mjs";
import ConsoleIcon from "../ConsoleIcon.vue";

// Plays the selected mission's telemetry back on the map.
const { review } = useConsoleState();
const { missionDetail, missionSamples, replayPlaying, replayIdx, replaySpeed, currentSampleTime, currentSampleState, currentSampleFix } = review;
</script>

<template>
  <div class="replay" data-testid="replay">
    <button
      class="replay-play" :disabled="missionSamples.length === 0"
      :aria-label="replayPlaying ? 'Pause replay' : 'Play replay'" @click="review.togglePlay"
    ><ConsoleIcon :name="replayPlaying ? 'pause' : 'play'" /></button>
    <div class="replay-track">
      <div class="replay-meta">
        <strong>Mission #{{ missionDetail.id }}</strong>
        <span>{{ currentSampleTime }}</span>
        <span class="replay-state">{{ currentSampleState }} · {{ currentSampleFix }}</span>
      </div>
      <input
        type="range" class="replay-slider" aria-label="Replay position"
        :min="0" :max="Math.max(0, missionSamples.length - 1)" :step="1"
        v-model.number="replayIdx" :disabled="missionSamples.length === 0"
      />
    </div>
    <select v-model.number="replaySpeed" class="replay-speed" aria-label="Replay speed">
      <option :value="1">1×</option>
      <option :value="4">4×</option>
      <option :value="16">16×</option>
      <option :value="64">64×</option>
    </select>
  </div>
</template>

<style scoped>
.replay {
  position: absolute; left: 50%; transform: translateX(-50%); z-index: 600;
  width: min(720px, calc(100% - 7rem));
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border-color); border-radius: 12px;
  background: var(--bg-secondary); color: var(--text-primary);
  box-shadow: var(--shadow-hover);
}
.replay-play {
  flex: none; width: 40px; height: 40px; border-radius: 50%; border: none;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-primary); color: #fff; cursor: pointer;
}
.replay-play:disabled { opacity: 0.5; cursor: default; }
.replay-track { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.replay-meta { display: flex; gap: 0.6rem; align-items: baseline; font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; }
.replay-meta strong { color: var(--text-primary); }
.replay-state { font-family: "JetBrains Mono", monospace; overflow: hidden; text-overflow: ellipsis; }
.replay-slider { width: 100%; }
.replay-speed {
  flex: none; padding: 0.3rem 0.4rem; border: 1px solid var(--border-color); border-radius: 6px;
  background: var(--bg-input); color: var(--text-primary);
}
@media (max-width: 768px) {
  .replay { width: calc(100% - 1.5rem); }
}
</style>
