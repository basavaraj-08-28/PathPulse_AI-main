/**
 * PathPulse AI — Dashboard Map Script
 * Initializes the main map and loads pathole markers
 */

// ── Map Initialization ──────────────────────────────────────────────
const map = L.map('main-map', {
  zoomControl: true,
  attributionControl: true
}).setView([12.971599, 77.594566], 11);  // Default: Bengaluru, India
window.ppMap = map;  // Expose map instance for navigation.js

// Map Layers
const cartoLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://carto.com/"></a> &copy; <a href="https://www.openstreetmap.org/copyright"></a>',
  maxZoom: 20
});

const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri',
  maxZoom: 19
});

const terrainLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
  maxZoom: 17
});

cartoLayer.addTo(map);

const baseMaps = {
  "Standard": cartoLayer,
  "Satellite": satelliteLayer,
  "Terrain": terrainLayer
};

L.control.layers(baseMaps, null, { position: 'bottomright' }).addTo(map);

// ── Severity Colors ─────────────────────────────────────────────────
const SEVERITY_COLORS = {
  low:    '#09681fff',
  medium: '#f59e0b',
  high:   '#ef4444'
};

const SEVERITY_RADIUS = {
  low: 8,
  medium: 10,
  high: 13
};

// ── Added Feature State ─────────────────────────────────────────────
let allPatholesData = [];
window.allPatholesData = allPatholesData;  // Expose for navigation.js
let alertedPatholes = new Set();
let isMuted = false;

// Configurable route proximity threshold (20-30 meters range)
window.ROUTE_PROXIMITY_THRESHOLD_METERS = 25;
let currentRouteCoordinates = null;



// ── User Location Marker ────────────────────────────────────────────
let userLocationMarker = null;
let userLocationCircle = null;

let locationWatchId = null;

function showUserLocation(lat, lng, accuracy, centerMap = true, pos = null) {
  if (userLocationMarker) {
    userLocationMarker.setLatLng([lat, lng]);
    userLocationCircle.setLatLng([lat, lng]);
    if (accuracy) userLocationCircle.setRadius(accuracy);
  } else {
    userLocationMarker = L.circleMarker([lat, lng], {
      radius: 8,
      fillColor: '#06d6a0',
      fillOpacity: 1,
      color: '#ffffff',
      weight: 3
    }).addTo(map).bindPopup('📍 You are here');

    userLocationCircle = L.circle([lat, lng], {
      radius: accuracy || 100,
      fillColor: '#06d6a0',
      fillOpacity: 0.08,
      color: '#06d6a0',
      weight: 1,
      opacity: 0.3
    }).addTo(map);
  }

  if (centerMap) {
    map.setView([lat, lng], 15);
  }

  // Update live routing if active
  if (window.routingControl) {
    window.routingControl.spliceWaypoints(0, 1, L.latLng(lat, lng));
  }

  // Check proximity to patholes
  checkProximity(lat, lng);

  // ── Navigation GPS hook — navigation.js subscribes here ──────────
  if (typeof window.onNavGPSUpdate === 'function') {
    window.onNavGPSUpdate(lat, lng, pos);
  }
}

