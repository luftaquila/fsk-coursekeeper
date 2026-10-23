import { inject, provide, ref } from "vue";
import { useNotification } from "../notify.mjs";
import { createClock } from "./clock.mjs";
import { createCourseStore } from "./course-store.mjs";
import { createEditHistory } from "./edit-history.mjs";
import { createEditorStore } from "./editor-store.mjs";
import { createGpsStore } from "./gps-store.mjs";
import { createMissionStore } from "./mission-store.mjs";
import { createReviewStore } from "./review-store.mjs";
import { createRoverStore } from "./rover-store.mjs";
import { createStatusRows } from "./status-rows.mjs";

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
  const editor = createEditorStore({ access });
  const status = createStatusRows({ host, clock, rover, gps, mission });
  // Filled by the map once it exists: pan / focus actions the panels call.
  const mapActions = {};

  // The links ("course", "rover", "gps") whose event stream is down, so the
  // console can say so instead of silently freezing. Events sent while a link
  // is down are lost; each link resynchronizes once it is back.
  const droppedLinks = ref([]);
  let streams = [];

  function connect() {
    const courseEvents = host.course.events();
    const roverEvents = host.devices.transport("rover")?.events() ?? null;
    const gpsEvents = host.devices.transport("gps")?.events() ?? null;
    streams = [courseEvents, roverEvents, gpsEvents].filter(Boolean);

    function watchLink(stream, name, resync) {
      stream.addEventListener("error", () => {
        if (!droppedLinks.value.includes(name)) droppedLinks.value = [...droppedLinks.value, name];
      });
      stream.addEventListener("open", () => {
        if (!droppedLinks.value.includes(name)) return;
        droppedLinks.value = droppedLinks.value.filter((link) => link !== name);
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
    droppedLinks.value = [];
  }

  return { host, notify, clock, access, edits, course, rover, gps, mission, review, editor, status, mapActions, droppedLinks, connect, disconnect };
}

export function provideConsoleState(state) {
  provide(CONSOLE_STATE_KEY, state);
}

export function useConsoleState() {
  const state = inject(CONSOLE_STATE_KEY, null);
  if (!state) throw new Error("The console state is not provided.");
  return state;
}
