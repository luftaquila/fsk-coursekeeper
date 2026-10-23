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
  <!-- Top right, under the console header: clear of the header's E-stop and of
       the map's own controls. Phones get a slimmer toast (console.css). -->
  <Toaster
    rich-colors :theme="theme" position="top-right" :offset="{ top: 68, right: 16 }" :mobile-offset="{ top: 60 }" :duration="3500"
    :toast-options="{ class: 'ck-toast' }"
  />
</template>
