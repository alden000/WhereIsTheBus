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

export interface LocateControl {
  // Locates once without user interaction — e.g. on page load. Silent on
  // failure/denial (falls back to whatever view the map already has)
  // rather than alerting, since the user didn't explicitly ask for it
  // this time the way a button click implies.
  locateSilently(): void;
}

export function enableLocate(map: L.Map, buttonEl: HTMLElement): LocateControl {
  let marker: L.CircleMarker | null = null;

  function locate(onError: ((message: string) => void) | null, options: PositionOptions): void {
    if (!navigator.geolocation) {
      onError?.("Geolocation is not supported by this browser.");
      return;
    }

    buttonEl.classList.add("active");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        buttonEl.classList.remove("active");
        const latlng: L.LatLngTuple = [pos.coords.latitude, pos.coords.longitude];

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

        map.flyTo(latlng, Math.max(map.getZoom(), 15), { duration: 0.75 });
      },
      () => {
        buttonEl.classList.remove("active");
        onError?.("Unable to retrieve your location.");
      },
      options
    );
  }

  buttonEl.addEventListener("click", () => {
    // A deliberate click can afford to wait for a precise GPS fix.
    locate((message) => alert(message), { enableHighAccuracy: true, timeout: 8000 });
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
      locate(null, { enableHighAccuracy: false, timeout: 3000 });
    },
  };
}
