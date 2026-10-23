<script setup>
// Key/value status rows: [key, value, tone?].
defineProps({ rows: { type: Array, required: true } });
</script>

<template>
  <div class="ck-rows">
    <template v-for="r in rows" :key="r[0]">
      <span class="k">{{ r[0] }}</span>
      <span :class="['v', r[2] && `ck-tone-${r[2]}`]">{{ r[1] }}</span>
    </template>
  </div>
</template>