// ── Locate User ─────────────────────────────────────────────────────
function locateUser(forceSimulated = false) {
  const btn = document.getElementById('btn-locate');
  if (btn) {
    btn.innerHTML = '⏳ Acquiring GPS...';
    btn.disabled = true;
  }

  if (!navigator.geolocation) {
    if (typeof showToast === 'function') showToast('Geolocation is not supported by your browser.', 'error');
    else alert('Geolocation is not supported by your browser.');
    if (btn) { btn.innerHTML = '📍 My Location'; btn.disabled = false; }
    return;
  }

  // Clear existing watch if active
  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }

  // If user explicitly requests simulated location
  if (forceSimulated) {
    showUserLocation(13.0827, 80.2707, 100, true);
    if (btn) { btn.innerHTML = '📍 Simulated Location'; btn.disabled = false; }
    if (typeof showToast === 'function') showToast('Using simulated location fallback (13.0827, 80.2707)', 'info');
    return;
  }

  // Check for insecure origin (HTTP on non-localhost IP address)
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!window.isSecureContext && !isLocalhost) {
    console.warn('Geolocation warning: HTTP connection on external IP address.');
    if (typeof showToast === 'function') {
      showToast('⚠️ Mobile browsers require HTTPS or http://localhost for GPS access.', 'warning');
    }
  }

  let locationAcquired = false;

  // Use watchPosition for high-accuracy live GPS tracking
  locationWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      locationAcquired = true;
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;

      showUserLocation(lat, lng, accuracy, !userLocationMarker, pos);

      if (btn) {
        btn.innerHTML = '📍 My Location';
        btn.disabled = false;
      }
    },
    (err) => {
      console.warn('Geolocation error:', err.code, err.message);
      if (btn) { btn.disabled = false; }

      if (!locationAcquired) {
        let msg = 'Could not fetch live GPS position.';
        if (err.code === err.PERMISSION_DENIED) {
          msg = 'Location permission denied. Please allow location access in browser settings.';
          if (btn) btn.innerHTML = '📍 GPS Permission Denied';
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          msg = 'GPS signal unavailable. Please turn on device location/GPS.';
          if (btn) btn.innerHTML = '📍 Retry GPS';
        } else if (err.code === err.TIMEOUT) {
          msg = 'GPS fix timed out. Retrying...';
          if (btn) btn.innerHTML = '📍 Retry GPS';
        }

        if (typeof showToast === 'function') showToast(msg, 'warning');

        // Fallback to simulated location if no position marker exists yet
        if (!userLocationMarker) {
          showUserLocation(13.0827, 80.2707, 100, true);
          if (btn) btn.innerHTML = '📍 Simulated Location';
        }
      }
    },
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    }
  );
}

// ── Pathole Markers Layer ───────────────────────────────────────────
let patholeLayer = L.layerGroup().addTo(map);

function createPatholeMarker(pathole) {
  const color = SEVERITY_COLORS[pathole.severity] || SEVERITY_COLORS.medium;
  const radius = SEVERITY_RADIUS[pathole.severity] || 10;

  const marker = L.circleMarker([pathole.latitude, pathole.longitude], {
    radius: radius,
    fillColor: color,
    fillOpacity: 0.85,
    color: '#ffffff',
    weight: 2.5,
    opacity: 0.95
  });

  const date = pathole.created_at ? new Date(pathole.created_at).toLocaleString() : 'Unknown';

  let distText = '';
  if (pathole.distToRoute !== undefined && pathole.distToRoute !== null) {
    distText = `<div>📏 Distance to Route: <strong>${pathole.distToRoute.toFixed(1)} m</strong></div>`;
  }

  marker.bindPopup(`
    <div class="popup-title">🕳️ Pathole Detected</div>
    <span class="popup-severity ${pathole.severity}">${pathole.severity.toUpperCase()}</span>
    <div class="popup-meta">
      <div>📍 Coords: ${pathole.latitude.toFixed(5)}, ${pathole.longitude.toFixed(5)}</div>
      ${distText}
      <div>📊 Reports: ${pathole.report_count} | Confidence: ${(pathole.confidence * 100).toFixed(0)}%</div>
      ${pathole.accel_peak ? `<div>⚡ Peak Accel: ${pathole.accel_peak.toFixed(1)} m/s²</div>` : ''}
      <div>📅 Date: ${date}</div>
    </div>
  `);

  return marker;
}

// ── Load Patholes ───────────────────────────────────────────────────
async function loadPatholes() {
  try {
    const res = await fetch('/api/patholes');
    const data = await res.json();

    if (data.patholes) {
      allPatholesData = data.patholes;
      window.allPatholesData = allPatholesData;  // Keep window reference fresh
      filterMarkers();

      // Fit map bounds to markers if no user location
      if (!userLocationMarker && patholeLayer.getLayers().length > 0) {
        const group = L.featureGroup(patholeLayer.getLayers());
        map.fitBounds(group.getBounds().pad(0.2));
      }
    }
  } catch (err) {
    console.error('Failed to load patholes:', err);
  }
}

