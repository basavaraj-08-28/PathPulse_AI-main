/**
 * PathPulse AI — 3D Vector Map Engine (map.js)
 * Powered by MapLibre GL JS + 3D Building Extrusions + OSRM Routing
 *
 * Features:
 * - Full WebGL Hardware-Accelerated 3D Vector Map
 * - 3D Building Height Extrusions with ambient lighting
 * - Native 360° rotation with upright street labels
 * - 3D Camera Pitch (0° flat overview to 58° driving perspective)
 * - Real-Time GPS Location & 3D Navigation Puck
 * - OSRM Multi-Route Calculation with interactive alternatives
 * - Clean preview mode (pothole markers shown exclusively during active navigation)
 * - Autocomplete Search, Recent & Favourite destinations
 */

// ── Map State & Global Variables ────────────────────────────────────
let map = null;
let userLocationMarker = null;
let userAccuracyCircle = null;
let destinationMarker = null;
let lastKnownGPSPosition = null;
let locationWatchId = null;
let is3DMode = false;

// Pothole and Route Data State
let allPatholesData = [];
window.allPatholesData = allPatholesData;
let currentRouteCoordinates = null;
window.currentRouteCoordinates = null;
let allComputedRoutes = [];
window.allComputedRoutes = allComputedRoutes;
let selectedRouteIndex = 0;
window.selectedRouteIndex = selectedRouteIndex;

let activePotholeMarkers = [];
let isMuted = false;
window.ROUTE_PROXIMITY_THRESHOLD_METERS = 20;

// Severity Color Definitions
const SEVERITY_COLORS = {
  low: '#10b981',
  medium: '#f59e0b',
  high: '#ef4444'
};

// ── Initialize MapLibre 3D Vector Map ───────────────────────────────
function initMap() {
  const defaultCenter = [77.594566, 12.971599]; // Bengaluru [lng, lat]

  map = new maplibregl.Map({
    container: 'main-map',
    style: 'https://tiles.openfreemap.org/styles/bright',
    center: defaultCenter,
    zoom: 12,
    pitch: 0,
    bearing: 0,
    antialias: true
  });

  window.ppMap = map;

  // Add zoom and rotation controls to bottom-right
  map.addControl(new maplibregl.NavigationControl({
    visualizePitch: true,
    showZoom: true,
    showCompass: true
  }), 'bottom-right');

  map.on('load', () => {
    setup3DBuildingsLayer();
    setupRouteLayers();
    loadPatholes();
    startLiveLocation();
  });

  // Click on map to select destination (only when no route is active, to prevent accidental re-routing while panning)
  map.on('click', (e) => {
    if (typeof NAV !== 'undefined' && NAV.isNavigating) return;
    if (currentRouteCoordinates && currentRouteCoordinates.length > 0) return;
    const { lng, lat } = e.lngLat;
    setDestinationFromCoords(lat, lng, 'Selected Location');
  });

  // When user manually pans/drags the map during navigation or preview, pause auto-centering
  map.on('dragstart', () => {
    if (typeof NAV !== 'undefined' && NAV.isNavigating) {
      NAV.isFollowing = false;
      const recenterBtn = document.getElementById('btn-live-recenter');
      if (recenterBtn) recenterBtn.style.boxShadow = '0 0 16px rgba(37, 99, 235, 0.9)';
    }
  });

  map.on('touchstart', () => {
    if (typeof NAV !== 'undefined' && NAV.isNavigating) {
      NAV.isFollowing = false;
      const recenterBtn = document.getElementById('btn-live-recenter');
      if (recenterBtn) recenterBtn.style.boxShadow = '0 0 16px rgba(37, 99, 235, 0.9)';
    }
  });

  // Window resize handler
  window.addEventListener('resize', () => {
    if (map) map.resize();
  }, { passive: true });
}

// ── 3D Building Extrusions Layer ────────────────────────────────────
function setup3DBuildingsLayer() {
  if (!map) return;
  const layers = map.getStyle().layers || [];
  let labelLayerId;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].type === 'symbol' && layers[i].layout && layers[i].layout['text-field']) {
      labelLayerId = layers[i].id;
      break;
    }
  }

  if (!map.getLayer('3d-buildings')) {
    map.addLayer({
      id: '3d-buildings',
      source: 'openmaptiles',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': [
          'interpolate',
          ['linear'],
          ['get', 'render_height'],
          0, '#e2e8f0',
          30, '#cbd5e1',
          70, '#94a3b8',
          150, '#64748b'
        ],
        'fill-extrusion-height': [
          'interpolate',
          ['linear'],
          ['zoom'],
          13, 0,
          14.5, ['get', 'render_height']
        ],
        'fill-extrusion-base': [
          'interpolate',
          ['linear'],
          ['zoom'],
          13, 0,
          14.5, ['get', 'render_min_height']
        ],
        'fill-extrusion-opacity': 0.85
      }
    }, labelLayerId);
  }
}

