<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { Toaster } from "vue-sonner";

// Follow the page theme (documentElement[data-theme]) for every change path.
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

const theme = ref(currentTheme());
let observer;

onMounted(() => {
  theme.value = currentTheme();
  observer = new MutationObserver(() => {
    theme.value = currentTheme();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
});

onUnmounted(() => {
  observer?.disconnect();
});
</script>

<template>
  <Toaster rich-colors :theme="theme" position="bottom-right" :duration="3500" />
</template>
