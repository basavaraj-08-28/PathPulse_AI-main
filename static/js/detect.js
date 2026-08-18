/**
 * PathPulse AI — Unified Ride Engine (detect.js)
 * Real-Time Continuous GPS + Accelerometer Pothole Detection + Live Navigation
 *
 * Requirements:
 * 1. Single Ride Session: GPS tracking + Sensor monitoring + Pothole detection + Live navigation running together
 * 2. Destination Search & Route Calculation on Start Ride map
 * 3. Continuous Pothole Detection during Navigation
 * 4. Temporary Pothole Warning System without permanent map markers
 * 5. Route-based pothole proximity warnings
 */

// ═══════════════════════════════════════════════════════════════════
// GLOBAL STATE & RIDE LIFE CYCLE
// ═══════════════════════════════════════════════════════════════════

let isDetecting = false;
let watchId = null;
let detectionCount = 0;
let lastReportTime = 0;

const REPORT_COOLDOWN = 2000; // milliseconds
const PATHOLE_THRESHOLD = 18; // m/s² acceleration spike
const GRAVITY = 9.81;
const ROUTE_PROXIMITY_THRESHOLD_METERS = 30; // metres

// GPS state
let currentPosition = null;
let gpsAccuracy = null;
let gpsAvailable = false;
let gpsError = null;

// Audio & Warning state
let isMuted = false;
let alertedPatholes = new Set();
let allPatholesData = [];

// IndexedDB offline storage
let dbPromise = null;

// Sensor & Acceleration state
const accelHistory = [];
const HISTORY_SIZE = 5;
let accelHandler = null;
let accelChart = null;

// Navigation State
const NAV = {
    isNavigating: false,
    destLat: null,
    destLon: null,
    destName: '',
    currentRoute: null,
    routeSteps: [],
    currentStepIndex: 0,
    spokenInstructions: new Set(),
    spokenPatholes: new Set(),
    lastLat: null,
    lastLon: null,
    lastTimestamp: null,
    currentSpeed: '0',
    recalcCooldown: false,
};

let navMarker = null;
let destinationMarker = null;

// ═══════════════════════════════════════════════════════════════════
// INDEXEDDB OFFLINE QUEUE
// ═══════════════════════════════════════════════════════════════════

function initIndexedDB() {
    if (!window.indexedDB) {
        console.warn("IndexedDB is not supported.");
        return;
    }
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("PathPulseOffline", 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains("patholes")) {
                db.createObjectStore("patholes", { keyPath: "id" });
            }
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}
initIndexedDB();

// ═══════════════════════════════════════════════════════════════════
// LEAFLET MAP INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

const map = L.map("detect-map", {
    zoomControl: true,
    attributionControl: true
}).setView([12.971599, 77.594566], 15);

L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    {
        attribution: "&copy; CARTO &copy; OSM",
        maxZoom: 19
    }
).addTo(map);

let userMarker = null;
let userAccuracyCircle = null;
let pulseMarker = null;
let pulseTimer = null;
let routeLine = null;
const routeCoords = [];
const patholeLayer = L.layerGroup().addTo(map);

const SEVERITY_COLORS = {
    low: "#3b82f6",
    medium: "#f59e0b",
    high: "#ef4444"
};

// ═══════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════

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

function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 400);
    }, 3500);
}

// ═══════════════════════════════════════════════════════════════════
// AUDIO & SPEECH SYNTHESIS
// ═══════════════════════════════════════════════════════════════════

function playAlertSound() {
    if (isMuted) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
        console.warn('Audio alert error:', e);
    }
}

window.toggleMute = function() {
    isMuted = !isMuted;
    const btn = document.getElementById('btn-mute');
    if (btn) btn.innerHTML = isMuted ? '🔇' : '🔊';
    showToast(isMuted ? 'Muted audio warnings' : 'Unmuted audio warnings', 'info');
};

let _speechQueue = [];
let _isSpeaking = false;

function speakNav(text) {
    if (isMuted || typeof window.speechSynthesis === 'undefined') return;
    if (_speechQueue.includes(text)) return;
    _speechQueue.push(text);
    _drainSpeechQueue();
}

function _drainSpeechQueue() {
    if (_isSpeaking || _speechQueue.length === 0) return;
    _isSpeaking = true;
    const text = _speechQueue.shift();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    utter.volume = 1.0;
    utter.pitch = 1.0;
    utter.onend = () => { _isSpeaking = false; _drainSpeechQueue(); };
    utter.onerror = () => { _isSpeaking = false; _drainSpeechQueue(); };
    window.speechSynthesis.speak(utter);
}

// ═══════════════════════════════════════════════════════════════════
// GPS TRACKING & MARKER UPDATES
// ═══════════════════════════════════════════════════════════════════

function checkGPSAvailability() {
    if (!navigator.geolocation) {
        gpsAvailable = false;
        gpsError = "Geolocation is not supported by this browser.";
        updateGPSStatus("error", "❌ GPS not supported");
        return false;
    }
    return true;
}

function updateGPSStatus(state, message, accuracy = null) {
    const gpsStatus = document.getElementById("gps-status");
    const gpsAccuracyEl = document.getElementById("gps-accuracy");
    if (gpsStatus) {
        gpsStatus.textContent = message;
        gpsStatus.className = state;
    }
    if (gpsAccuracyEl) {
        if (accuracy !== null && Number.isFinite(accuracy)) {
            gpsAccuracyEl.textContent = `±${Math.round(accuracy)} m`;
        } else {
            gpsAccuracyEl.textContent = "--";
        }
    }
}

