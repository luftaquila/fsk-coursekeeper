<script>
// Open dialogs, topmost last.
const stack = [];
</script>

<script setup>
import { nextTick, onMounted, onUnmounted, ref, useId } from "vue";

// A modal dialog. Esc and a backdrop click close only the topmost open dialog;
// `closable` false holds it open while its work is in flight.
const props = defineProps({
  title: { type: String, required: true },
  width: { type: String, default: "440px" },
  closable: { type: Boolean, default: true },
});
const emit = defineEmits(["close"]);
const titleId = useId();
const panel = ref(null);

const token = Symbol("dialog");

function close() {
  if (props.closable) emit("close");
}

function onKeydown(e) {
  if (e.key !== "Escape" || stack[stack.length - 1] !== token) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}

onMounted(() => {
  stack.push(token);
  window.addEventListener("keydown", onKeydown, true);
  nextTick(() => panel.value?.querySelector("input, select, textarea, button:not(.ck-dialog-x)")?.focus());
});
onUnmounted(() => {
  const i = stack.indexOf(token);
  if (i >= 0) stack.splice(i, 1);
  window.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
  <Teleport to="body">
    <div class="ck-dialog-backdrop" @click.self="close">
      <section ref="panel" class="ck-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" :style="{ width: `min(${width}, calc(100vw - 1.5rem))` }">
        <header class="ck-dialog-head">
          <h2 :id="titleId">{{ title }}</h2>
          <button class="ck-dialog-x" :disabled="!closable" aria-label="Close" @click="close">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>
        <div class="ck-dialog-body"><slot /></div>
        <footer v-if="$slots.footer" class="ck-dialog-foot"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* Below the E-stop (z-index 4000), which every dialog must leave reachable. */
.ck-dialog-backdrop {
  position: fixed; inset: 0; z-index: 1500;
  display: flex; align-items: center; justify-content: center;
  padding: calc(var(--ck-header-h, 0px) + 0.75rem) 0.75rem 0.75rem;
  background: rgba(15, 23, 42, 0.45);
}
.ck-dialog {
  max-height: calc(100dvh - var(--ck-header-h, 0px) - 1.5rem);
  display: flex; flex-direction: column;
  border: 1px solid var(--border-color); border-radius: 14px;
  background: var(--bg-secondary); color: var(--text-primary);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.3);
}
.ck-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.9rem 1rem 0.5rem; }
.ck-dialog-head h2 { font-size: 1.05rem; font-weight: 700; }
.ck-dialog-x {
  width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer;
}
.ck-dialog-x:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.ck-dialog-x:disabled { opacity: 0.4; cursor: default; }
.ck-dialog-body { padding: 0.25rem 1rem 1rem; overflow-y: auto; font-size: 0.88rem; }
.ck-dialog-foot { display: flex; justify-content: flex-end; gap: 0.5rem; padding: 0.75rem 1rem; border-top: 1px solid var(--border-color); }
</style>