// ── Refresh ─────────────────────────────────────────────────────────
function refreshMap() {
  loadPatholes();
}

// ── Routing & Search ────────────────────────────────────────────────
let currentRouteLayer = null;
let destinationMarker = null;

function setupSearch() {
  const searchInput = document.getElementById('map-search');
  const suggestionsBox = document.getElementById('search-suggestions');
  let searchTimeout = null;

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      const query = e.target.value.trim();
      
      if (query.length < 3) {
        suggestionsBox.style.display = 'none';
        return;
      }
      
      searchTimeout = setTimeout(() => {
        let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=50&lang=en`;
        
        // Prioritize search results near the current map center
        if (map) {
          const center = map.getCenter();
          url += `&lat=${center.lat}&lon=${center.lng}`;
        }

        fetch(url)
          .then(res => res.json())
          .then(data => {
            suggestionsBox.innerHTML = '';
            if (!data.features || data.features.length === 0) {
              suggestionsBox.innerHTML = '<div class="suggestion-item">No results found</div>';
            } else {
              data.features.forEach(feature => {
                const place = feature.properties;
                const coords = feature.geometry.coordinates; // [lon, lat]
                const lat = coords[1];
                const lon = coords[0];
                
                const div = document.createElement('div');
                div.className = 'suggestion-item';
                
                // Clean up the display name for better readability
                const parts = [];
                if (place.name) parts.push(place.name);
                if (place.street) parts.push(place.street);
                if (place.district) parts.push(place.district);
                if (place.city || place.town) parts.push(place.city || place.town);
                if (place.state) parts.push(place.state);
                
                const title = place.name || place.street || place.city || place.town || "Unknown Location";
                const subtitle = parts.filter(p => p !== title).slice(0, 3).join(', ') || place.country || "";
                
                div.innerHTML = `<strong>${title}</strong><br><span style="font-size:0.75rem; color:var(--text-muted);">${subtitle}</span>`;
                div.addEventListener('click', () => {
                  selectDestination(lat, lon, title);
                  suggestionsBox.style.display = 'none';
                  searchInput.value = title;
                });
                suggestionsBox.appendChild(div);
              });
            }
            suggestionsBox.style.display = 'block';
          })
          .catch(err => console.error('Search error:', err));
      }, 400);
    });
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
        suggestionsBox.style.display = 'none';
      }
    });
  }
}

// FEATURE 1: Manual Destination Selection on Map Click/Tap
map.on('click', function(e) {
  // Prevent click handling if click target is popup or control
  if (e.originalEvent && (e.originalEvent._stopped || e.originalEvent.defaultPrevented)) return;

  const lat = e.latlng.lat;
  const lng = e.latlng.lng;

  const defaultTitle = `Selected Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;

  // Update search box text
  const searchInput = document.getElementById('map-search');
  if (searchInput) searchInput.value = defaultTitle;

  // Select destination and automatically calculate route!
  selectDestination(lat, lng, defaultTitle, true);

  // Asynchronous reverse geocoding to update place name
  fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`)
    .then(res => res.json())
    .then(data => {
      if (data && data.features && data.features.length > 0) {
        const props = data.features[0].properties;
        const title = props.name || props.street || props.district || props.city || defaultTitle;

        const destEl = document.getElementById('route-dest-name');
        if (destEl) destEl.textContent = title;
        if (searchInput) searchInput.value = title;

        if (destinationMarker) {
          destinationMarker.setPopupContent(`
            <div class="popup-title">🎯 Destination</div>
            <div class="popup-meta" style="margin-bottom:8px; line-height:1.4;">${title}</div>
            <button class="btn btn-primary btn-sm" onclick="getDirections(${lat}, ${lng})" style="width:100%; padding:8px; margin-top:8px;">
              🗺️ Recalculate Route
            </button>
          `);
        }
      }
    })
    .catch(err => console.log('Reverse geocode fallback:', err));
});

window.selectDestination = function(lat, lon, displayName, autoDirections = true) {
  map.setView([lat, lon], 14);

  if (destinationMarker) {
    map.removeLayer(destinationMarker);
  }

  destinationMarker = L.marker([lat, lon]).addTo(map);
  destinationMarker.bindPopup(`
    <div class="popup-title">🎯 Destination</div>
    <div class="popup-meta" style="margin-bottom:8px; line-height:1.4;">${displayName || 'Selected Destination'}</div>
    <button class="btn btn-primary btn-sm" onclick="getDirections(${lat}, ${lon})" style="width:100%; padding:8px; margin-top:8px;">
      🗺️ Get Directions
    </button>
  `);

  const destNameEl = document.getElementById('route-dest-name');
  if (destNameEl) destNameEl.textContent = displayName || 'Selected Location';

  if (autoDirections) {
    getDirections(lat, lon);
  }
};

window.routingControl = null;

window.getDirections = function(destLat, destLon) {
  if (!userLocationMarker) {
    console.log('User location unknown when calculating route. Attempting geolocation fix...');
    locateUser();
    setTimeout(() => {
      if (userLocationMarker) getDirections(destLat, destLon);
      else alert("Your current location is unknown. Please wait to be located or check your browser permissions.");
    }, 800);
    return;
  }

  const userLat = userLocationMarker.getLatLng().lat;
  const userLon = userLocationMarker.getLatLng().lng;

  if (destinationMarker) destinationMarker.closePopup();

  if (window.routingControl) {
    map.removeControl(window.routingControl);
    window.routingControl = null;
  }
  if (currentRouteLayer) {
    map.removeLayer(currentRouteLayer);
    currentRouteLayer = null;
  }

  window.routingControl = L.Routing.control({
    waypoints: [
      L.latLng(userLat, userLon),
      L.latLng(destLat, destLon)
    ],
    routeWhileDragging: false,
    showAlternatives: false,
    fitSelectedRoutes: false,
    lineOptions: {
      styles: [{ color: '#2563eb', weight: 6, opacity: 0.85 }]
    },
    createMarker: function() { return null; } // Use existing user & destination markers
  }).addTo(map);

  window.routingControl.on('routesfound', function(e) {
    const route = e.routes[0];
    currentRouteCoordinates = route.coordinates; // Save active route geometry

    const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
    const travelTimeMin = Math.round(route.summary.totalTime / 60);
    const etaStr = travelTimeMin >= 60 
      ? Math.floor(travelTimeMin / 60) + 'h ' + (travelTimeMin % 60) + 'm'
      : travelTimeMin + ' min';

    // Manually fit the map to the route with padding and a max zoom limit
    const bounds = L.latLngBounds(route.coordinates);
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });

    const routeInfo = document.getElementById('route-info');
    const routeDistance = document.getElementById('route-distance');
    const routeEta = document.getElementById('route-eta');
    const startNameEl = document.getElementById('route-start-name');

    if (routeDistance) routeDistance.textContent = distanceKm;
    if (routeEta) routeEta.textContent = etaStr;
    if (startNameEl) startNameEl.textContent = 'Current GPS Location';
    if (routeInfo) routeInfo.style.display = 'flex';

    // Hide map click hint when route is displayed
    const hintEl = document.getElementById('map-click-hint');
    if (hintEl) hintEl.classList.add('hidden');

    // FEATURE 2: Filter and display ONLY potholes along this route
    filterMarkers();

    // Toast feedback if available
    const routePotholes = filterPotholesAlongRoute(currentRouteCoordinates, window.ROUTE_PROXIMITY_THRESHOLD_METERS);
    if (typeof showToast === 'function') {
      if (routePotholes.length > 0) {
        showToast(`⚠️ ${routePotholes.length} pothole(s) detected within ${window.ROUTE_PROXIMITY_THRESHOLD_METERS}m of your route!`, 'warning');
      } else {
        showToast(`✅ Route clear! No potholes detected within ${window.ROUTE_PROXIMITY_THRESHOLD_METERS}m of your route.`, 'success');
      }
    }
  });

  window.routingControl.on('routingerror', function(e) {
    console.error('Routing error:', e);
    alert('Could not calculate a route to the selected destination. Please try another location.');
  });
};

window.clearRoute = function() {
  currentRouteCoordinates = null;

  if (window.routingControl) {
    map.removeControl(window.routingControl);
    window.routingControl = null;
  }
  if (currentRouteLayer) {
    map.removeLayer(currentRouteLayer);
    currentRouteLayer = null;
  }
  if (destinationMarker) {
    map.removeLayer(destinationMarker);
    destinationMarker = null;
  }

  const routeInfo = document.getElementById('route-info');
  if (routeInfo) routeInfo.style.display = 'none';

  const hintEl = document.getElementById('map-click-hint');
  if (hintEl) hintEl.classList.remove('hidden');

  const searchInput = document.getElementById('map-search');
  if (searchInput) searchInput.value = '';

  // Clear pothole markers from map when route is cleared
  filterMarkers();
};

// ── Route Proximity & Filtering Logic (Feature 2) ───────────────────

/**
 * Calculates perpendicular distance in meters from point (pLat, pLng) to line segment (aLat, aLng)-(bLat, bLng).
 */
function getDistanceToSegmentMeters(pLat, pLng, aLat, aLng, bLat, bLng) {
  const midLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
  const cosMidLat = Math.cos(midLatRad);
  const DEG_TO_M_LAT = 111320;
  const DEG_TO_M_LNG = 111320 * cosMidLat;

  const ax = 0;
  const ay = 0;
  const bx = (bLng - aLng) * DEG_TO_M_LNG;
  const by = (bLat - aLat) * DEG_TO_M_LAT;
  const px = (pLng - aLng) * DEG_TO_M_LNG;
  const py = (pLat - aLat) * DEG_TO_M_LAT;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  let t = 0;
  if (lenSq > 0) {
    t = (px * dx + py * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }

  const projX = ax + t * dx;
  const projY = ay + t * dy;

  const distSq = (px - projX) * (px - projX) + (py - projY) * (py - projY);
  return Math.sqrt(distSq);
}

/**
 * Calculates minimum distance in meters from a pothole to the route polyline.
 */
function getMinDistanceToRoute(pLat, pLng, routeCoords) {
  if (!routeCoords || routeCoords.length < 2) return Infinity;

  let minDistance = Infinity;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const p1 = routeCoords[i];
    const p2 = routeCoords[i + 1];

    const d = getDistanceToSegmentMeters(
      pLat, pLng,
      p1.lat, p1.lng,
      p2.lat, p2.lng
    );

    if (d < minDistance) {
      minDistance = d;
      if (minDistance < 1) break;
    }
  }

  return minDistance;
}

/**
 * Filters all active stored potholes to return ONLY those within thresholdMeters of routeCoords.
 */
function filterPotholesAlongRoute(routeCoords, thresholdMeters) {
  if (!routeCoords || routeCoords.length === 0) return [];

  const showLow = document.getElementById('filter-low')?.checked ?? true;
  const showMed = document.getElementById('filter-medium')?.checked ?? true;
  const showHigh = document.getElementById('filter-high')?.checked ?? true;

  const routePotholes = [];

  allPatholesData.forEach(p => {
    if (!p.is_active) return;
    if (p.severity === 'low' && !showLow) return;
    if (p.severity === 'medium' && !showMed) return;
    if (p.severity === 'high' && !showHigh) return;

    const dist = getMinDistanceToRoute(p.latitude, p.longitude, routeCoords);

    if (dist <= thresholdMeters) {
      p.distToRoute = dist;
      routePotholes.push(p);
    }
  });

  return routePotholes;
}

window.filterMarkers = function() {
  patholeLayer.clearLayers();

  // FEATURE 2: When there is no active route, do NOT display all potholes globally
  if (!currentRouteCoordinates || currentRouteCoordinates.length === 0) {
    const countEl = document.getElementById('route-potholes-count');
    if (countEl) countEl.textContent = '0';
    return;
  }

  // Display ONLY potholes located within threshold distance (25m) of the active route
  const routePotholes = filterPotholesAlongRoute(
    currentRouteCoordinates,
    window.ROUTE_PROXIMITY_THRESHOLD_METERS
  );

  routePotholes.forEach(p => {
    const marker = createPatholeMarker(p);
    patholeLayer.addLayer(marker);
  });

  const countEl = document.getElementById('route-potholes-count');
  if (countEl) countEl.textContent = routePotholes.length;
};

window.toggleMute = function() {
  isMuted = !isMuted;
  const btn = document.getElementById('btn-mute');
  if (btn) {
    btn.textContent = isMuted ? '🔇' : '🔊';
    btn.title = isMuted ? 'Unmute Audio Warnings' : 'Mute Audio Warnings';
  }
};

// Proximity Warning helpers
function checkProximity(lat, lng) {
  if (isMuted || allPatholesData.length === 0) return;
  allPatholesData.forEach(p => {
    const dist = getDistance(lat, lng, p.latitude, p.longitude);
    if (dist <= 50) {
      if (!alertedPatholes.has(p.id)) {
        alertedPatholes.add(p.id);
        playAlertSound();
        setTimeout(() => {
          speakAlert(`Warning: ${p.severity} severity pathole ahead.`);
        }, 400);
      }
    } else if (dist > 100) {
      alertedPatholes.delete(p.id);
    }
  });
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function playAlertSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // 880Hz pitch (A5)
    gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.35);
  } catch (e) {
    console.error("AudioContext failed:", e);
  }
}

function speakAlert(text) {
  if ('speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.volume = 1.0;
    window.speechSynthesis.speak(utterance);
  }
}

// Manual Pathole Reporting on Map click/contextmenu
map.on('contextmenu', function(e) {
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;
  
  const popupContent = `
    <form class="manual-report-form" onsubmit="submitManualReport(event)">
      <h4>🕳️ Report Pathole</h4>
      <input type="hidden" id="manual-lat" value="${lat}">
      <input type="hidden" id="manual-lng" value="${lng}">
      <div class="form-group">
        <label for="manual-severity">Severity</label>
        <select class="form-control" id="manual-severity" style="width:100%;">
          <option value="low">Low</option>
          <option value="medium" selected>Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <div class="form-group" style="margin-top: 6px;">
        <label for="manual-reporter">Your Name (Optional)</label>
        <input type="text" class="form-control" id="manual-reporter" placeholder="Anonymous" style="width:100%;">
      </div>
      <button type="submit" class="btn btn-primary btn-sm" style="margin-top:10px; width:100%; display:block;">Report</button>
    </form>
  `;
  
  L.popup()
    .setLatLng(e.latlng)
    .setContent(popupContent)
    .openOn(map);
});

window.submitManualReport = async function(event) {
  event.preventDefault();
  const lat = parseFloat(document.getElementById('manual-lat').value);
  const lng = parseFloat(document.getElementById('manual-lng').value);
  const severity = document.getElementById('manual-severity').value;
  const reportedBy = document.getElementById('manual-reporter').value || 'anonymous';
  
  const accelPeak = severity === 'high' ? 26.0 : severity === 'medium' ? 18.0 : 10.0;

  try {
    const res = await fetch('/api/patholes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        latitude: lat,
        longitude: lng,
        severity: severity,
        reported_by: reportedBy,
        accel_peak: accelPeak,
        confidence: 1.0
      })
    });
    
    const data = await res.json();
    if (data.status === 'success') {
      map.closePopup();
      alert("Pathole reported successfully!");
      loadPatholes();
    } else {
      alert("Failed to report: " + data.message);
    }
  } catch (err) {
    console.error("Error reporting manual pathole:", err);
    alert("Network error. Queueing reports offline is active on Detection ride page.");
  }
};

// ── Initial Load ────────────────────────────────────────────────────
setupSearch();
loadPatholes();

// Auto-locate on load
locateUser();

// Auto-refresh every 30 seconds
setInterval(refreshMap, 30000);