// ── Route Vector Layers (OSRM GeoJSON) ──────────────────────────────
function setupRouteLayers() {
  if (!map) return;

  // Alternatives Source & Layer
  if (!map.getSource('route-alternatives')) {
    map.addSource('route-alternatives', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'route-alternatives-line',
      type: 'line',
      source: 'route-alternatives',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#64748b',
        'line-width': 5,
        'line-opacity': 0.65,
        'line-dasharray': [2, 2]
      }
    });
  }

  // Active Route Source & Casing + Main Line Layers
  if (!map.getSource('active-route')) {
    map.addSource('active-route', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    // Casing (Outline/Glow)
    map.addLayer({
      id: 'active-route-casing',
      type: 'line',
      source: 'active-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#1e40af',
        'line-width': 9,
        'line-opacity': 0.5
      }
    });

    // Vibrant Route Line
    map.addLayer({
      id: 'active-route-line',
      type: 'line',
      source: 'active-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#3b82f6',
        'line-width': 6,
        'line-opacity': 0.95
      }
    });
  }

  // Navigation Potholes GeoJSON Source & Vector Circle Layers (Rendered directly on same WebGL plane as blue route)
  if (!map.getSource('navigation-potholes')) {
    map.addSource('navigation-potholes', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    // Subtle Road Shadow for Pothole Dots
    map.addLayer({
      id: 'navigation-potholes-shadow',
      type: 'circle',
      source: 'navigation-potholes',
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10, 4,
          14, [
            'match',
            ['get', 'severity'],
            'high', 7.5,
            'medium', 6,
            'low', 5,
            6
          ],
          18, [
            'match',
            ['get', 'severity'],
            'high', 11.5,
            'medium', 9.5,
            'low', 8,
            9.5
          ]
        ],
        'circle-color': 'rgba(0, 0, 0, 0.35)',
        'circle-blur': 0.4,
        'circle-translate': [0, 2]
      }
    });

    // Solid Classified Pothole Circle Layer with Crisp White Border
    map.addLayer({
      id: 'navigation-potholes-layer',
      type: 'circle',
      source: 'navigation-potholes',
      paint: {
        'circle-color': [
          'match',
          ['get', 'severity'],
          'high', '#ef4444',
          'medium', '#f97316',
          'low', '#eab308',
          '#f97316'
        ],
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10, 3.5,
          14, [
            'match',
            ['get', 'severity'],
            'high', 7,
            'medium', 5.5,
            'low', 4.5,
            5.5
          ],
          18, [
            'match',
            ['get', 'severity'],
            'high', 10.5,
            'medium', 8.5,
            'low', 7,
            8.5
          ]
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10, 1.5,
          16, 2,
          18, 2.5
        ],
        'circle-opacity': 1.0,
        'circle-stroke-opacity': 1.0
      }
    });

    // Click handler for pothole detail popup
    map.on('click', 'navigation-potholes-layer', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties;
      const coords = f.geometry.coordinates.slice();

      const sev = (p.severity || 'medium').toLowerCase();
      const sevTitle = sev === 'high' ? 'High Severity' : (sev === 'medium' ? 'Medium Severity' : 'Low Severity');
      const sevEmoji = sev === 'high' ? '🔴' : (sev === 'medium' ? '🟠' : '🟡');
      const confPct = Math.round((parseFloat(p.confidence) || 0.5) * 100);
      const accelText = (p.accel_peak != null && p.accel_peak !== '' && !isNaN(p.accel_peak))
        ? `${parseFloat(p.accel_peak).toFixed(1)} m/s²`
        : 'N/A';
      const reportCount = p.report_count || 1;
      const realLat = p.latitude != null ? parseFloat(p.latitude).toFixed(5) : coords[1].toFixed(5);
      const realLng = p.longitude != null ? parseFloat(p.longitude).toFixed(5) : coords[0].toFixed(5);

      const popupHTML = `
        <div class="pothole-2d-popup">
          <div class="pothole-popup-header sev-${sev}">
            <span class="pothole-popup-badge">${sevEmoji} ${sevTitle}</span>
            <span class="pothole-popup-id">#${p.id || ''}</span>
          </div>
          <div class="pothole-popup-body">
            <div class="pothole-stat-row">
              <span class="pothole-stat-label">Confidence:</span>
              <span class="pothole-stat-val"><strong>${confPct}%</strong></span>
            </div>
            <div class="pothole-stat-row">
              <span class="pothole-stat-label">Reports:</span>
              <span class="pothole-stat-val"><strong>${reportCount}</strong></span>
            </div>
            <div class="pothole-stat-row">
              <span class="pothole-stat-label">Impact Spike:</span>
              <span class="pothole-stat-val"><strong>${accelText}</strong></span>
            </div>
            <div class="pothole-coords">
              📍 ${realLat}, ${realLng}
            </div>
          </div>
        </div>
      `;

      new maplibregl.Popup({
        offset: 12,
        closeButton: true,
        closeOnClick: true,
        className: 'pothole-map-popup'
      })
        .setLngLat(coords)
        .setHTML(popupHTML)
        .addTo(map);
    });

    map.on('mouseenter', 'navigation-potholes-layer', () => {
      if (map) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'navigation-potholes-layer', () => {
      if (map) map.getCanvas().style.cursor = '';
    });
  }
}