function updateUserLocationOnMap(lat, lng, accuracy, centerMap = false) {
    const position = [lat, lng];

    if (!userMarker) {
        userMarker = L.circleMarker(position, {
            radius: 8,
            fillColor: "#06d6a0",
            fillOpacity: 1,
            color: "#ffffff",
            weight: 3
        }).addTo(map).bindPopup("📍 You are here");
    } else {
        userMarker.setLatLng(position);
    }

    if (!userAccuracyCircle) {
        userAccuracyCircle = L.circle(position, {
            radius: accuracy || 20,
            fillColor: "#06d6a0",
            fillOpacity: 0.08,
            color: "#06d6a0",
            weight: 1,
            opacity: 0.3
        }).addTo(map);
    } else {
        userAccuracyCircle.setLatLng(position);
        if (accuracy && Number.isFinite(accuracy)) {
            userAccuracyCircle.setRadius(accuracy);
        }
    }

    if (!pulseMarker) {
        pulseMarker = L.circleMarker(position, {
            radius: 20,
            fillColor: "#336ac8",
            fillOpacity: 0.15,
            color: "#06d6a0",
            weight: 1,
            opacity: 0.5
        }).addTo(map);

        if (!pulseTimer) {
            pulseTimer = setInterval(() => {
                if (!currentPosition || !pulseMarker) return;
                pulseMarker.setLatLng([currentPosition.lat, currentPosition.lng]);
            }, 500);
        }
    } else {
        pulseMarker.setLatLng(position);
    }

    if (centerMap) {
        map.setView(position, 17);
    }
}

function startGPSTracking() {
    if (!checkGPSAvailability()) return false;
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    gpsAvailable = false;
    gpsError = null;
    updateGPSStatus("warning", "⏳ Acquiring GPS...");

    watchId = navigator.geolocation.watchPosition(
        onPositionUpdate,
        onPositionError,
        {
            enableHighAccuracy: true,
            timeout: 20000,
            maximumAge: 1000
        }
    );
    return true;
}

function stopGPSTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    gpsAvailable = false;
    updateGPSStatus("warning", "GPS tracking stopped");
}

function onPositionUpdate(position) {
    if (!position || !position.coords) return;
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const accuracy = position.coords.accuracy;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const now = Date.now();
    if (position.coords.speed !== null && position.coords.speed >= 0) {
        NAV.currentSpeed = (position.coords.speed * 3.6).toFixed(1);
    } else if (NAV.lastLat !== null) {
        const dt = (now - NAV.lastTimestamp) / 1000;
        if (dt > 0) {
            const dist = haversineMeters(NAV.lastLat, NAV.lastLon, lat, lng);
            NAV.currentSpeed = ((dist / dt) * 3.6).toFixed(1);
        }
    }

    NAV.lastLat = lat;
    NAV.lastLon = lng;
    NAV.lastTimestamp = now;

    currentPosition = {
        lat: lat,
        lng: lng,
        accuracy: accuracy,
        timestamp: position.timestamp
    };

    gpsAccuracy = accuracy;
    gpsAvailable = true;
    gpsError = null;

    updateGPSStatus("success", "📍 GPS Active", accuracy);
    updateUserLocationOnMap(lat, lng, accuracy, userMarker === null);
    addRouteCoordinate(lat, lng);

    if (isDetecting && !NAV.isNavigating) {
        updateStatus("detecting", "🔍 Scanning road surface...");
    }

    // Live Navigation GPS update
    if (NAV.isNavigating) {
        const heading = position.coords.heading || 0;
        updateNavMarker(lat, lng, heading);
        updateDashboard(lat, lng, accuracy ? accuracy.toFixed(0) : '—');
        checkRouteDeviation(lat, lng);
        checkNextTurnInstruction(lat, lng);
        checkPatholeProximityNav(lat, lng);
    }
}

function onPositionError(error) {
    console.warn("GPS Error:", error.code, error.message);
    gpsAvailable = false;
    gpsError = error;
    let message = "⚠️ Unable to get GPS location";
    if (error.code === error.PERMISSION_DENIED) message = "❌ Location permission denied";
    else if (error.code === error.POSITION_UNAVAILABLE) message = "⚠️ GPS signal unavailable";
    else if (error.code === error.TIMEOUT) message = "⏳ GPS timeout — retrying...";

    updateGPSStatus("error", message);
    if (isDetecting) updateStatus("warning", message);
}

function addRouteCoordinate(lat, lng) {
    const lastPoint = routeCoords.length > 0 ? routeCoords[routeCoords.length - 1] : null;
    if (lastPoint) {
        const distance = haversineMeters(lastPoint[0], lastPoint[1], lat, lng);
        if (distance < 2) return;
    }

    routeCoords.push([lat, lng]);
    if (!routeLine) {
        routeLine = L.polyline(routeCoords, {
            color: "#06d6a0",
            weight: 3,
            opacity: 0.6,
            dashArray: "8, 8"
        }).addTo(map);
    } else {
        routeLine.setLatLngs(routeCoords);
    }
}

// ═══════════════════════════════════════════════════════════════════
// ACCELEROMETER SENSOR & POTHOLE DETECTION ALGORITHM
// ═══════════════════════════════════════════════════════════════════

