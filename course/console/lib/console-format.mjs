// Time formats shared by the console panels.

export function formatSnapshotTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ko-KR", { hour12: false });
}

export function formatLogTime(ms) {
  if (!ms) return "—";
  // "YYYY. M. D. H:MM:SS AM/PM": ko-KR date, en-US 12-hour time.
  const d = new Date(ms);
  return `${d.toLocaleDateString("ko-KR")} ${d.toLocaleTimeString("en-US")}`;
}

export function formatMissionTimestamp(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ko-KR", { hour12: false });
}

export function formatMissionDuration(started, ended) {
  if (!ended) return "—";
  const s = Math.round((ended - started) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
