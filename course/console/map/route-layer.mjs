import L from "leaflet";
import { courseCenterlineLayer } from "../lib/course-map.mjs";

// The active course's centerline and its reusable route markers. One physical
// marker can be visited several times, so a marker shows its visit ranks.
// Markers take taps and drags only under the route-marker tool.
export function createRouteLayer({ getMap, course, editor }) {
  let centerlineLayer = null;
  let markerLayers = [];

  function drawCenterline(visible) {
    const map = getMap();
    if (centerlineLayer && map) { try { map.removeLayer(centerlineLayer); } catch {} }
    centerlineLayer = null;
    if (!map || !visible || !editor.showCenterline.value || !course.centerline.value?.ok) return;
    centerlineLayer = courseCenterlineLayer(course.centerline.value).addTo(map);
  }

  function clearMarkers() {
    const map = getMap();
    if (map) for (const marker of markerLayers) { try { map.removeLayer(marker); } catch {} }
    markerLayers = [];
  }

  // Hidden with the centerline unless the operator is placing markers.
  function rebuildMarkers(visible) {
    clearMarkers();
    const map = getMap();
    const editing = editor.tool.value === "marker";
    if (!map || !visible || !course.activeCourseId.value) return;
    if (!editor.showCenterline.value && !editing) return;
    const route = course.activeRoute.value;
    const visits = new Map();
    route.steps.forEach((id, index) => {
      const ranks = visits.get(id) || [];
      ranks.push(index + 1);
      visits.set(id, ranks);
    });
    route.markers.forEach((routeMarker, markerIndex) => {
      const ranks = visits.get(routeMarker.id) || [];
      const visibleRanks = ranks.length > 3 ? `${ranks.slice(0, 2).join("·")}…` : ranks.join("·");
      const text = visibleRanks || `M${markerIndex + 1}`;
      const marker = L.marker([routeMarker.lat, routeMarker.lng], {
        draggable: editing,
        interactive: editing,
        zIndexOffset: 900,
        icon: L.divIcon({
          className: "route-marker-host",
          html: `<div class="route-marker-pin${ranks.length ? " has-visits" : ""}"><span>${text}</span></div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
      });
      if (editing) {
        marker.on("click", (event) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          course.appendRouteVisit(routeMarker.id);
        });
        marker.on("dragend", async () => {
          const { lat, lng } = marker.getLatLng();
          await course.updateRouteMarker(routeMarker, { lat, lng });
        });
      }
      markerLayers.push(marker.addTo(map));
    });
  }

  return { drawCenterline, rebuildMarkers, clearMarkers };
}
