// Pure geometry helpers for animating a bus along its road-snapped route:
// projecting a live GPS position onto the route polyline, slicing out the
// stretch ahead of it, and walking along that stretch by distance.

export type LatLng = [number, number];

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Closest point to `p` on segment [a, b], via a local equirectangular
// approximation (longitude scaled by cos(latitude)) — accurate enough at
// the scale of a single road segment, much cheaper than exact geodesics.
function projectOntoSegment(p: LatLng, a: LatLng, b: LatLng): LatLng {
  const cosLat = Math.cos(toRad(a[0]));
  const ax = a[1] * cosLat;
  const ay = a[0];
  const bx = b[1] * cosLat;
  const by = b[0];
  const px = p[1] * cosLat;
  const py = p[0];

  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export interface PathProjection {
  point: LatLng;
  // Cumulative distance (meters) from the start of the path to `point`.
  distanceAlong: number;
}

// Finds the point on a polyline closest to `p`, and how far along the
// polyline (from its start) that point is.
export function projectOntoPath(p: LatLng, path: LatLng[]): PathProjection {
  if (path.length === 0) return { point: p, distanceAlong: 0 };
  if (path.length === 1) return { point: path[0], distanceAlong: 0 };

  let best: PathProjection & { distToP: number } = {
    point: path[0],
    distanceAlong: 0,
    distToP: Infinity,
  };
  let cumulative = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const segStart = path[i];
    const segEnd = path[i + 1];
    const segLen = haversineMeters(segStart, segEnd);
    const projected = projectOntoSegment(p, segStart, segEnd);
    const distToP = haversineMeters(p, projected);

    if (distToP < best.distToP) {
      best = {
        point: projected,
        distanceAlong: cumulative + haversineMeters(segStart, projected),
        distToP,
      };
    }
    cumulative += segLen;
  }

  return { point: best.point, distanceAlong: best.distanceAlong };
}

// Same as projectOntoPath, but only considers the stretch of the path
// whose cumulative distance-from-start falls within [minDistance,
// maxDistance]. A route that loops can pass close to its own earlier or
// later self (a return leg running near the outbound one, or simply the
// loop's own start/end sitting near each other) — an unconstrained
// nearest-point search can then jump between two geometrically-close
// but topologically-distant passes for barely-different raw
// coordinates, which is exactly what let two sightings of one real bus
// resolve to wildly different distances-along-the-path. Anchoring the
// search to the stretch a caller already has good reason to expect the
// point to fall within (e.g. "somewhere behind the stop this bus was
// reported at, no further back than its ETA allows") resolves that
// ambiguity. Falls back to the unconstrained search if the given range
// excludes the entire path (e.g. a bad anchor), rather than returning
// nothing useful.
export function projectOntoPathInRange(
  p: LatLng,
  path: LatLng[],
  minDistance: number,
  maxDistance: number
): PathProjection {
  if (path.length <= 1) return projectOntoPath(p, path);

  let best: PathProjection & { distToP: number } = {
    point: path[0],
    distanceAlong: 0,
    distToP: Infinity,
  };
  let cumulative = 0;
  let sawSegmentInRange = false;

  for (let i = 0; i < path.length - 1; i++) {
    const segStart = path[i];
    const segEnd = path[i + 1];
    const segLen = haversineMeters(segStart, segEnd);
    const segEndCumulative = cumulative + segLen;

    if (segEndCumulative >= minDistance && cumulative <= maxDistance) {
      sawSegmentInRange = true;
      const projected = projectOntoSegment(p, segStart, segEnd);
      const distToP = haversineMeters(p, projected);
      if (distToP < best.distToP) {
        best = {
          point: projected,
          distanceAlong: cumulative + haversineMeters(segStart, projected),
          distToP,
        };
      }
    }
    cumulative = segEndCumulative;
  }

  return sawSegmentInRange ? { point: best.point, distanceAlong: best.distanceAlong } : projectOntoPath(p, path);
}

// The stretch of `path` between two cumulative distances, as a fresh
// polyline starting exactly at `fromDist` and ending exactly at `toDist`.
// Returns a single-point path (just the start) if the range is empty or
// inverted (e.g. GPS jitter putting the bus's projection slightly ahead
// of the target stop's).
export function slicePathByDistance(path: LatLng[], fromDist: number, toDist: number): LatLng[] {
  if (path.length === 0) return [];
  if (toDist <= fromDist) return [pointAtDistance(path, fromDist)];

  const points: LatLng[] = [pointAtDistance(path, fromDist)];
  let cumulative = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const segLen = haversineMeters(path[i], path[i + 1]);
    const nextCumulative = cumulative + segLen;
    if (nextCumulative > fromDist && nextCumulative < toDist) {
      points.push(path[i + 1]);
    }
    cumulative = nextCumulative;
  }
  points.push(pointAtDistance(path, toDist));
  return points;
}

function pointAtDistance(path: LatLng[], distance: number): LatLng {
  if (path.length === 0) return [0, 0];
  if (distance <= 0) return path[0];

  let cumulative = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const segLen = haversineMeters(path[i], path[i + 1]);
    if (cumulative + segLen >= distance) {
      const t = segLen === 0 ? 0 : (distance - cumulative) / segLen;
      return [
        path[i][0] + (path[i + 1][0] - path[i][0]) * t,
        path[i][1] + (path[i + 1][1] - path[i][1]) * t,
      ];
    }
    cumulative += segLen;
  }
  return path[path.length - 1];
}

