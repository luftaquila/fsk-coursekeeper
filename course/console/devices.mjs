import { reactive, ref } from "vue";

export const DEVICE_KINDS = ["rover", "gps"];

// Devices are listed by the host as { id, kind, label, url }. The console
// talks to one selected device per kind; the list keeps every device so more
// than one rover can be addressed by id.
export function createDeviceRegistry({ load, createTransport }) {
  const devices = ref([]);
  const selection = reactive(Object.fromEntries(DEVICE_KINDS.map((kind) => [kind, null])));
  const transports = new Map();
  const keyOf = (device) => `${device.kind}:${device.id}`;

  async function refresh() {
    const listed = await load();
    devices.value = Array.isArray(listed) ? listed : [];
    for (const kind of DEVICE_KINDS) {
      const ofKind = devices.value.filter((device) => device.kind === kind);
      if (!ofKind.some((device) => device.id === selection[kind])) selection[kind] = ofKind[0]?.id ?? null;
    }
  }

  function selected(kind) {
    return devices.value.find((device) => device.kind === kind && device.id === selection[kind]) || null;
  }

  function transport(kind) {
    const device = selected(kind);
    if (!device) return null;
    const key = `${keyOf(device)}@${device.url}`;
    if (!transports.has(key)) transports.set(key, createTransport(device.url, device));
    return transports.get(key);
  }

  function select(kind, id) {
    if (devices.value.some((device) => device.kind === kind && device.id === id)) selection[kind] = id;
  }

  return { devices, selection, refresh, selected, transport, select };
}