function startAccelerometer() {
    if (!window.DeviceMotionEvent) {
        console.warn("DeviceMotionEvent is not supported.");
        updateStatus("warning", "⚠️ Accelerometer unavailable");
        return;
    }

    if (typeof DeviceMotionEvent.requestPermission === "function") {
        DeviceMotionEvent.requestPermission()
            .then((state) => {
                if (state === "granted") attachAccelListener();
                else alert("Accelerometer permission denied.");
            })
            .catch(err => console.error("Accelerometer permission error:", err));
    } else {
        attachAccelListener();
    }
}

function attachAccelListener() {
    if (accelHandler) return;
    accelHandler = (event) => {
        if (!isDetecting) return;
        const acc = event.accelerationIncludingGravity || event.acceleration;
        if (acc && Number.isFinite(acc.x) && Number.isFinite(acc.y) && Number.isFinite(acc.z)) {
            processAccelData(acc.x, acc.y, acc.z);
        }
    };
    window.addEventListener("devicemotion", accelHandler, { passive: true });
}

function stopAccelerometer() {
    if (accelHandler) {
        window.removeEventListener("devicemotion", accelHandler);
        accelHandler = null;
    }
}

function processAccelData(x, y, z) {
    const accelX = document.getElementById("accel-x");
    const accelY = document.getElementById("accel-y");
    const accelZ = document.getElementById("accel-z");
    if (accelX) accelX.textContent = x.toFixed(1);
    if (accelY) accelY.textContent = y.toFixed(1);
    if (accelZ) accelZ.textContent = z.toFixed(1);

    const magnitude = Math.sqrt(x * x + y * y + z * z);
    const deviation = Math.abs(magnitude - GRAVITY);

    const magnitudeValue = document.getElementById("magnitude-value");
    if (magnitudeValue) magnitudeValue.textContent = deviation.toFixed(1) + " m/s²";

    const barPercent = Math.min(100, (deviation / 40) * 100);
    const fill = document.getElementById("magnitude-fill");
    if (fill) {
        fill.style.width = barPercent + "%";
        if (deviation > PATHOLE_THRESHOLD) fill.style.background = "linear-gradient(90deg, #f59e0b, #ef4444)";
        else if (deviation > PATHOLE_THRESHOLD * 0.6) fill.style.background = "linear-gradient(90deg, #06d6a0, #f59e0b)";
        else fill.style.background = "var(--gradient-1)";
    }

    accelHistory.push(deviation);
    if (accelHistory.length > HISTORY_SIZE) accelHistory.shift();

    if (accelChart) {
        accelChart.data.datasets[0].data.push(deviation);
        accelChart.data.datasets[0].data.shift();
        accelChart.update("none");
    }

    const now = Date.now();
    if (deviation > PATHOLE_THRESHOLD && now - lastReportTime > REPORT_COOLDOWN) {
        lastReportTime = now;
        onPatholeDetected(deviation);
    }
}

