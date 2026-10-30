import { computed } from "vue";
import { createHttpTransport } from "fsk-coursekeeper/console/transport.mjs";
import { createDeviceRegistry } from "fsk-coursekeeper/console/devices.mjs";
import { deviceUrl, loadSettings } from "./settings.mjs";

// The standalone host: courses live in this browser, the person at the console
// may do everything, and device addresses come from this browser's settings,
// read again on every refresh.
export function createLocalHost({ course }) {
  const allowed = computed(() => true);
  return {
    course,
    devices: createDeviceRegistry({
      load: async () => loadSettings().devices.map(({ host, ...device }) => ({ ...device, url: deviceUrl(host) })),
      createTransport: (url) => createHttpTransport(url, { credentials: "omit" }),
    }),
    access: { permission: () => allowed },
    features: { publication: false },
    publicCourses: null,
    // Set by the release build; local builds are "dev".
    version: import.meta.env.VITE_COURSEKEEPER_VERSION || "dev",
  };
}
