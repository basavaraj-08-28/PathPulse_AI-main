/**
 * PathPulse AI — Dashboard Map Script
 * Initializes the main map and loads pothole markers
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
let allPotholesData = [];
window.allPotholesData = allPotholesData;  // Expose for navigation.js
let alertedPotholes = new Set();
let isMuted = false;


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

  // Check proximity to potholes
  checkProximity(lat, lng);

  // ── Navigation GPS hook — navigation.js subscribes here ──────────
  if (typeof window.onNavGPSUpdate === 'function') {
    window.onNavGPSUpdate(lat, lng, pos);
  }
}

// ── Locate User ─────────────────────────────────────────────────────
function locateUser() {
  const btn = document.getElementById('btn-locate');
  if (btn) {
    btn.innerHTML = '⏳ Locating...';
    btn.disabled = true;
  }

  if (!navigator.geolocation) {
    alert('Geolocation is not supported by your browser.');
    if (btn) { btn.innerHTML = '📍 My Location'; btn.disabled = false; }
    return;
  }

  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
  }

  let firstLoc = true;
  let locationResolved = false;
  
  // Failsafe timeout in case browser geolocation completely hangs (e.g., HTTP context)
  setTimeout(() => {
    if (!locationResolved) {
      console.log('Geolocation hung. Forcing simulated fallback.');
      showUserLocation(13.0827, 80.2707, 100, true);
      if (btn) { btn.innerHTML = '📍 Simulated Location'; btn.disabled = false; }
    }
  }, 2000);
  
  // Use getCurrentPosition to ensure we get an immediate fix
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locationResolved = true;
      showUserLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, true, pos);
      if (btn) { btn.innerHTML = '📍 My Location'; btn.disabled = false; }
      
      // Once we have initial location, start watching for changes
      locationWatchId = navigator.geolocation.watchPosition(
        (wPos) => {
          showUserLocation(wPos.coords.latitude, wPos.coords.longitude, wPos.coords.accuracy, false, wPos);
        },
        (err) => console.warn('Geolocation watch error:', err.message),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      );
    },
    (err) => {
      locationResolved = true;
      console.warn('Geolocation error:', err.message);
      // Fallback to simulated location for testing purposes
      console.log('Using simulated location fallback.');
      showUserLocation(13.0827, 80.2707, 100, true, null);
      if (btn) { btn.innerHTML = '📍 Simulated Location'; btn.disabled = false; }
    },
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 0 }
  );
}

// ── Pothole Markers Layer ───────────────────────────────────────────
let potholeLayer = L.layerGroup().addTo(map);

function createPotholeMarker(pothole) {
  const color = SEVERITY_COLORS[pothole.severity] || SEVERITY_COLORS.medium;
  const radius = SEVERITY_RADIUS[pothole.severity] || 10;

  const marker = L.circleMarker([pothole.latitude, pothole.longitude], {
    radius: radius,
    fillColor: color,
    fillOpacity: 0.8,
    color: '#ffffff',
    weight: 2,
    opacity: 0.9
  });

  const date = pothole.created_at ? new Date(pothole.created_at).toLocaleDateString() : 'Unknown';

  marker.bindPopup(`
    <div class="popup-title">🕳️ Pothole Detected</div>
    <span class="popup-severity ${pothole.severity}">${pothole.severity.toUpperCase()}</span>
    <div class="popup-meta">
      <div>📍 ${pothole.latitude.toFixed(5)}, ${pothole.longitude.toFixed(5)}</div>
      <div>📊 Reports: ${pothole.report_count} | Confidence: ${(pothole.confidence * 100).toFixed(0)}%</div>
      <div>📅 ${date}</div>
    </div>
  `);

  return marker;
}

// ── Load Potholes ───────────────────────────────────────────────────
async function loadPotholes() {
  try {
    const res = await fetch('/api/potholes');
    const data = await res.json();

    if (data.potholes) {
      allPotholesData = data.potholes;
      window.allPotholesData = allPotholesData;  // Keep window reference fresh
      filterMarkers();

      // Fit map bounds to markers if no user location
      if (!userLocationMarker && potholeLayer.getLayers().length > 0) {
        const group = L.featureGroup(potholeLayer.getLayers());
        map.fitBounds(group.getBounds().pad(0.2));
      }
    }
  } catch (err) {
    console.error('Failed to load potholes:', err);
  }
}

// ── Refresh ─────────────────────────────────────────────────────────
function refreshMap() {
  loadPotholes();
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

window.selectDestination = function(lat, lon, displayName) {
  map.setView([lat, lon], 14);
  
  if (destinationMarker) {
    map.removeLayer(destinationMarker);
  }
  
  destinationMarker = L.marker([lat, lon]).addTo(map);
  destinationMarker.bindPopup(`
    <div class="popup-title">🎯 Destination</div>
    <div class="popup-meta" style="margin-bottom:8px; line-height:1.4;">${displayName}</div>
    <button class="btn btn-primary btn-sm" onclick="getDirections(${lat}, ${lon})" style="width:100%; padding:8px; margin-top:8px;">
      🗺️ Get Directions
    </button>
  `).openPopup();
}

window.routingControl = null;

window.getDirections = function(destLat, destLon) {
  if (!userLocationMarker) {
    alert("Your current location is unknown. Please wait to be located or check your browser permissions.");
    return;
  }
  
  const userLat = userLocationMarker.getLatLng().lat;
  const userLon = userLocationMarker.getLatLng().lng;
  
  if (destinationMarker) destinationMarker.closePopup();
  
  if (window.routingControl) {
    map.removeControl(window.routingControl);
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
      styles: [{ color: '#2563eb', weight: 6, opacity: 0.8 }]
    },
    createMarker: function() { return null; } // Use existing markers
  }).addTo(map);

  window.routingControl.on('routesfound', function(e) {
    const route = e.routes[0];
    const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
    
    // Manually fit the map to the route with padding and a max zoom limit
    const bounds = L.latLngBounds(route.coordinates);
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    
    const routeInfo = document.getElementById('route-info');
    const routeDistance = document.getElementById('route-distance');
    
    if (routeInfo && routeDistance) {
      routeDistance.textContent = distanceKm;
      routeInfo.style.display = 'flex';
    }
  });
}

window.clearRoute = function() {
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
  document.getElementById('route-info').style.display = 'none';
  document.getElementById('map-search').value = '';
}

// ── Added Helper Functions ──────────────────────────────────────────

window.filterMarkers = function() {
  potholeLayer.clearLayers();
  const showLow = document.getElementById('filter-low')?.checked ?? true;
  const showMed = document.getElementById('filter-medium')?.checked ?? true;
  const showHigh = document.getElementById('filter-high')?.checked ?? true;

  allPotholesData.forEach(p => {
    if (p.severity === 'low' && !showLow) return;
    if (p.severity === 'medium' && !showMed) return;
    if (p.severity === 'high' && !showHigh) return;

    const marker = createPotholeMarker(p);
    potholeLayer.addLayer(marker);
  });
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
  if (isMuted || allPotholesData.length === 0) return;
  allPotholesData.forEach(p => {
    const dist = getDistance(lat, lng, p.latitude, p.longitude);
    if (dist <= 50) {
      if (!alertedPotholes.has(p.id)) {
        alertedPotholes.add(p.id);
        playAlertSound();
        setTimeout(() => {
          speakAlert(`Warning: ${p.severity} severity pothole ahead.`);
        }, 400);
      }
    } else if (dist > 100) {
      alertedPotholes.delete(p.id);
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

// Manual Pothole Reporting on Map click/contextmenu
map.on('contextmenu', function(e) {
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;
  
  const popupContent = `
    <form class="manual-report-form" onsubmit="submitManualReport(event)">
      <h4>🕳️ Report Pothole</h4>
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
    const res = await fetch('/api/potholes', {
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
      alert("Pothole reported successfully!");
      loadPotholes();
    } else {
      alert("Failed to report: " + data.message);
    }
  } catch (err) {
    console.error("Error reporting manual pothole:", err);
    alert("Network error. Queueing reports offline is active on Detection ride page.");
  }
};

// ── Initial Load ────────────────────────────────────────────────────
setupSearch();
loadPotholes();

// Auto-locate on load
locateUser();

// Auto-refresh every 30 seconds
setInterval(refreshMap, 30000);