async function onPatholeDetected(accelPeak) {
    detectionCount++;

    if (!currentPosition || !gpsAvailable) {
        console.warn("Pothole detected, but no valid GPS position is available.");
        updateStatus("warning", "⚠️ Pothole detected — waiting for GPS...");
        addLogEntry("medium", 0, 0, accelPeak, false);
        return;
    }

    const lat = currentPosition.lat;
    const lng = currentPosition.lng;
    const accuracy = currentPosition.accuracy;

    let severity = accelPeak >= 25 ? "high" : accelPeak >= 15 ? "medium" : "low";

    updateStatus("alert", `🚨 POTHOLE DETECTED — ${severity.toUpperCase()}`);
    setTimeout(() => {
        if (isDetecting) updateStatus("detecting", NAV.isNavigating ? "🚗 Navigating & Scanning..." : "🔍 Scanning road surface...");
    }, 2000);

    // Audio & Warning UI
    playAlertSound();
    showPatholeWarning({ severity, latitude: lat, longitude: lng }, 0);

    addLogEntry(severity, lat, lng, accelPeak, true);

    const reportData = {
        latitude: lat,
        longitude: lng,
        accel_peak: accelPeak,
        confidence: Math.min(1.0, accelPeak / 40),
        accuracy: accuracy || null,
        created_at: new Date().toISOString()
    };

    if (!navigator.onLine) {
        saveOfflinePathole(lat, lng, accelPeak, accuracy);
        return;
    }

    try {
        const response = await fetch("/api/patholes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reportData)
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        console.log("Pothole report uploaded successfully.");
    } catch (error) {
        console.warn("Network request failed. Saving offline.", error);
        saveOfflinePathole(lat, lng, accelPeak, accuracy);
    }
}

function updateStatus(state, text) {
    const indicator = document.getElementById("status-indicator");
    const statusText = document.getElementById("status-text");
    if (indicator) indicator.className = "status-indicator " + state;
    if (statusText) statusText.textContent = text;
}

function addLogEntry(severity, lat, lng, accelPeak, gpsValid = true) {
    const log = document.getElementById("detection-log");
    const countEl = document.getElementById("log-count");
    if (!log) return;

    if (detectionCount === 1) log.innerHTML = "";
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement("div");
    entry.className = "log-entry";
    const locationText = gpsValid ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : "Waiting for GPS";

    entry.innerHTML = `
        <span class="severity-dot ${severity}"></span>
        <span>
            <strong>${severity.toUpperCase()}</strong> — ${accelPeak.toFixed(1)} m/s²<br>
            <small>📍 ${locationText}</small>
        </span>
        <span class="log-time">${time}</span>
    `;
    log.insertBefore(entry, log.firstChild);
    if (countEl) countEl.textContent = detectionCount + " detection" + (detectionCount !== 1 ? "s" : "");
}

// ═══════════════════════════════════════════════════════════════════
// DESTINATION SEARCH & ROUTE CALCULATION
// ═══════════════════════════════════════════════════════════════════

function setupSearch() {
    const searchInput = document.getElementById('map-search');
    const suggestionsBox = document.getElementById('search-suggestions');
    let searchTimeout = null;

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            const query = e.target.value.trim();
            if (query.length < 3) {
                if (suggestionsBox) suggestionsBox.style.display = 'none';
                return;
            }

            searchTimeout = setTimeout(() => {
                let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=10&lang=en`;
                if (currentPosition) {
                    url += `&lat=${currentPosition.lat}&lon=${currentPosition.lng}`;
                }

                fetch(url)
                    .then(res => res.json())
                    .then(data => {
                        if (!suggestionsBox) return;
                        suggestionsBox.innerHTML = '';
                        if (!data.features || data.features.length === 0) {
                            suggestionsBox.innerHTML = '<div class="suggestion-item">No results found</div>';
                        } else {
                            data.features.forEach(feature => {
                                const place = feature.properties;
                                const coords = feature.geometry.coordinates;
                                const lat = coords[1];
                                const lon = coords[0];
                                const title = place.name || place.street || place.city || place.town || 'Unknown Location';
                                const subtitle = [place.street, place.district, place.city || place.town, place.state, place.country].filter(Boolean).filter(p => p !== title).slice(0, 3).join(', ');

                                const div = document.createElement('div');
                                div.className = 'suggestion-item';
                                div.innerHTML = `<strong>${title}</strong><br><span style="font-size:0.75rem; color:var(--text-muted);">${subtitle}</span>`;
                                div.addEventListener('click', () => {
                                    saveRecent(title, lat, lon);
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

        document.addEventListener('click', (e) => {
            if (suggestionsBox && !searchInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
                suggestionsBox.style.display = 'none';
            }
        });
    }
}

map.on('click', function(e) {
    if (e.originalEvent && (e.originalEvent._stopped || e.originalEvent.defaultPrevented)) return;
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    const defaultTitle = `Selected Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;

    const searchInput = document.getElementById('map-search');
    if (searchInput) searchInput.value = defaultTitle;

    selectDestination(lat, lng, defaultTitle, true);

    fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`)
        .then(res => res.json())
        .then(data => {
            if (data && data.features && data.features.length > 0) {
                const props = data.features[0].properties;
                const title = props.name || props.street || props.district || props.city || defaultTitle;
                const destEl = document.getElementById('route-dest-name');
                if (destEl) destEl.textContent = title;
                if (searchInput) searchInput.value = title;
                NAV.destName = title;
            }
        })
        .catch(err => console.log('Reverse geocode fallback:', err));
});

window.selectDestination = function(lat, lon, displayName, autoDirections = true) {
    map.setView([lat, lon], 15);

    if (destinationMarker) {
        map.removeLayer(destinationMarker);
    }

    destinationMarker = L.marker([lat, lon]).addTo(map);
    destinationMarker.bindPopup(`
      <div class="popup-title">🎯 Destination</div>
      <div class="popup-meta" style="margin-bottom:8px; line-height:1.4;">${displayName || 'Selected Destination'}</div>
      <button class="btn btn-primary btn-sm" onclick="getDirections(${lat}, ${lon})" style="width:100%; padding:8px; margin-top:8px;">
        🗺️ Calculate Route
      </button>
    `);

    const destNameEl = document.getElementById('route-dest-name');
    if (destNameEl) destNameEl.textContent = displayName || 'Selected Location';

    NAV.destLat = lat;
    NAV.destLon = lon;
    NAV.destName = displayName || 'Selected Destination';

    if (autoDirections) {
        getDirections(lat, lon);
    }
};

window.getDirections = function(destLat, destLon) {
    if (!currentPosition || !currentPosition.lat) {
        showToast("📍 Acquiring your GPS location first...", "warning");
        if (!isDetecting) startDetection();
        setTimeout(() => {
            if (currentPosition && currentPosition.lat) {
                getDirections(destLat, destLon);
            } else {
                alert("Your current GPS location is not available. Please allow location permission.");
            }
        }, 2000);
        return;
    }

    const userLat = currentPosition.lat;
    const userLon = currentPosition.lng;

    if (destinationMarker) destinationMarker.closePopup();
    if (window.routingControl) {
        map.removeControl(window.routingControl);
        window.routingControl = null;
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
        createMarker: function() { return null; }
    }).addTo(map);

    window.routingControl.on('routesfound', function(e) {
        const route = e.routes[0];
        NAV.currentRoute = route.coordinates;
        NAV.routeSteps = route.instructions || [];

        const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
        const travelTimeMin = Math.round(route.summary.totalTime / 60);
        const etaStr = travelTimeMin >= 60
            ? Math.floor(travelTimeMin / 60) + 'h ' + (travelTimeMin % 60) + 'm'
            : travelTimeMin + ' min';

        const bounds = L.latLngBounds(route.coordinates);
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });

        const routeInfo = document.getElementById('route-info');
        const routeDistance = document.getElementById('route-distance');
        const routeEta = document.getElementById('route-eta');
        const startNameEl = document.getElementById('route-start-name');
        const btnStartNav = document.getElementById('btn-start-nav');

        if (routeDistance) routeDistance.textContent = distanceKm;
        if (routeEta) routeEta.textContent = etaStr;
        if (startNameEl) startNameEl.textContent = 'Current GPS Position';
        if (routeInfo) routeInfo.style.display = 'block';
        if (btnStartNav) btnStartNav.style.display = 'inline-flex';

        const hintEl = document.getElementById('map-click-hint');
        if (hintEl) hintEl.classList.add('hidden');

        const routePotholes = filterPotholesAlongRoute(NAV.currentRoute, ROUTE_PROXIMITY_THRESHOLD_METERS);
        const countEl = document.getElementById('route-potholes-count');
        if (countEl) countEl.textContent = routePotholes.length;

        if (routePotholes.length > 0) {
            showToast(`⚠️ ${routePotholes.length} pothole(s) detected near your route!`, 'warning');
        } else {
            showToast(`✅ Route clear! No potholes detected along this route.`, 'success');
        }

        const autoToggle = document.getElementById('auto-nav-toggle');
        if (autoToggle && autoToggle.checked && !NAV.isNavigating) {
            startNavigation();
        }
    });

    window.routingControl.on('routingerror', function(e) {
        console.error('Routing error:', e);
        showToast('Could not calculate a route to the selected destination.', 'error');
    });
};

window.clearRoute = function() {
    NAV.currentRoute = null;
    NAV.routeSteps = [];
    if (window.routingControl) {
        map.removeControl(window.routingControl);
        window.routingControl = null;
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
    if (NAV.isNavigating) stopNavigation();
};

// ═══════════════════════════════════════════════════════════════════
// LIVE TURN-BY-TURN NAVIGATION SYSTEM
// ═══════════════════════════════════════════════════════════════════

function updateNavMarker(lat, lng, heading) {
    const icon = L.divIcon({
        className: 'nav-marker',
        html: `<div class="nav-dot" style="transform:rotate(${heading || 0}deg)">
                 <div class="nav-dot-inner"></div>
                 <div class="nav-dot-halo"></div>
               </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
    });

    if (!navMarker) {
        navMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 })
                      .addTo(map)
                      .bindTooltip('You', { permanent: false, direction: 'top' });
    } else {
        navMarker.setLatLng([lat, lng]);
        navMarker.setIcon(icon);
    }
}