// ── Toggle 3D Perspective Mode ──────────────────────────────────────
window.toggle3DView = function() {
  if (!map) return;
  is3DMode = !is3DMode;
  const targetPitch = is3DMode ? 58 : 0;
  map.easeTo({
    pitch: targetPitch,
    duration: 800
  });

  const btn = document.getElementById('btn-toggle-3d');
  if (btn) {
    btn.textContent = is3DMode ? '🗺️ 2D' : '🏢 3D';
    btn.classList.toggle('active', is3DMode);
  }
  showToast(is3DMode ? '🏢 3D Perspective Mode Enabled' : '🗺️ 2D Flat Mode Enabled', 'info');
};

// ── GPS Tracking & 3D Navigation Puck ───────────────────────────────
function startLiveLocation() {
  if (!navigator.geolocation) {
    console.warn('Geolocation not supported by browser.');
    return;
  }

  locationWatchId = navigator.geolocation.watchPosition(
    (pos) => handleGPSPosition(pos),
    (err) => console.warn('GPS error / awaiting fix:', err.message),
    { enableHighAccuracy: true, timeout: 25000, maximumAge: 2000 }
  );
}

function handleGPSPosition(position) {
  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  const accuracy = position.coords.accuracy;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  lastKnownGPSPosition = { latitude: lat, longitude: lng, accuracy };
  window.lastKnownGPSPosition = lastKnownGPSPosition;

  showUserLocation(lat, lng, accuracy, false, position);

  // Hook for live navigation updates
  if (typeof window.onNavGPSUpdate === 'function') {
    window.onNavGPSUpdate(lat, lng, position);
  }
}

function showUserLocation(lat, lng, accuracy, centerMap = false, pos = null) {
  if (!map) return;

  // Create / Update 3D Navigation User Puck
  if (!userLocationMarker) {
    const el = document.createElement('div');
    el.className = 'nav-puck-3d';
    el.innerHTML = `
      <div class="nav-puck-halo"></div>
      <div class="nav-puck-core" id="nav-puck-core-el">
        <div class="nav-puck-arrow"></div>
      </div>
    `;

    userLocationMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
      .setLngLat([lng, lat])
      .addTo(map);

    if (centerMap) {
      map.flyTo({ center: [lng, lat], zoom: 15, duration: 1000 });
    }
  } else {
    userLocationMarker.setLngLat([lng, lat]);
  }

  // Update orientation arrow if heading available
  if (pos && pos.coords && pos.coords.heading !== null && !isNaN(pos.coords.heading)) {
    const coreEl = document.getElementById('nav-puck-core-el');
    if (coreEl) {
      coreEl.style.transform = `rotate(${pos.coords.heading}deg)`;
    }
  }
}

window.locateUser = function() {
  if (lastKnownGPSPosition && map) {
    map.flyTo({
      center: [lastKnownGPSPosition.longitude, lastKnownGPSPosition.latitude],
      zoom: 16,
      pitch: is3DMode ? 55 : 0,
      duration: 1000
    });
    showToast('📍 Centered on your current location', 'info');
  } else {
    showToast('📍 Waiting for GPS position...', 'warning');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        handleGPSPosition(pos);
        if (map) {
          map.flyTo({
            center: [pos.coords.longitude, pos.coords.latitude],
            zoom: 16,
            duration: 1000
          });
        }
      },
      (err) => showToast('Could not get GPS location. Please allow location permissions.', 'error'),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }
};

// ── Load Pothole Data from Server ───────────────────────────────────
async function loadPatholes() {
  try {
    const res = await fetch('/api/patholes');
    const data = await res.json();
    if (data.patholes) {
      allPatholesData = data.patholes;
      window.allPatholesData = allPatholesData;
      filterMarkers();
    }
  } catch (err) {
    console.error('Failed to load potholes:', err);
  }
}

window.refreshMap = function() {
  loadPatholes();
  showToast('🔄 Map and pothole data refreshed', 'info');
};

