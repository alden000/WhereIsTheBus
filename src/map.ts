import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Singapore-wide view: matches the coverage area of LTA's bus data.
const SINGAPORE_CENTER: L.LatLngTuple = [1.3521, 103.8198];
const SINGAPORE_BOUNDS = L.latLngBounds([1.1304, 103.5934], [1.4784, 104.1421]);

// Was 11 — lowered to let the whole island (and its surrounding water)
// stay comfortably visible when zoomed all the way out.
const MIN_ZOOM = 9;
const MAX_ZOOM = 19;
const DEFAULT_ZOOM = 12;

export function createMap(containerId: string): L.Map {
  const map = L.map(containerId, {
    center: SINGAPORE_CENTER,
    zoom: DEFAULT_ZOOM,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    zoomControl: false,
    attributionControl: true,
    maxBounds: SINGAPORE_BOUNDS.pad(0.15),
    maxBoundsViscosity: 0.6,
    inertia: true,
  });

  // CARTO Dark Matter: greyscale/dark basemap that still renders roads and
  // road names, so bus stop dots and colored route lines stand out clearly.
  // CARTO requires a free API key as of August 2026 (basemaps.cartocdn.com
  // now watermarks unauthenticated requests with "API KEY REQUIRED") — this
  // key is a public/client-side usage key (like a Mapbox key), not a secret,
  // so it's fine to embed directly here rather than proxy it server-side.
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=cb1_3fyb_1_8fdb2b7ca25b7c7cf165f35e",
    {
      subdomains: "abcd",
      maxZoom: MAX_ZOOM,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }
  ).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);

  return map;
}

// How often follow mode re-checks the user's position and recenters the
// map on it.
const FOLLOW_INTERVAL_MS = 5000;

// The zoom level bus/route markers start rendering at (MIN_ZOOM_FOR_OVERLAY
// in overlay.ts) — following your own position at a wider zoom than that
// would center the map on a view with nothing tracked on it yet, defeating
// the point. Whatever zoom the user already has set higher than this is
// left alone (Math.max below); this only ever zooms *in* to reach it, never
// out.
const FOLLOW_MIN_ZOOM = 15;

export interface LocateControl {
  // Locates once without user interaction — e.g. on page load. Silent on
  // failure/denial (falls back to whatever view the map already has)
  // rather than alerting, since the user didn't explicitly ask for it
  // this time the way a button click implies.
  locateSilently(): void;
  // Toggles continuous tracking: re-checks the user's position every
  // FOLLOW_INTERVAL_MS and recenters the map on it, raising the zoom to
  // FOLLOW_MIN_ZOOM if it's currently lower (never lowering a zoom the
  // user has set higher), for as long as it's enabled. Paused while the
  // tab is hidden and resumed on return, same as the bus-arrival polling
  // in overlay.ts, so it doesn't keep waking the device's GPS for a tab
  // nobody's looking at. onError fires (and following stops) only once a
  // fix can't be obtained even after falling back from a precise (GPS) to
  // a coarse (network/WiFi) location — most commonly the user having
  // revoked location permission entirely — so the caller can reflect that
  // back in its own toggle UI rather than polling silently into a wall.
  setFollowMode(enabled: boolean, onError?: (message: string) => void): void;
}

export function enableLocate(map: L.Map, buttonEl: HTMLElement): LocateControl {
  let marker: L.CircleMarker | null = null;

  function updateMarker(latlng: L.LatLngTuple): void {
    if (marker) {
      marker.setLatLng(latlng);
    } else {
      marker = L.circleMarker(latlng, {
        radius: 8,
        color: "#2f7dd1",
        weight: 3,
        fillColor: "#2f7dd1",
        fillOpacity: 0.5,
      }).addTo(map);
    }
  }

  // Shared by the button (manual click / silent on-load locate) and follow
  // mode's own polling — onSuccess is where the two diverge (fly-to-and-
  // zoom once vs. recenter-in-place repeatedly).
  function fetchPosition(
    options: PositionOptions,
    onSuccess: (latlng: L.LatLngTuple) => void,
    onError: ((message: string) => void) | null
  ): void {
    if (!navigator.geolocation) {
      onError?.("Geolocation is not supported by this browser.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const latlng: L.LatLngTuple = [pos.coords.latitude, pos.coords.longitude];
        updateMarker(latlng);
        onSuccess(latlng);
      },
      () => onError?.("Unable to retrieve your location."),
      options
    );
  }

  function locateAndFlyTo(onError: ((message: string) => void) | null, options: PositionOptions): void {
    buttonEl.classList.add("active");
    fetchPosition(
      options,
      (latlng) => {
        buttonEl.classList.remove("active");
        map.flyTo(latlng, Math.max(map.getZoom(), 15), { duration: 0.75 });
      },
      (message) => {
        buttonEl.classList.remove("active");
        onError?.(message);
      }
    );
  }

  buttonEl.addEventListener("click", () => {
    // A deliberate click can afford to wait for a precise GPS fix.
    locateAndFlyTo((message) => alert(message), { enableHighAccuracy: true, timeout: 8000 });
  });

  let followEnabled = false;
  let followTimer: ReturnType<typeof setInterval> | null = null;
  let followOnError: ((message: string) => void) | null = null;

  function followTick(): void {
    const applyFix = (latlng: L.LatLngTuple): void => {
      map.setView(latlng, Math.max(map.getZoom(), FOLLOW_MIN_ZOOM), { animate: true });
    };
    const giveUp = (message: string): void => {
      stopFollowTimer();
      followEnabled = false;
      followOnError?.(message);
    };

    fetchPosition(
      // maximumAge lets this reuse a fix the device already has from
      // moments ago instead of forcing a brand new one every single tick —
      // cheaper on battery while still well within "every 5 seconds" terms.
      { enableHighAccuracy: true, timeout: 4500, maximumAge: 4000 },
      applyFix,
      () => {
        // A precise (GPS) fix isn't always available — indoors, or a
        // device/browser with no GPS chip at all — so fall back to a
        // coarse (network/WiFi-based) one instead of losing this tick
        // entirely; only give up once both have failed.
        fetchPosition({ enableHighAccuracy: false, timeout: 4500, maximumAge: 4000 }, applyFix, giveUp);
      }
    );
  }

  function startFollowTimer(): void {
    if (followTimer !== null) return;
    followTick();
    followTimer = setInterval(followTick, FOLLOW_INTERVAL_MS);
  }

  function stopFollowTimer(): void {
    if (followTimer === null) return;
    clearInterval(followTimer);
    followTimer = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (!followEnabled) return;
    if (document.hidden) {
      stopFollowTimer();
    } else {
      startFollowTimer();
    }
  });

  return {
    locateSilently() {
      // enableHighAccuracy forces the device to wait for a full GPS fix,
      // which is what was actually behind the reported 5-10s delay before
      // the map centered on load — the 8s timeout above was very nearly
      // always the thing that expired. A coarse (network/WiFi-based)
      // fix is more than good enough for "roughly center the map here"
      // and typically resolves in well under a second, so this trades
      // pinpoint accuracy for speed on the one call that runs
      // automatically rather than in response to the user asking for it.
      locateAndFlyTo(null, { enableHighAccuracy: false, timeout: 3000 });
    },
    setFollowMode(enabled, onError) {
      followEnabled = enabled;
      followOnError = onError ?? null;
      if (enabled) {
        if (!document.hidden) startFollowTimer();
      } else {
        stopFollowTimer();
      }
    },
  };
}