function removeNavMarker() {
    if (navMarker) {
        map.removeLayer(navMarker);
        navMarker = null;
    }
}

window.startNavigation = function(destLat, destLon, destName) {
    if (!destLat || !destLon) {
        destLat = NAV.destLat;
        destLon = NAV.destLon;
        destName = NAV.destName;
    }
    if (!destLat || !destLon) {
        showToast('Please select a destination first.', 'warning');
        return;
    }

    NAV.isNavigating = true;
    NAV.destLat = destLat;
    NAV.destLon = destLon;
    NAV.destName = destName || 'Destination';
    NAV.currentStepIndex = 0;
    NAV.spokenInstructions = new Set();
    NAV.spokenPatholes = new Set();
    NAV.recalcCooldown = false;

    if (!isDetecting) {
        startDetection();
    }

    const navDash = document.getElementById('nav-dashboard');
    const btnStartNav = document.getElementById('btn-start-nav');
    const btnStopNav = document.getElementById('btn-stop-nav');
    const navStatusText = document.getElementById('nav-status-text');
    const navStatusBadge = document.getElementById('nav-status-badge');

    if (navDash) navDash.style.display = 'flex';
    if (btnStartNav) btnStartNav.style.display = 'none';
    if (btnStopNav) btnStopNav.style.display = 'inline-flex';
    if (navStatusText) navStatusText.textContent = 'Navigating';
    if (navStatusBadge) navStatusBadge.className = 'nav-status-badge navigating';

    if (currentPosition) {
        map.setView([currentPosition.lat, currentPosition.lng], 17, { animate: true });
    }

    speakNav('Navigation started. Follow the route.');
    showToast('🚗 Live Navigation started! Pothole detection active.', 'success');
};

window.stopNavigation = function() {
    NAV.isNavigating = false;
    removeNavMarker();

    const navDash = document.getElementById('nav-dashboard');
    const btnStartNav = document.getElementById('btn-start-nav');
    const btnStopNav = document.getElementById('btn-stop-nav');

    if (navDash) navDash.style.display = 'none';
    if (btnStartNav) btnStartNav.style.display = 'inline-flex';
    if (btnStopNav) btnStopNav.style.display = 'none';

    hidePatholeWarning();
    speakNav('Navigation stopped.');
    showToast('Navigation stopped.', 'info');
};