// ── 2D Flat Pothole Circular Dots (Leaflet Style Clean Road Dots) ────────
function create2DPotholeMarker(pothole) {
  if (!map || pothole.latitude == null || pothole.longitude == null) return null;

  const sev = (pothole.severity || 'medium').toLowerCase();
  const sevTitle = sev === 'high' ? 'High Severity' : (sev === 'medium' ? 'Medium Severity' : 'Low Severity');
  const sevEmoji = sev === 'high' ? '🔴' : (sev === 'medium' ? '🟠' : '🟡');

  const el = document.createElement('div');
  el.className = `pothole-dot-marker sev-${sev}`;
  el.setAttribute('role', 'button');
  el.setAttribute('title', `${sevTitle} Pothole`);

  el.innerHTML = `
    <div class="pothole-dot-core sev-${sev}"></div>
  `;

  // Create 2D information popup
  const confPct = Math.round((pothole.confidence || 0.5) * 100);
  const accelText = (pothole.accel_peak != null && !isNaN(pothole.accel_peak))
    ? `${parseFloat(pothole.accel_peak).toFixed(1)} m/s²`
    : 'N/A';
  const reportCount = pothole.report_count || 1;

  const popupHTML = `
    <div class="pothole-2d-popup">
      <div class="pothole-popup-header sev-${sev}">
        <span class="pothole-popup-badge">${sevEmoji} ${sevTitle}</span>
        <span class="pothole-popup-id">#${pothole.id || ''}</span>
      </div>
      <div class="pothole-popup-body">
        <div class="pothole-stat-row">
          <span class="pothole-stat-label">Confidence:</span>
          <span class="pothole-stat-val"><strong>${confPct}%</strong></span>
        </div>
        <div class="pothole-stat-row">
          <span class="pothole-stat-label">Reports:</span>
          <span class="pothole-stat-val"><strong>${reportCount}</strong></span>
        </div>
        <div class="pothole-stat-row">
          <span class="pothole-stat-label">Impact Spike:</span>
          <span class="pothole-stat-val"><strong>${accelText}</strong></span>
        </div>
        <div class="pothole-coords">
          📍 ${parseFloat(pothole.latitude).toFixed(5)}, ${parseFloat(pothole.longitude).toFixed(5)}
        </div>
      </div>
    </div>
  `;

  const popup = new maplibregl.Popup({
    offset: 16,
    closeButton: true,
    closeOnClick: false,
    className: 'pothole-map-popup'
  }).setHTML(popupHTML);

  const markerLat = pothole.markerLat != null ? Number(pothole.markerLat) : Number(pothole.latitude);
  const markerLng = pothole.markerLng != null ? Number(pothole.markerLng) : Number(pothole.longitude);

  const marker = new maplibregl.Marker({
    element: el,
    anchor: 'center'
  })
    .setLngLat([markerLng, markerLat])
    .setPopup(popup)
    .addTo(map);

  return marker;
}

function updatePotholeLayerGeoJSON(potholes = []) {
  if (!map) return;
  if (!map.getSource('navigation-potholes')) {
    setupRouteLayers();
  }
  const source = map.getSource('navigation-potholes');
  if (!source) return;

  const features = (potholes || []).map(p => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [
        p.markerLng != null ? Number(p.markerLng) : Number(p.longitude),
        p.markerLat != null ? Number(p.markerLat) : Number(p.latitude)
      ]
    },
    properties: {
      id: p.id,
      severity: (p.severity || 'medium').toLowerCase(),
      confidence: p.confidence || 0.5,
      accel_peak: p.accel_peak != null ? p.accel_peak : '',
      report_count: p.report_count || 1,
      latitude: p.latitude,
      longitude: p.longitude
    }
  }));

  source.setData({
    type: 'FeatureCollection',
    features: features
  });
}
window.updatePotholeLayerGeoJSON = updatePotholeLayerGeoJSON;

window.filterMarkers = function() {
  // Clear any existing DOM pothole markers
  activePotholeMarkers.forEach(m => {
    try { m.remove(); } catch (e) {}
  });
  activePotholeMarkers = [];

  const activeRouteCoords = currentRouteCoordinates || (typeof NAV !== 'undefined' && NAV.currentRoute ? NAV.currentRoute : null);
  const isNavigating = (typeof NAV !== 'undefined' && NAV && NAV.isNavigating === true);

  // When no destination/route is active or not in navigation mode, keep map page clean (no pothole marks shown)
  if (!activeRouteCoords || activeRouteCoords.length === 0) {
    const countEl = document.getElementById('route-potholes-count');
    if (countEl) countEl.textContent = '0';
    updateRoadConditionUI([]);
    updatePotholeLayerGeoJSON([]);
    return;
  }

  // When destination is searched or during navigation, filter and accurately calculate potholes along route
  const routePotholes = filterPotholesAlongRoute(
    activeRouteCoords,
    window.ROUTE_PROXIMITY_THRESHOLD_METERS || 30
  );

  const countEl = document.getElementById('route-potholes-count');
  if (countEl) {
    countEl.textContent = routePotholes.length;
  }

  updateRoadConditionUI(routePotholes);

  // Render accurate 2D color-classified markers (Red = High, Orange = Medium, Yellow = Low)
  // STRICTLY in Navigation Mode (ONLY when user clicks "Start Navigation" and active navigation is running)
  if (isNavigating && map) {
    updatePotholeLayerGeoJSON(routePotholes);
  } else {
    updatePotholeLayerGeoJSON([]);
  }
};

