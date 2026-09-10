// Deterministic per-service-number color so the same bus line always gets
// the same hue across renders, without needing a maintained lookup table
// for ~800 services. High saturation/lightness keeps lines readable
// against the dark basemap.
export function colorForService(serviceNo: string): string {
  let hash = 0;
  for (let i = 0; i < serviceNo.length; i++) {
    hash = (hash * 31 + serviceNo.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 80%, 62%)`;
}