function updateDashboard(lat, lng, accuracy) {
    let remainDist = '—';
    let etaStr = '—';
    let nextTurn = '—';

    if (NAV.currentRoute && NAV.currentRoute.length > 0) {
        const { idx } = closestPointOnRoute(lat, lng);
        const remaining = routeLengthFrom(idx);
        remainDist = remaining >= 1000
            ? (remaining / 1000).toFixed(1) + ' km'
            : Math.round(remaining) + ' m';

        const speedKmh = parseFloat(NAV.currentSpeed) || 40;
        const etaMins = Math.round((remaining / 1000) / speedKmh * 60);
        if (etaMins < 60) {
            etaStr = etaMins + ' min';
        } else {
            etaStr = Math.floor(etaMins / 60) + 'h ' + (etaMins % 60) + 'm';
        }
    }

    if (NAV.routeSteps.length > 0 && NAV.currentStepIndex < NAV.routeSteps.length) {
        const step = NAV.routeSteps[NAV.currentStepIndex];
        nextTurn = formatInstruction(step);
    } else if (NAV.currentRoute) {
        nextTurn = '🏁 Destination ahead';
    }

    _setDash('dash-distance', remainDist);
    _setDash('dash-eta', etaStr);
    _setDash('dash-speed', NAV.currentSpeed + ' km/h');
    _setDash('dash-accuracy', accuracy ? accuracy + ' m' : '—');
    _setDash('dash-next-turn', nextTurn);
}

function _setDash(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function closestPointOnRoute(lat, lng) {
    if (!NAV.currentRoute || NAV.currentRoute.length === 0) return { idx: 0, dist: Infinity };
    let minD = Infinity;
    let closestIdx = 0;
    NAV.currentRoute.forEach((pt, i) => {
        const d = haversineMeters(lat, lng, pt.lat, pt.lng);
        if (d < minD) {
            minD = d;
            closestIdx = i;
        }
    });
    return { idx: closestIdx, dist: minD };
}

function routeLengthFrom(startIndex) {
    if (!NAV.currentRoute || startIndex >= NAV.currentRoute.length - 1) return 0;
    let total = 0;
    for (let i = startIndex; i < NAV.currentRoute.length - 1; i++) {
        const p1 = NAV.currentRoute[i];
        const p2 = NAV.currentRoute[i + 1];
        total += haversineMeters(p1.lat, p1.lng, p2.lat, p2.lng);
    }
    return total;
}

function checkRouteDeviation(lat, lng) {
    if (!NAV.currentRoute || NAV.currentRoute.length === 0) return;
    if (NAV.recalcCooldown) return;

    const { dist } = closestPointOnRoute(lat, lng);
    if (dist > 50) { // 50m off route
        console.log(`[Nav] Off-route by ${dist.toFixed(0)}m — recalculating…`);
        NAV.recalcCooldown = true;
        speakNav('Recalculating route.');
        showToast('↩️ Off route — recalculating…', 'warning');

        getDirections(NAV.destLat, NAV.destLon);

        setTimeout(() => { NAV.recalcCooldown = false; }, 15000);
    }
}

function checkNextTurnInstruction(lat, lng) {
    if (NAV.routeSteps.length === 0) return;
    const step = NAV.routeSteps[NAV.currentStepIndex];
    if (!step) return;

    const stepCoord = step.waypoint || (NAV.currentRoute && NAV.currentRoute[step.index]) || null;
    if (!stepCoord) return;

    const distToStep = haversineMeters(lat, lng, stepCoord.lat, stepCoord.lng);
    if (distToStep < 80 && !NAV.spokenInstructions.has(NAV.currentStepIndex)) {
        NAV.spokenInstructions.add(NAV.currentStepIndex);
        const instruction = buildVoiceInstruction(step);
        speakNav(instruction);
        _setDash('dash-next-turn', formatInstruction(step));
    }

    if (distToStep < 20 && NAV.currentStepIndex < NAV.routeSteps.length - 1) {
        NAV.currentStepIndex++;
    }

    const destDist = haversineMeters(lat, lng, NAV.destLat, NAV.destLon);
    if (destDist < 30 && !NAV.spokenInstructions.has('destination')) {
        NAV.spokenInstructions.add('destination');
        speakNav('You have arrived at your destination.');
        showToast('🏁 You have arrived!', 'success');
        _setDash('dash-next-turn', '🏁 Arrived!');
        const badge = document.getElementById('nav-status-badge');
        const text = document.getElementById('nav-status-text');
        if (badge) badge.className = 'nav-status-badge arrived';
        if (text) text.textContent = 'Arrived';
    }
}

function buildVoiceInstruction(step) {
    const type = step.type || '';
    const road = step.road ? ` onto ${step.road}` : '';
    const dist = step.distance ? ` in ${Math.round(step.distance)} metres` : '';
    const map = {
        'Head': `Continue straight${road}${dist}`,
        'TurnLeft': `Turn left${road}${dist}`,
        'TurnRight': `Turn right${road}${dist}`,
        'TurnSlightLeft': `Keep left${road}${dist}`,
        'TurnSlightRight': `Keep right${road}${dist}`,
        'TurnSharpLeft': `Sharp left turn${road}${dist}`,
        'TurnSharpRight': `Sharp right turn${road}${dist}`,
        'Roundabout': `Enter the roundabout${dist}`,
        'WaypointReached': `Waypoint reached`,
        'DestinationReached': `You have arrived at your destination`,
    };
    return map[type] || step.text || 'Continue straight';
}

function formatInstruction(step) {
    const type = step.type || '';
    const icons = {
        'TurnLeft': '⬅️ Turn Left',
        'TurnRight': '➡️ Turn Right',
        'TurnSlightLeft': '↖️ Keep Left',
        'TurnSlightRight': '↗️ Keep Right',
        'TurnSharpLeft': '⬅️ Sharp Left',
        'TurnSharpRight': '➡️ Sharp Right',
        'Head': '⬆️ Continue Straight',
        'Roundabout': '🔄 Roundabout',
        'DestinationReached': '🏁 Destination',
    };
    const dist = step.distance ? ` — ${Math.round(step.distance)}m` : '';
    return (icons[type] || '⬆️ ' + (step.text || 'Continue')) + dist;
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE-BASED POTHOLE WARNING SYSTEM
// ═══════════════════════════════════════════════════════════════════

function checkPatholeProximityNav(lat, lng) {
    const patholes = allPatholesData || [];
    if (patholes.length === 0) return;

    let closest = null;
    let closestDist = Infinity;

    patholes.forEach(p => {
        if (!p.is_active) return;
        const d = haversineMeters(lat, lng, p.latitude, p.longitude);
        if (d <= 50 && d < closestDist) {
            closest = p;
            closestDist = d;
        }
    });

    if (closest) {
        showPatholeWarning(closest, Math.round(closestDist));
        if (!NAV.spokenPatholes.has(closest.id)) {
            NAV.spokenPatholes.add(closest.id);
            speakNav(`Warning. ${closest.severity} severity pothole ahead in ${Math.round(closestDist)} metres.`);
        }
    } else {
        hidePatholeWarning();
        patholes.forEach(p => {
            const d = haversineMeters(lat, lng, p.latitude, p.longitude);
            if (d > 80) NAV.spokenPatholes.delete(p.id);
        });
    }
}

let warningTimeout = null;
function showPatholeWarning(pathole, distMetres) {
    const card = document.getElementById('pathole-warning-card');
    if (!card) return;

    const sev = (pathole.severity || 'medium').toUpperCase();
    const emoji = pathole.severity === 'high' ? '🔴' : pathole.severity === 'medium' ? '🟡' : '🟢';
    const distText = distMetres > 0 ? `${distMetres} metres ahead` : 'Detected right now!';

    card.innerHTML = `
        <div class="pw-icon">⚠️</div>
        <div class="pw-content">
          <div class="pw-title">${emoji} ${sev} Pothole Warning</div>
          <div class="pw-dist">${distText}</div>
        </div>
    `;
    card.style.display = 'flex';
    card.classList.add('pw-visible');

    if (warningTimeout) clearTimeout(warningTimeout);
    warningTimeout = setTimeout(() => {
        hidePatholeWarning();
    }, 4000);
}

function hidePatholeWarning() {
    const card = document.getElementById('pathole-warning-card');
    if (!card) return;
    card.classList.remove('pw-visible');
    setTimeout(() => {
        if (!card.classList.contains('pw-visible')) {
            card.style.display = 'none';
        }
    }, 300);
}

function filterPotholesAlongRoute(routeCoords, thresholdMeters) {
    if (!routeCoords || routeCoords.length === 0) return [];
    const routePotholes = [];
    allPatholesData.forEach(p => {
        if (!p.is_active) return;
        let minD = Infinity;
        for (let i = 0; i < routeCoords.length - 1; i++) {
            const d = haversineMeters(p.latitude, p.longitude, routeCoords[i].lat, routeCoords[i].lng);
            if (d < minD) minD = d;
        }
        if (minD <= thresholdMeters) {
            p.distToRoute = minD;
            routePotholes.push(p);
        }
    });
    return routePotholes;
}

// ═══════════════════════════════════════════════════════════════════
// RECENT & FAVOURITE DESTINATIONS
// ═══════════════════════════════════════════════════════════════════

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
    if (list.length > 5) list = list.slice(0, 5);
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
        const listEl = document.getElementById('recent-dest-list');
        const items = getRecent();
        if (listEl) {
            if (items.length === 0) {
                listEl.innerHTML = '<div style="padding:8px; font-size:0.75rem; color:var(--text-muted);">No recent destinations</div>';
            } else {
                listEl.innerHTML = items.map(i => `
                    <div class="dest-item" onclick="selectDestination(${i.lat}, ${i.lng}, '${i.name.replace(/'/g, "\\'")}'); document.getElementById('recent-dest-panel').style.display='none';">
                        📍 <strong>${i.name}</strong>
                    </div>
                `).join('');
            }
        }
        rp.style.display = 'block';
    }
};