function updateRoadConditionUI(routePotholes = []) {
  const highCount = routePotholes.filter(p => (p.severity || '').toLowerCase() === 'high').length;
  const medCount = routePotholes.filter(p => (p.severity || '').toLowerCase() === 'medium').length;
  const lowCount = routePotholes.filter(p => (p.severity || '').toLowerCase() === 'low').length;

  const bar = document.getElementById('live-road-condition-bar');
  if (!bar) return;

  if (routePotholes.length === 0) {
    bar.innerHTML = `
      <div class="rc-badge good">
        <span class="rc-dot"></span>
        <span>🟢 Smooth Road • Clear Route</span>
      </div>
    `;
    return;
  }

  if (highCount > 0) {
    bar.innerHTML = `
      <div class="rc-badge danger">
        <span class="rc-dot"></span>
        <span>🔴 Rough Road • ${highCount} High, ${medCount} Med, ${lowCount} Low</span>
      </div>
    `;
  } else if (medCount > 0) {
    bar.innerHTML = `
      <div class="rc-badge warning">
        <span class="rc-dot"></span>
        <span>🟡 Moderate Road • ${medCount} Med, ${lowCount} Low</span>
      </div>
    `;
  } else {
    bar.innerHTML = `
      <div class="rc-badge good">
        <span class="rc-dot"></span>
        <span>🟢 Good Road • ${lowCount} Minor Bump${lowCount > 1 ? 's' : ''}</span>
      </div>
    `;
  }
}
window.updateRoadConditionUI = updateRoadConditionUI;

function filterPotholesAlongRoute(routeCoords, thresholdMeters = 30) {
  if (!routeCoords || routeCoords.length === 0) return [];

  const showLow = document.getElementById('filter-low')?.checked ?? true;
  const showMed = document.getElementById('filter-medium')?.checked ?? true;
  const showHigh = document.getElementById('filter-high')?.checked ?? true;

  const result = [];
  allPatholesData.forEach(p => {
    if (p.is_active === false) return;
    if (p.severity === 'low' && !showLow) return;
    if (p.severity === 'medium' && !showMed) return;
    if (p.severity === 'high' && !showHigh) return;

    const pLat = Number(p.latitude);
    const pLng = Number(p.longitude);
    if (isNaN(pLat) || isNaN(pLng)) return;

    const nearest = getNearestPointOnRoute(pLat, pLng, routeCoords);

    if (nearest.distanceMeters <= thresholdMeters) {
      p.distToRoute = nearest.distanceMeters;

      // KEEP ORIGINAL DATABASE LOCATION
      p.actualLatitude = Number(p.latitude);
      p.actualLongitude = Number(p.longitude);

      // ONLY VISUAL MARKER LOCATION IS SNAPPED TO ACTIVE ROUTE
      p.markerLat = nearest.lat;
      p.markerLng = nearest.lng;

      result.push(p);
    }
  });

  return result;
}
window.filterPotholesAlongRoute = filterPotholesAlongRoute;

// ── Destination Marker Helper ───────────────────────────────────────
function setDestinationMarker(lat, lng, name = 'Destination') {
  if (destinationMarker) {
    destinationMarker.remove();
    destinationMarker = null;
  }

  const el = document.createElement('div');
  el.className = 'dest-marker-root';
  el.innerHTML = `
    <div class="dest-marker-pulse"></div>
    <div class="dest-marker-wrapper">
      <div class="dest-marker-pin" title="${name}">
        <div class="dest-marker-inner">
          <span>🏁</span>
        </div>
      </div>
      <div class="dest-marker-label">${name}</div>
    </div>
  `;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (map) {
      map.flyTo({ center: [lng, lat], zoom: 16, pitch: is3DMode ? 55 : 0, duration: 800 });
      showToast(`🎯 Destination: ${name}`, 'info');
    }
  });

  destinationMarker = new maplibregl.Marker({
    element: el,
    anchor: 'bottom'
  })
    .setLngLat([lng, lat])
    .addTo(map);

  window.destinationMarker = destinationMarker;
}
window.setDestinationMarker = setDestinationMarker;

// ── Destination & OSRM 3D Routing ───────────────────────────────────
async function setDestinationFromCoords(lat, lng, name = 'Selected Location') {
  setDestinationMarker(lat, lng, name);

  const startLat = lastKnownGPSPosition ? lastKnownGPSPosition.latitude : 12.971599;
  const startLng = lastKnownGPSPosition ? lastKnownGPSPosition.longitude : 77.594566;

  saveRecent(name, lat, lng);
  await calculateOSRMRoute(startLat, startLng, lat, lng, name);
}

