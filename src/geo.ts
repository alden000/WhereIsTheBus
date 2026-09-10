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

export function pathLength(path: LatLng[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += haversineMeters(path[i], path[i + 1]);
  }
  return total;
}

// Walks `path` by traveled distance (meters from its start), clamped to
// the path's endpoints.
export function positionAtDistance(path: LatLng[], distance: number): LatLng {
  return pointAtDistance(path, Math.max(0, distance));
}
