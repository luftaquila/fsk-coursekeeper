import { computed } from "vue";
import { createHttpTransport } from "fsk-coursekeeper/console/transport.mjs";
import { createDeviceRegistry } from "fsk-coursekeeper/console/devices.mjs";

// The standalone host: courses live in this browser, the person at the console
// may do everything, and device addresses come from this browser's settings.
export function createLocalHost({ course, settings }) {
  const allowed = computed(() => true);
  return {
    course,
    devices: createDeviceRegistry({
      load: async () => settings.devices.map((device) => ({ ...device, url: device.url.replace(/\/+$/, "") })),
      createTransport: (url) => createHttpTransport(url, { credentials: "omit" }),
    }),
    access: { permission: () => allowed },
    features: { publication: false },
    publicCourses: null,
  };
}
