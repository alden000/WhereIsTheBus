function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Deterministic per-service-number color so the same bus line always gets
// the same hue across renders, without needing a maintained lookup table
// for ~800 services. High saturation/lightness keeps lines readable
// against the dark basemap.
export function colorForService(serviceNo: string): string {
  const hue = hashString(serviceNo) % 360;
  return `hsl(${hue}, 80%, 62%)`;
}

// Perpendicular pixel offsets a route line can be drawn at (via
// leaflet-polylineoffset) so two services sharing the same road render
// side by side instead of exactly on top of each other. Odd-length and
// centered on 0 so a line with nothing else sharing its road still runs
// straight down the real alignment rather than always being shifted.
const LINE_OFFSETS_PX = [0, -4, 4, -8, 8];

// A flat pixel offset is a screen-space effect, so it doesn't get any
// smaller just because the view has zoomed out — but a wide, zoomed-out
// view can have far more overlapping routes on screen at once, where
// fanning every one of them out would read as clutter rather than
// clarity (and roads themselves are barely distinguishable from each
// other at that scale anyway, so separating routes by a few px doesn't
// buy much). Fading the offset in with zoom keeps the wide view looking
// like today (routes overlapping, but nothing busy) and only fans lines
// out once zoomed in far enough to actually be looking at individual
// streets, which is also where the original overlap complaint mattered.
const OFFSET_FADE_START_ZOOM = 14;
const OFFSET_FULL_STRENGTH_ZOOM = 17;

// Deterministic per-line (service+direction) offset slot, same idea as
// colorForService — hashed rather than assigned by render order, so a
// given line doesn't jump sideways from one poll/pan to the next just
// because a different set of lines happened to be visible alongside it.
// Hashed on the full line key (not just the service number): a loop
// route's two directions run on different roads and shouldn't be forced
// to share one service-wide offset.
export function offsetForLine(lineKey: string, zoom: number): number {
  const baseOffset = LINE_OFFSETS_PX[hashString(lineKey) % LINE_OFFSETS_PX.length];
  const strength = Math.max(
    0,
    Math.min(1, (zoom - OFFSET_FADE_START_ZOOM) / (OFFSET_FULL_STRENGTH_ZOOM - OFFSET_FADE_START_ZOOM))
  );
  return baseOffset * strength;
}
