declare module "leaflet-polylineoffset";

import "leaflet";

// Augments Leaflet's own types with what leaflet-polylineoffset adds to
// L.Polyline at runtime (a plain JS plugin with no types of its own).
declare module "leaflet" {
  interface PolylineOptions {
    // Perpendicular shift in pixels, recalculated on every redraw/zoom —
    // used to keep same-road route lines visually side by side instead of
    // stacking exactly on top of each other.
    offset?: number;
  }
}
