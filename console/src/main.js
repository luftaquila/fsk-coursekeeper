import { createApp } from "vue";
import "fsk-coursekeeper/console/styles/base.css";
import "fsk-coursekeeper/console/styles/layout.css";
import "fsk-coursekeeper/console/styles/console.css";
import "leaflet/dist/leaflet.css";
import "vue-sonner/style.css";
import { HOST_KEY } from "fsk-coursekeeper/console/host.mjs";
import { setBaseMapKey } from "fsk-coursekeeper/console/lib/course-map.mjs";
import App from "./App.vue";
import Notice from "./Notice.vue";
import { createLocalHost } from "./local-host.mjs";
import { loadSettings } from "./settings.mjs";
import { startStorage } from "./storage/client.mjs";

function followSystemTheme() {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.setAttribute("data-theme", query.matches ? "dark" : "light");
  apply();
  query.addEventListener("change", apply);
}

// The browser database allows one connection, so only one tab may hold it.
function acquireTabLock() {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request("fsk-coursekeeper-storage", { ifAvailable: true }, (lock) => {
      resolve(lock != null);
      return lock ? new Promise(() => {}) : undefined;
    });
  });
}

async function boot() {
  followSystemTheme();
  if (!(await acquireTabLock())) {
    createApp(Notice, { title: "Coursekeeper is open in another tab", message: "Close the other tab, then reload this one." }).mount("#app");
    return;
  }
  let storage;
  try {
    storage = await startStorage();
  } catch (error) {
    createApp(Notice, { title: "Could not open the course storage", message: error.message }).mount("#app");
    return;
  }
  const settings = loadSettings();
  setBaseMapKey(settings.vworldKey);
  const host = createLocalHost({ course: storage.transport, settings });
  await host.devices.refresh();
  const app = createApp(App, { persistent: storage.persistent, storage: storage.transport, settings });
  app.provide(HOST_KEY, host);
  app.mount("#app");
}

boot();