async function calculateOSRMRoute(startLat, startLng, destLat, destLng, destName) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${destLng},${destLat}?overview=full&geometries=geojson&steps=true&alternatives=true`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.routes || data.routes.length === 0) {
      showToast('Could not calculate a driving route to this destination.', 'error');
      return;
    }

    allComputedRoutes = data.routes;
    window.allComputedRoutes = allComputedRoutes;
    selectedRouteIndex = 0;
    window.selectedRouteIndex = 0;

    const primaryRoute = data.routes[0];
    displayRouteOnMap(primaryRoute, destName);
    renderRouteAlternatives(data.routes);

    const autoToggle = document.getElementById('auto-nav-toggle');
    if (autoToggle && autoToggle.checked && typeof window.startNavigation === 'function') {
      window.startNavigation(destLat, destLng, destName);
    }
  } catch (err) {
    console.error('Routing error:', err);
    showToast('Failed to fetch route. Check internet connection.', 'error');
  }
}

function displayRouteOnMap(route, destName) {
  if (!map || !route) return;

  // Convert GeoJSON coords [[lng, lat]] into {lat, lng} array
  currentRouteCoordinates = route.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
  window.currentRouteCoordinates = currentRouteCoordinates;

  if (window.NAV) {
    window.NAV.currentRoute = currentRouteCoordinates;
    window.NAV.routeSteps = route.legs?.[0]?.steps || [];
    window.NAV.totalDistance = route.distance || 0;
    window.NAV.totalTime = route.duration || 0;
    window.NAV.destLat = currentRouteCoordinates[currentRouteCoordinates.length - 1].lat;
    window.NAV.destLon = currentRouteCoordinates[currentRouteCoordinates.length - 1].lng;
    window.NAV.destName = destName || 'Destination';
  }

  // Update active-route source GeoJSON
  const activeSource = map.getSource('active-route');
  if (activeSource) {
    activeSource.setData({
      type: 'Feature',
      geometry: route.geometry,
      properties: {}
    });
  }

  // Update distance / ETA UI
  const distanceKm = (route.distance / 1000).toFixed(1);
  const travelTimeMin = Math.round(route.duration / 60);
  const etaStr = travelTimeMin >= 60
    ? Math.floor(travelTimeMin / 60) + 'h ' + (travelTimeMin % 60) + 'm'
    : travelTimeMin + ' min';

  const routeDistance = document.getElementById('route-distance');
  const routeEta = document.getElementById('route-eta');
  const startNameEl = document.getElementById('route-start-name');
  const destNameEl = document.getElementById('route-dest-name');
  const routeInfo = document.getElementById('route-info');
  const startBtn = document.getElementById('btn-start-nav');
  const hintEl = document.getElementById('map-click-hint');

  if (routeDistance) routeDistance.textContent = distanceKm;
  if (routeEta) routeEta.textContent = etaStr;
  if (startNameEl) startNameEl.textContent = 'Current GPS Location';
  if (destNameEl) destNameEl.textContent = destName || 'Selected Destination';
  if (routeInfo) routeInfo.style.display = 'flex';
  if (startBtn) startBtn.style.display = 'inline-flex';
  if (hintEl) hintEl.classList.add('hidden');

  // Ensure destination marker is placed at the exact route endpoint
  const lastCoord = route.geometry.coordinates[route.geometry.coordinates.length - 1];
  if (lastCoord) {
    setDestinationMarker(lastCoord[1], lastCoord[0], destName || 'Destination');
  }

  // Fit camera bounds around full route with comfortable view margins
  const bounds = new maplibregl.LngLatBounds();
  route.geometry.coordinates.forEach(c => bounds.extend(c));
  map.fitBounds(bounds, {
    padding: { top: 70, bottom: 90, left: 50, right: 50 },
    maxZoom: 16,
    pitch: 0
  });

  filterMarkers();
}

// ── Quick Camera Fly-To Helpers ─────────────────────────────────────
window.flyToDestination = function() {
  if (destinationMarker && map) {
    const lngLat = destinationMarker.getLngLat();
    map.flyTo({
      center: [lngLat.lng, lngLat.lat],
      zoom: 16,
      pitch: is3DMode ? 55 : 0,
      duration: 1000
    });
    showToast('🎯 Viewing Destination point', 'info');
  }
};

window.flyToOrigin = function() {
  if (lastKnownGPSPosition && map) {
    map.flyTo({
      center: [lastKnownGPSPosition.longitude, lastKnownGPSPosition.latitude],
      zoom: 16,
      pitch: is3DMode ? 55 : 0,
      duration: 1000
    });
    showToast('📍 Viewing Starting point', 'info');
  }
};

function renderRouteAlternatives(routes) {
  const bar = document.getElementById('route-alternatives-bar');
  if (!bar) return;
  if (!routes || routes.length <= 1) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  bar.innerHTML = '';
  bar.style.display = 'flex';

  // Find fastest vs shortest
  let minDistanceIdx = 0;
  let minTimeIdx = 0;
  routes.forEach((r, i) => {
    if (r.distance < routes[minDistanceIdx].distance) minDistanceIdx = i;
    if (r.duration < routes[minTimeIdx].duration) minTimeIdx = i;
  });

  routes.forEach((rt, index) => {
    const distKm = (rt.distance / 1000).toFixed(1);
    const timeMin = Math.round(rt.duration / 60);
    const timeStr = timeMin >= 60 ? Math.floor(timeMin / 60) + 'h ' + (timeMin % 60) + 'm' : timeMin + ' min';

    let badgeLabel = index === minTimeIdx ? '⚡ Fastest' : (index === minDistanceIdx ? '📏 Shortest' : `Alt ${index + 1}`);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `route-alt-chip ${index === 0 ? 'active' : ''}`;
    chip.innerHTML = `<span class="alt-badge">${badgeLabel}</span> <span class="alt-time">${timeStr}</span> <span class="alt-dist">(${distKm} km)</span>`;
    chip.onclick = () => window.selectAlternativeRoute(index);
    bar.appendChild(chip);
  });
}

window.selectAlternativeRoute = function(index) {
  if (!allComputedRoutes || !allComputedRoutes[index]) return;
  selectedRouteIndex = index;
  window.selectedRouteIndex = index;
  const route = allComputedRoutes[index];
  const destName = document.getElementById('route-dest-name')?.textContent || 'Destination';

  displayRouteOnMap(route, destName);

  document.querySelectorAll('.route-alt-chip').forEach((el, idx) => {
    if (idx === index) el.classList.add('active');
    else el.classList.remove('active');
  });
};

window.clearRoute = function() {
  currentRouteCoordinates = null;
  allComputedRoutes = [];
  selectedRouteIndex = 0;

  if (destinationMarker) {
    destinationMarker.remove();
    destinationMarker = null;
  }

  if (map) {
    const activeSource = map.getSource('active-route');
    if (activeSource) activeSource.setData({ type: 'FeatureCollection', features: [] });
    const altSource = map.getSource('route-alternatives');
    if (altSource) altSource.setData({ type: 'FeatureCollection', features: [] });
  }

  const bar = document.getElementById('route-alternatives-bar');
  if (bar) {
    bar.style.display = 'none';
    bar.innerHTML = '';
  }

  const routeInfo = document.getElementById('route-info');
  if (routeInfo) routeInfo.style.display = 'none';

  const hintEl = document.getElementById('map-click-hint');
  if (hintEl) hintEl.classList.remove('hidden');

  const searchInput = document.getElementById('map-search');
  if (searchInput) searchInput.value = '';

  filterMarkers();
};

// ── Search & Autocomplete ───────────────────────────────────────────
function setupSearch() {
  const searchInput = document.getElementById('map-search');
  const suggestionsBox = document.getElementById('search-suggestions');
  let searchTimeout = null;

  if (searchInput && suggestionsBox) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      const query = e.target.value.trim();
      if (query.length < 3) {
        suggestionsBox.style.display = 'none';
        return;
      }

      searchTimeout = setTimeout(async () => {
        try {
          const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8&lang=en`;
          const res = await fetch(url);
          const data = await res.json();
          if (data.features && data.features.length > 0) {
            renderSearchSuggestions(data.features);
          } else {
            suggestionsBox.style.display = 'none';
          }
        } catch (err) {
          console.warn('Geocoding error:', err);
        }
      }, 300);
    });

    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
        suggestionsBox.style.display = 'none';
      }
    });
  }
}

