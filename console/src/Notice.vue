<script setup>
defineProps({ title: { type: String, required: true }, message: { type: String, default: "" } });
</script>

<template>
  <main class="notice">
    <h1>{{ title }}</h1>
    <p>{{ message }}</p>
  </main>
</template>

<style scoped>
.notice {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 1rem;
  text-align: center;
  background: var(--bg-primary);
  color: var(--text-primary);
}
h1 { font-size: 1.2rem; }
p { color: var(--text-secondary); }
</style>
