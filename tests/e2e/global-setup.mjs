import { startDevices } from "./devices.mjs";

// Starts the simulated rover and GPS unit once for the whole run; specs read
// their addresses from the environment. The returned function tears them down.
export default async function globalSetup(config) {
  const origin = config.projects[0].use.baseURL;
  const devices = await startDevices({ origin });
  process.env.E2E_ROVER_URL = devices.roverUrl;
  process.env.E2E_ROVER_DEVICE_URL = devices.roverDeviceUrl;
  process.env.E2E_GPS_URL = devices.gpsUrl;
  return () => devices.stop();
}