function renderSearchSuggestions(features) {
  const box = document.getElementById('search-suggestions');
  if (!box) return;
  box.innerHTML = '';

  features.forEach(f => {
    const coords = f.geometry.coordinates; // [lng, lat]
    const p = f.properties;
    const mainText = p.name || p.street || 'Location';
    const subText = [p.city, p.state, p.country].filter(Boolean).join(', ');

    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.innerHTML = `
      <div class="sugg-main">📍 ${mainText}</div>
      <div class="sugg-sub">${subText}</div>
    `;
    item.onclick = () => {
      const searchInput = document.getElementById('map-search');
      if (searchInput) searchInput.value = `${mainText}, ${subText}`;
      box.style.display = 'none';
      setDestinationFromCoords(coords[1], coords[0], mainText);
    };
    box.appendChild(item);
  });

  box.style.display = 'block';
}

// ── Recent & Favourite Destinations ─────────────────────────────────
const LS_RECENT = 'pp_recent_destinations';
const LS_FAVS = 'pp_fav_destinations';

function getRecent() {
  try { return JSON.parse(localStorage.getItem(LS_RECENT)) || []; } catch { return []; }
}
function getFavs() {
  try { return JSON.parse(localStorage.getItem(LS_FAVS)) || []; } catch { return []; }
}
function saveRecent(name, lat, lng) {
  let list = getRecent().filter(item => item.name !== name);
  list.unshift({ name, lat, lng });
  if (list.length > 6) list = list.slice(0, 6);
  localStorage.setItem(LS_RECENT, JSON.stringify(list));
}

window.toggleRecentPanel = function() {
  const rp = document.getElementById('recent-dest-panel');
  const fp = document.getElementById('fav-dest-panel');
  if (fp) fp.style.display = 'none';
  if (!rp) return;

  if (rp.style.display === 'block') {
    rp.style.display = 'none';
  } else {
    renderDestList('recent-dest-list', getRecent(), false);
    rp.style.display = 'block';
  }
};