window.toggleFavPanel = function() {
    const rp = document.getElementById('recent-dest-panel');
    const fp = document.getElementById('fav-dest-panel');
    if (rp) rp.style.display = 'none';
    if (!fp) return;

    if (fp.style.display === 'block') {
        fp.style.display = 'none';
    } else {
        const listEl = document.getElementById('fav-dest-list');
        const items = getFavs();
        if (listEl) {
            if (items.length === 0) {
                listEl.innerHTML = '<div style="padding:8px; font-size:0.75rem; color:var(--text-muted);">No favourite destinations</div>';
            } else {
                listEl.innerHTML = items.map(i => `
                    <div class="dest-item" onclick="selectDestination(${i.lat}, ${i.lng}, '${i.name.replace(/'/g, "\\'")}'); document.getElementById('fav-dest-panel').style.display='none';">
                        ⭐ <strong>${i.name}</strong>
                    </div>
                `).join('');
            }
        }
        fp.style.display = 'block';
    }
};

// ═══════════════════════════════════════════════════════════════════
// START / STOP RIDE LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

function startDetection() {
    if (!checkGPSAvailability()) return;

    const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!window.isSecureContext && !isLocalhost) {
        alert("GPS requires HTTPS on mobile browsers.\nPlease open PathPulse using HTTPS.");
        updateGPSStatus("error", "❌ HTTPS required for GPS");
        return;
    }

    isDetecting = true;
    const btnStart = document.getElementById("btn-start");
    const btnStop = document.getElementById("btn-stop");
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = false;

    updateStatus("detecting", "📡 Ride Active — Scanning & Navigating");

    const gpsStarted = startGPSTracking();
    if (!gpsStarted) {
        isDetecting = false;
        if (btnStart) btnStart.disabled = false;
        if (btnStop) btnStop.disabled = true;
        return;
    }

    startAccelerometer();
    showToast("▶ Ride started! GPS & motion sensor tracking active.", "success");
}

