import { onScopeDispose, ref } from "vue";

// A 1 Hz tick so "time ago" values refresh even when no event arrives.
export function createClock() {
  const tick = ref(0);
  const timer = setInterval(() => { tick.value = (tick.value + 1) % 3600; }, 1000);
  onScopeDispose(() => clearInterval(timer));
  return { tick };
}
