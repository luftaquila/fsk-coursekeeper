import { inject } from "vue";

// The console is host-agnostic. A host provides:
//   course     transport for course data (the shared course REST routes + events)
//   devices    device registry (devices.mjs) for rover and GPS unit APIs
//   access     { permission(key) → ComputedRef<boolean> } for
//              "course.operate" | "course.manage" | "rover.operate"
//   features   { publication: boolean } host-only capabilities
//   publicCourses  { request(path, { signal }) } read-only published course
//              data for the public viewer (hosts with publication only)
//   version    optional release version of this console build (vX.Y.Z,
//              edge-<sha>, or dev), shown next to the device versions
export const HOST_KEY = Symbol("course-console-host");

export function useHost() {
  const host = inject(HOST_KEY, null);
  if (!host) throw new Error("The course console host is not provided.");
  return host;
}