function stopDetection() {
    isDetecting = false;
    stopGPSTracking();
    stopAccelerometer();

    if (NAV.isNavigating) {
        stopNavigation();
    }

    updateStatus("idle", "⏹ Ride Stopped");
    updateGPSStatus("idle", "Inactive");

    const btnStart = document.getElementById("btn-start");
    const btnStop = document.getElementById("btn-stop");
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;

    showToast("⏹ Ride stopped. Sensors deactivated.", "info");
}

// Expose Start/Stop globally
window.startDetection = startDetection;
window.stopDetection = stopDetection;

// ═══════════════════════════════════════════════════════════════════
// OFFLINE QUEUE & SYNC
// ═══════════════════════════════════════════════════════════════════

async function saveOfflinePathole(lat, lng, accelPeak, accuracy) {
    if (!dbPromise) return;
    try {
        const db = await dbPromise;
        const tx = db.transaction("patholes", "readwrite");
        const store = tx.objectStore("patholes");
        await store.put({
            id: Date.now(),
            latitude: lat,
            longitude: lng,
            accel_peak: accelPeak,
            accuracy: accuracy,
            timestamp: new Date().toISOString()
        });
        updateOfflineUI();
    } catch (e) {
        console.error("Offline save error:", e);
    }
}

async function syncOfflineQueue() {
    if (!dbPromise || !navigator.onLine) return;
    try {
        const db = await dbPromise;
        const tx = db.transaction("patholes", "readwrite");
        const store = tx.objectStore("patholes");
        const allRecords = await new Promise(resolve => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
        });

        if (!allRecords || allRecords.length === 0) return;

        for (const item of allRecords) {
            try {
                const res = await fetch("/api/patholes", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(item)
                });
                if (res.ok) {
                    const deleteTx = db.transaction("patholes", "readwrite");
                    deleteTx.objectStore("patholes").delete(item.id);
                }
            } catch (err) {
                console.warn("Failed to sync record:", item.id);
            }
        }
        updateOfflineUI();
    } catch (e) {
        console.error("Sync error:", e);
    }
}

async function updateOfflineUI() {
    const banner = document.getElementById("offline-banner");
    if (!banner) return;
    if (!navigator.onLine) {
        let count = 0;
        if (dbPromise) {
            try {
                const db = await dbPromise;
                const tx = db.transaction("patholes", "readonly");
                count = await new Promise(res => {
                    const req = tx.objectStore("patholes").count();
                    req.onsuccess = () => res(req.result);
                    req.onerror = () => res(0);
                });
            } catch (e) {}
        }
        banner.style.display = "flex";
        banner.textContent = `⚠️ Running Offline — ${count} pothole report(s) queued locally.`;
    } else {
        banner.style.display = "none";
    }
}

window.addEventListener("online", () => { updateOfflineUI(); syncOfflineQueue(); });
window.addEventListener("offline", () => updateOfflineUI());

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

async function loadExistingPatholes() {
    try {
        const response = await fetch("/api/patholes");
        if (!response.ok) return;
        const data = await response.json();
        if (data.patholes) {
            allPatholesData = data.patholes;
            window.allPatholesData = allPatholesData;
            // Keep map clean: clear pathole layer so no permanent markers are visible
            patholeLayer.clearLayers();
        }
    } catch (e) {
        console.error("Failed to load existing potholes:", e);
    }
}

function initAccelChart() {
    const canvas = document.getElementById("accel-chart");
    if (!canvas || typeof Chart === "undefined") return;
    const ctx = canvas.getContext("2d");
    accelChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: Array(40).fill(""),
            datasets: [{
                label: "Acceleration (m/s²)",
                data: Array(40).fill(0),
                borderColor: "#059669",
                borderWidth: 2,
                fill: true,
                backgroundColor: "rgba(5, 150, 105, 0.05)",
                tension: 0.3,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { display: false },
                y: { min: 0, max: 40, grid: { color: "rgba(0,0,0,0.05)" }, ticks: { color: "var(--text-secondary)", font: { size: 9 } } }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function initializeGPS() {
    if (!checkGPSAvailability()) return;
    updateGPSStatus("warning", "📍 Requesting GPS permission...");
    navigator.geolocation.getCurrentPosition(
        (pos) => onPositionUpdate(pos),
        (err) => onPositionError(err),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
}

document.addEventListener("DOMContentLoaded", () => {
    console.log("🚀 PathPulse Unified Ride Engine initialized.");
    initAccelChart();
    setupSearch();
    loadExistingPatholes();
    setTimeout(updateOfflineUI, 1000);
    initializeGPS();
});