export interface LatLngBoundsLike {
  south: number;
  west: number;
  north: number;
  east: number;
}

function pointInBounds(p: LatLng, bounds: LatLngBoundsLike): boolean {
  return p[0] >= bounds.south && p[0] <= bounds.north && p[1] >= bounds.west && p[1] <= bounds.east;
}

function boundsOverlap(a: LatLngBoundsLike, b: LatLngBoundsLike): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

// Orientation of the turn p1->p2->p3: 0 collinear, 1 clockwise, 2
// counter-clockwise. Standard building block for segment-segment
// intersection (treating lat/lng as plain x/y — this is a topological
// test, not a distance one, so the equirectangular distortion doesn't
// matter).
function orientation(p1: LatLng, p2: LatLng, p3: LatLng): number {
  const val = (p2[1] - p1[1]) * (p3[0] - p2[0]) - (p2[0] - p1[0]) * (p3[1] - p2[1]);
  if (Math.abs(val) < 1e-12) return 0;
  return val > 0 ? 1 : 2;
}

function onSegment(a: LatLng, b: LatLng, p: LatLng): boolean {
  return (
    p[0] <= Math.max(a[0], b[0]) &&
    p[0] >= Math.min(a[0], b[0]) &&
    p[1] <= Math.max(a[1], b[1]) &&
    p[1] >= Math.min(a[1], b[1])
  );
}

function segmentsIntersect(p1: LatLng, p2: LatLng, p3: LatLng, p4: LatLng): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, p3)) return true;
  if (o2 === 0 && onSegment(p1, p2, p4)) return true;
  if (o3 === 0 && onSegment(p3, p4, p1)) return true;
  if (o4 === 0 && onSegment(p3, p4, p2)) return true;
  return false;
}

// Bounding box of a path — a cheap pre-check to skip the exact (and
// more expensive) segment-by-segment test in pathIntersectsBounds below
// for paths nowhere near the area in question.
export function pathBounds(path: LatLng[]): LatLngBoundsLike | null {
  if (path.length === 0) return null;
  let south = path[0][0];
  let north = path[0][0];
  let west = path[0][1];
  let east = path[0][1];
  for (const [lat, lng] of path) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
  }
  return { south, west, north, east };
}

// Whether any part of `path` passes through `bounds` — not just its
// vertices. A route whose two flanking stops both sit just outside a
// viewport can still cut straight through the middle of it; checking
// only whether a stop (a path vertex) falls inside the viewport misses
// that entirely, which is what made a route's line disappear even while
// it was visibly still on screen. `precomputedPathBounds` lets a caller
// that already has (and cached) a path's bounding box skip recomputing
// it on every call.
export function pathIntersectsBounds(
  path: LatLng[],
  bounds: LatLngBoundsLike,
  precomputedPathBounds?: LatLngBoundsLike | null
): boolean {
  if (path.length === 0) return false;

  const bbox = precomputedPathBounds !== undefined ? precomputedPathBounds : pathBounds(path);
  if (bbox && !boundsOverlap(bbox, bounds)) return false;

  if (path.length === 1) return pointInBounds(path[0], bounds);

  const nw: LatLng = [bounds.north, bounds.west];
  const ne: LatLng = [bounds.north, bounds.east];
  const se: LatLng = [bounds.south, bounds.east];
  const sw: LatLng = [bounds.south, bounds.west];

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (pointInBounds(a, bounds) || pointInBounds(b, bounds)) return true;
    if (
      segmentsIntersect(a, b, nw, ne) ||
      segmentsIntersect(a, b, ne, se) ||
      segmentsIntersect(a, b, se, sw) ||
      segmentsIntersect(a, b, sw, nw)
    ) {
      return true;
    }
  }
  return false;
}

export function pathLength(path: LatLng[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += haversineMeters(path[i], path[i + 1]);
  }
  return total;
}

// A loop route's path starts and ends at (essentially) the same
// physical point. That matters for comparing "distance along the path"
// between two points near the seam: a bus just before completing one
// lap and a bus just after starting the next sit right next to each
// other in the real world, but near-maximally far apart in plain
// distanceAlong terms (one near 0, the other near the path's full
// length) — exactly the kind of gap that stops two sightings of the
// same physical bus from being recognized as the same one. Threshold is
// generous enough to allow for the geometry not closing perfectly.
const LOOP_CLOSURE_METERS = 150;

export function isLoopPath(path: LatLng[]): boolean {
  return path.length >= 2 && haversineMeters(path[0], path[path.length - 1]) <= LOOP_CLOSURE_METERS;
}

// Distance between two points along a path, accounting for wraparound
// when the path is a loop — i.e. the shorter of going directly between
// them or going the other way around through the seam. For a
// non-looping path this is just the plain difference.
export function alongPathDistance(a: number, b: number, totalLength: number, loop: boolean): number {
  const linear = Math.abs(a - b);
  return loop ? Math.min(linear, totalLength - linear) : linear;
}

// Walks `path` by traveled distance (meters from its start), clamped to
// the path's endpoints.
export function positionAtDistance(path: LatLng[], distance: number): LatLng {
  return pointAtDistance(path, Math.max(0, distance));
}
