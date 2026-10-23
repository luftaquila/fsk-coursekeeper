import { inject, provide, ref } from "vue";
import { useNotification } from "../notify.mjs";
import { createClock } from "./clock.mjs";
import { createCourseStore } from "./course-store.mjs";
import { createEditHistory } from "./edit-history.mjs";
import { createGpsStore } from "./gps-store.mjs";
import { createMissionStore } from "./mission-store.mjs";
import { createReviewStore } from "./review-store.mjs";
import { createRoverStore } from "./rover-store.mjs";

const CONSOLE_STATE_KEY = Symbol("course-console-state");

// Every store of one console, created once by the console root. The course
// comes from the host; the rover and the GPS unit from their own APIs.
export function createConsoleState(host) {
  const notify = useNotification();
  const clock = createClock();
  const access = {
    canOperateRover: host.access.permission("rover.operate"),
    canManageCourse: host.access.permission("course.manage"),
  };
  const edits = createEditHistory({ notifyError: notify.error });
  const course = createCourseStore({ host, notify, edits });
  const rover = createRoverStore({ host, notify, clock });
  const gps = createGpsStore({ host, notify, clock, rover, access });
  const mission = createMissionStore({ notify, course, rover });
  const review = createReviewStore({ notify, rover });

  // True while any event stream is down, so the console can say so instead of
  // silently freezing. Events sent while a link is down are lost; each link
  // resynchronizes once it is back.
  const reconnecting = ref(false);
  let streams = [];

  function connect() {
    const courseEvents = host.course.events();
    const roverEvents = host.devices.transport("rover")?.events() ?? null;
    const gpsEvents = host.devices.transport("gps")?.events() ?? null;
    streams = [courseEvents, roverEvents, gpsEvents].filter(Boolean);

    const droppedLinks = new Set();
    function watchLink(stream, name, resync) {
      stream.addEventListener("error", () => {
        droppedLinks.add(name);
        reconnecting.value = true;
      });
      stream.addEventListener("open", () => {
        if (!droppedLinks.delete(name)) return;
        if (droppedLinks.size === 0) reconnecting.value = false;
        resync();
      });
    }
    watchLink(courseEvents, "course", () => course.resync());
    course.attachEvents(courseEvents);
    if (roverEvents) {
      watchLink(roverEvents, "rover", () => mission.fetchRoverStatus());
      mission.attachRoverEvents(roverEvents);
    }
    if (gpsEvents) {
      watchLink(gpsEvents, "gps", () => gps.fetchStatus());
      gps.attachEvents(gpsEvents);
    }
  }

  function disconnect() {
    for (const stream of streams) stream.close();
    streams = [];
    reconnecting.value = false;
  }

  return { host, notify, clock, access, edits, course, rover, gps, mission, review, reconnecting, connect, disconnect };
}

export function provideConsoleState(state) {
  provide(CONSOLE_STATE_KEY, state);
}

export function useConsoleState() {
  const state = inject(CONSOLE_STATE_KEY, null);
  if (!state) throw new Error("The console state is not provided.");
  return state;
}
