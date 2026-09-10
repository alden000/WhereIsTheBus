import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Singapore-wide view: matches the coverage area of LTA's bus data.
const SINGAPORE_CENTER: L.LatLngTuple = [1.3521, 103.8198];
const SINGAPORE_BOUNDS = L.latLngBounds([1.1304, 103.5934], [1.4784, 104.1421]);

const MIN_ZOOM = 11;
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
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: MAX_ZOOM,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);

  return map;
}

export function enableLocate(map: L.Map, buttonEl: HTMLElement): void {
  let marker: L.CircleMarker | null = null;

  buttonEl.addEventListener("click", () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by this browser.");
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
        alert("Unable to retrieve your location.");
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}