window.toggleFavPanel = function() {
  const fp = document.getElementById('fav-dest-panel');
  const rp = document.getElementById('recent-dest-panel');
  if (rp) rp.style.display = 'none';
  if (!fp) return;

  if (fp.style.display === 'block') {
    fp.style.display = 'none';
  } else {
    renderDestList('fav-dest-list', getFavs(), true);
    fp.style.display = 'block';
  }
};

function renderDestList(containerId, list, isFav) {
  const c = document.getElementById(containerId);
  if (!c) return;
  if (!list || list.length === 0) {
    c.innerHTML = `<div style="padding:10px;font-size:0.8rem;color:#94a3b8;text-align:center;">No ${isFav ? 'favourites' : 'recent destinations'} yet.</div>`;
    return;
  }
  c.innerHTML = '';
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'dest-item';
    row.innerHTML = `<span>${isFav ? '⭐' : '🕒'} ${item.name}</span>`;
    row.onclick = () => {
      document.getElementById('recent-dest-panel').style.display = 'none';
      document.getElementById('fav-dest-panel').style.display = 'none';
      setDestinationFromCoords(item.lat, item.lng, item.name);
    };
    c.appendChild(row);
  });
}

// ── Math & Spatial Helpers ──────────────────────────────────────────
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getNearestPointOnSegment(lat, lon, lat1, lon1, lat2, lon2) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  const mPerDegLat = 111132.92;
  const mPerDegLon = 111412.84 * cosLat;

  const vx = (lon2 - lon1) * mPerDegLon;
  const vy = (lat2 - lat1) * mPerDegLat;
  const wx = (lon - lon1) * mPerDegLon;
  const wy = (lat - lat1) * mPerDegLat;

  const c1 = wx * vx + wy * vy;
  if (c1 <= 0) {
    return {
      lat: lat1,
      lng: lon1,
      distanceMeters: haversineMeters(lat, lon, lat1, lon1)
    };
  }

  const c2 = vx * vx + vy * vy;
  if (c2 <= c1 || c2 === 0) {
    return {
      lat: lat2,
      lng: lon2,
      distanceMeters: haversineMeters(lat, lon, lat2, lon2)
    };
  }

  const b = c1 / c2;
  const projLat = lat1 + b * (lat2 - lat1);
  const projLon = lon1 + b * (lon2 - lon1);
  return {
    lat: projLat,
    lng: projLon,
    distanceMeters: haversineMeters(lat, lon, projLat, projLon)
  };
}
window.getNearestPointOnSegment = getNearestPointOnSegment;

function getNearestPointOnRoute(potholeLat, potholeLng, routeCoords) {
  if (!routeCoords || routeCoords.length < 2) {
    return { lat: Number(potholeLat), lng: Number(potholeLng), distanceMeters: Infinity };
  }

  let best = {
    lat: Number(potholeLat),
    lng: Number(potholeLng),
    distanceMeters: Infinity
  };

  const pLat = Number(potholeLat);
  const pLng = Number(potholeLng);

  for (let i = 0; i < routeCoords.length - 1; i++) {
    const p1 = routeCoords[i];
    const p2 = routeCoords[i + 1];

    const lat1 = Number(p1.lat != null ? p1.lat : (p1.latitude != null ? p1.latitude : p1[1]));
    const lon1 = Number(p1.lng != null ? p1.lng : (p1.lon != null ? p1.lon : (p1.longitude != null ? p1.longitude : p1[0])));
    const lat2 = Number(p2.lat != null ? p2.lat : (p2.latitude != null ? p2.latitude : p2[1]));
    const lon2 = Number(p2.lng != null ? p2.lng : (p2.lon != null ? p2.lon : (p2.longitude != null ? p2.longitude : p2[0])));

    if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) continue;

    const segResult = getNearestPointOnSegment(pLat, pLng, lat1, lon1, lat2, lon2);
    if (segResult.distanceMeters < best.distanceMeters) {
      best = segResult;
    }
  }

  return best;
}
window.getNearestPointOnRoute = getNearestPointOnRoute;

function getDistanceToSegmentMeters(lat, lon, lat1, lon1, lat2, lon2) {
  return getNearestPointOnSegment(lat, lon, lat1, lon1, lat2, lon2).distanceMeters;
}

// ── UI Toast & Audio Mute ───────────────────────────────────────────
window.toggleMute = function() {
  isMuted = !isMuted;
  const btn = document.getElementById('btn-mute');
  if (btn) btn.textContent = isMuted ? '🔇' : '🔊';
  showToast(isMuted ? '🔇 Voice warnings muted' : '🔊 Voice warnings enabled', 'info');
};

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-fade');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}
window.showToast = showToast;

// ── Initialize on DOM ready ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupSearch();
});