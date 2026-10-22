import { COURSE_ROUTES, resultResponse } from "./routes.mjs";

function compile(path) {
  const source = path.replace(/:(\w+)/g, "(?<$1>[^/]+)");
  return new RegExp(`^${source}/?$`, "i");
}

// Dispatches course REST requests to the service without HTTP, for hosts that
// keep the data in-process (the standalone console's storage worker). Returns
// the rendered response plus the change events the service produced.
export function createCourseRouter(service, { actor = null } = {}) {
  const routes = COURSE_ROUTES.map((route) => ({ ...route, pattern: compile(route.path) }));
  return function handle(method, url, body) {
    const pathname = String(url).split("?")[0];
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(Object.entries(match.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const result = route.run(service, params, body ?? {}, { actor });
      return { ...resultResponse(result), events: result.ok ? result.events : [] };
    }
    return { status: 404, text: "API endpoint not found.", events: [] };
  };
}
