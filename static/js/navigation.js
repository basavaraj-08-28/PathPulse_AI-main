/**
 * PathPulse AI — Navigation Module (navigation.js)
 * ══════════════════════════════════════════════════
 * Implements Phases 1–8 of the navigation upgrade.
 * Depends on map.js being loaded first (uses window.ppMap,
 * window.routingControl, window.allPotholesData, window.getDirections).
 *
 * GPS hook: map.js calls window.onNavGPSUpdate(lat, lng, pos) on every fix.
 */

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 1 — Live Navigation State
   ═══════════════════════════════════════════════════════════════════════ */

const NAV = {
  isNavigating:       false,    // Is navigation mode active?
  destLat:            null,     // Current destination latitude
  destLon:            null,     // Current destination longitude
  destName:           '',       // Display name of destination
  currentRoute:       null,     // Array of L.LatLng route coordinates
  routeSteps:         [],       // Turn-by-turn instruction steps
  currentStepIndex:   0,        // Which step we've reached
  spokenInstructions: new Set(),// Step indices already spoken
  spokenPotholes:     new Set(),// Pothole IDs already warned about
  lastLat:            null,
  lastLon:            null,
  lastTimestamp:      null,
  currentSpeed:       0,        // km/h
  recalcCooldown:     false,    // Prevents rapid recalculation loops
  autoStart:          false,    // Auto-start nav after destination select
};

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 2 — Navigation Marker (Google Maps–style blue dot/arrow)
   ═══════════════════════════════════════════════════════════════════════ */

let navMarker = null;

/** Creates or updates the blue navigation marker at [lat, lng] */
function updateNavMarker(lat, lng, heading) {
  const icon = L.divIcon({
    className: 'nav-marker',
    html: `<div class="nav-dot" style="transform:rotate(${heading || 0}deg)">
             <div class="nav-dot-inner"></div>
             <div class="nav-dot-halo"></div>
           </div>`,
    iconSize:   [32, 32],
    iconAnchor: [16, 16],
  });

  if (!navMarker) {
    navMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 })
                  .addTo(window.ppMap)
                  .bindTooltip('You', { permanent: false, direction: 'top' });
  } else {
    // Smooth animated movement
    navMarker.setLatLng([lat, lng]);
    navMarker.setIcon(icon);
  }
}

/** Remove the nav marker when navigation is stopped */
function removeNavMarker() {
  if (navMarker) {
    window.ppMap.removeLayer(navMarker);
    navMarker = null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 1 — Start / Stop Navigation
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Begin live navigation mode toward (destLat, destLon).
 * Called from the "Start Navigation" button in route-info.
 */
window.startNavigation = function(destLat, destLon, destName) {
  if (!destLat || !destLon) {
    // Try to read from stored destination if not passed
    destLat = NAV.destLat;
    destLon = NAV.destLon;
    destName = NAV.destName;
  }
  if (!destLat || !destLon) {
    showToast('Please select a destination first.', 'warning');
    return;
  }

  NAV.isNavigating   = true;
  NAV.destLat        = destLat;
  NAV.destLon        = destLon;
  NAV.destName       = destName || 'Destination';
  NAV.currentStepIndex   = 0;
  NAV.spokenInstructions = new Set();
  NAV.spokenPotholes     = new Set();
  NAV.recalcCooldown     = false;

  // Extract route data from existing routingControl
  _extractRouteData();

  // Show dashboard, show stop button, hide start button
  document.getElementById('nav-dashboard').style.display = 'flex';
  document.getElementById('btn-start-nav').style.display = 'none';
  document.getElementById('btn-stop-nav').style.display  = 'inline-flex';
  document.getElementById('nav-status-text').textContent  = 'Navigating';
  document.getElementById('nav-status-badge').className   = 'nav-status-badge navigating';

  // Zoom in to navigation level
  if (NAV.lastLat) {
    window.ppMap.setView([NAV.lastLat, NAV.lastLon], 17, { animate: true });
  }

  // Speak start
  speakNav('Navigation started. Follow the route.');

  showToast('🚗 Navigation started!', 'success');
};

/**
 * Stop live navigation mode.
 * Preserves the current route visually until cleared.
 */
window.stopNavigation = function() {
  NAV.isNavigating = false;

  removeNavMarker();

  document.getElementById('nav-dashboard').style.display = 'none';
  document.getElementById('btn-start-nav').style.display = 'inline-flex';
  document.getElementById('btn-stop-nav').style.display  = 'none';
  hidePotholeWarning();

  speakNav('Navigation stopped.');
  showToast('Navigation stopped.', 'info');
};

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 1 — GPS Update Hook (called by map.js)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Receives every GPS update from map.js's watchPosition.
 * @param {number} lat
 * @param {number} lng
 * @param {GeolocationPosition|null} pos  — full position object (may be null for simulated)
 */
window.onNavGPSUpdate = function(lat, lng, pos) {
  // Always track last known position
  const now = Date.now();

  // Compute speed from coords delta if no native speed
  if (pos && pos.coords.speed !== null && pos.coords.speed >= 0) {
    NAV.currentSpeed = (pos.coords.speed * 3.6).toFixed(1); // m/s → km/h
  } else if (NAV.lastLat !== null) {
    const dt = (now - NAV.lastTimestamp) / 1000; // seconds
    if (dt > 0) {
      const dist = haversineMeters(NAV.lastLat, NAV.lastLon, lat, lng);
      NAV.currentSpeed = ((dist / dt) * 3.6).toFixed(1);
    }
  }

  NAV.lastLat       = lat;
  NAV.lastLon       = lng;
  NAV.lastTimestamp = now;

  const accuracy = (pos && pos.coords.accuracy) ? pos.coords.accuracy.toFixed(0) : '—';

  if (!NAV.isNavigating) return;

  // ── Phase 1: Smooth map centering & zoom ──────────────────────────
  const heading = (pos && pos.coords.heading) ? pos.coords.heading : 0;
  updateNavMarker(lat, lng, heading);
  window.ppMap.setView([lat, lng], clamp(window.ppMap.getZoom(), 16, 18), { animate: true });

  // ── Phase 2: Dashboard update ─────────────────────────────────────
  updateDashboard(lat, lng, accuracy);

  // ── Phase 3: Route deviation check ───────────────────────────────
  checkRouteDeviation(lat, lng);

  // ── Phase 5: Pothole proximity check ─────────────────────────────
  checkPotholeProximityNav(lat, lng);

  // ── Phase 4: Turn-by-turn voice ───────────────────────────────────
  checkNextTurnInstruction(lat, lng);
};

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 2 — Navigation Dashboard
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Extract route coordinates and steps from Leaflet Routing Machine.
 */
function _extractRouteData() {
  if (!window.routingControl) return;
  const routes = window.routingControl.getRouter
    ? null  // LRM API check
    : null;

  // LRM stores routes internally after routesfound event
  const waypointLayer = window.routingControl._routes;
  if (waypointLayer && waypointLayer.length > 0) {
    NAV.currentRoute = waypointLayer[0].coordinates;
    NAV.routeSteps   = waypointLayer[0].instructions || [];
  }
}

/**
 * Update all dashboard stat elements.
 */
function updateDashboard(lat, lng, accuracy) {
  // Remaining distance
  let remainDist = '—';
  let etaStr     = '—';
  let nextTurn   = '—';

  if (NAV.currentRoute && NAV.currentRoute.length > 0) {
    // Find closest point on route, sum remaining distance from there
    const { idx } = closestPointOnRoute(lat, lng);
    const remaining = routeLengthFrom(idx);  // metres
    remainDist = remaining >= 1000
      ? (remaining / 1000).toFixed(1) + ' km'
      : Math.round(remaining) + ' m';

    // ETA based on current speed (fallback 40 km/h if stationary)
    const speedKmh = parseFloat(NAV.currentSpeed) || 40;
    const etaMins  = Math.round((remaining / 1000) / speedKmh * 60);
    if (etaMins < 60) {
      etaStr = etaMins + ' min';
    } else {
      etaStr = Math.floor(etaMins / 60) + 'h ' + (etaMins % 60) + 'm';
    }
  }

  // Next turn instruction
  if (NAV.routeSteps.length > 0 && NAV.currentStepIndex < NAV.routeSteps.length) {
    const step = NAV.routeSteps[NAV.currentStepIndex];
    nextTurn = formatInstruction(step);
  } else if (NAV.currentRoute) {
    nextTurn = '🏁 Destination ahead';
  }

  _setDash('dash-distance',  remainDist);
  _setDash('dash-eta',       etaStr);
  _setDash('dash-speed',     NAV.currentSpeed + ' km/h');
  _setDash('dash-accuracy',  accuracy ? accuracy + ' m' : '—');
  _setDash('dash-next-turn', nextTurn);
}

function _setDash(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 3 — Route Deviation & Recalculation
   ═══════════════════════════════════════════════════════════════════════ */

const OFF_ROUTE_THRESHOLD_M = 50; // metres off-route before recalculating

function checkRouteDeviation(lat, lng) {
  if (!NAV.currentRoute || NAV.currentRoute.length === 0) return;
  if (NAV.recalcCooldown) return;

  const { dist } = closestPointOnRoute(lat, lng);
  if (dist > OFF_ROUTE_THRESHOLD_M) {
    console.log(`[Nav] Off-route by ${dist.toFixed(0)}m — recalculating…`);
    NAV.recalcCooldown = true;

    speakNav('Recalculating route.');
    showToast('↩️ Off route — recalculating…', 'warning');

    // Re-use existing getDirections which rebuilds LRM control
    window.getDirections(NAV.destLat, NAV.destLon);

    // After LRM fires routesfound, re-extract route data
    const checkInterval = setInterval(() => {
      const routes = window.routingControl && window.routingControl._routes;
      if (routes && routes.length > 0) {
        NAV.currentRoute     = routes[0].coordinates;
        NAV.routeSteps       = routes[0].instructions || [];
        NAV.currentStepIndex = 0;
        NAV.spokenInstructions.clear();
        clearInterval(checkInterval);
        // Allow recalc again after 15 seconds
        setTimeout(() => { NAV.recalcCooldown = false; }, 15000);
      }
    }, 500);

    // Safety: clear cooldown after 20s regardless
    setTimeout(() => { NAV.recalcCooldown = false; }, 20000);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 4 — Voice Navigation (Speech Synthesis API)
   ═══════════════════════════════════════════════════════════════════════ */

// Queue management to avoid rapid-fire speech
let _speechQueue = [];
let _isSpeaking  = false;

/** Speaks a navigation instruction — deduplicates and queues. */
function speakNav(text) {
  if (typeof window.speechSynthesis === 'undefined') return;
  // Don't add duplicate if same text is already queued
  if (_speechQueue.includes(text)) return;
  _speechQueue.push(text);
  _drainSpeechQueue();
}

function _drainSpeechQueue() {
  if (_isSpeaking || _speechQueue.length === 0) return;
  _isSpeaking = true;
  const text = _speechQueue.shift();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate   = 1.05;
  utter.volume = 1.0;
  utter.pitch  = 1.0;
  utter.onend  = () => { _isSpeaking = false; _drainSpeechQueue(); };
  utter.onerror = () => { _isSpeaking = false; _drainSpeechQueue(); };
  window.speechSynthesis.speak(utter);
}

/**
 * Check if user has passed through a turn step and announce next instruction.
 */
function checkNextTurnInstruction(lat, lng) {
  if (NAV.routeSteps.length === 0) return;

  const step = NAV.routeSteps[NAV.currentStepIndex];
  if (!step) return;

  // Each step has a waypoint index in the route coordinate array
  const stepCoord = step.waypoint ||
    (NAV.currentRoute && NAV.currentRoute[step.index]) ||
    null;

  if (!stepCoord) return;

  const distToStep = haversineMeters(lat, lng, stepCoord.lat, stepCoord.lng);

  // Announce when within 80m of the turn
  if (distToStep < 80 && !NAV.spokenInstructions.has(NAV.currentStepIndex)) {
    NAV.spokenInstructions.add(NAV.currentStepIndex);
    const instruction = buildVoiceInstruction(step);
    speakNav(instruction);
    _setDash('dash-next-turn', formatInstruction(step));
  }

  // Advance to next step when within 20m
  if (distToStep < 20 && NAV.currentStepIndex < NAV.routeSteps.length - 1) {
    NAV.currentStepIndex++;
  }

  // Destination reached check
  const destDist = haversineMeters(lat, lng, NAV.destLat, NAV.destLon);
  if (destDist < 30 && !NAV.spokenInstructions.has('destination')) {
    NAV.spokenInstructions.add('destination');
    speakNav('You have arrived at your destination.');
    showToast('🏁 You have arrived!', 'success');
    _setDash('dash-next-turn', '🏁 Arrived!');
    document.getElementById('nav-status-badge').className = 'nav-status-badge arrived';
    document.getElementById('nav-status-text').textContent = 'Arrived';
  }
}

/** Converts LRM instruction type to natural voice string. */
function buildVoiceInstruction(step) {
  const type = step.type || '';
  const road = step.road ? ` onto ${step.road}` : '';
  const dist = step.distance ? ` in ${Math.round(step.distance)} metres` : '';

  const map = {
    'Head':               `Continue straight${road}${dist}`,
    'TurnLeft':           `Turn left${road}${dist}`,
    'TurnRight':          `Turn right${road}${dist}`,
    'TurnSlightLeft':     `Keep left${road}${dist}`,
    'TurnSlightRight':    `Keep right${road}${dist}`,
    'TurnSharpLeft':      `Sharp left turn${road}${dist}`,
    'TurnSharpRight':     `Sharp right turn${road}${dist}`,
    'Roundabout':         `Enter the roundabout${dist}`,
    'WaypointReached':    `Waypoint reached`,
    'DestinationReached': `You have arrived at your destination`,
  };
  return map[type] || step.text || 'Continue straight';
}

/** Short display string for the dashboard next-turn field. */
function formatInstruction(step) {
  const type = step.type || '';
  const icons = {
    'TurnLeft':       '⬅️ Turn Left',
    'TurnRight':      '➡️ Turn Right',
    'TurnSlightLeft': '↖️ Keep Left',
    'TurnSlightRight':'↗️ Keep Right',
    'TurnSharpLeft':  '⬅️ Sharp Left',
    'TurnSharpRight': '➡️ Sharp Right',
    'Head':           '⬆️ Continue Straight',
    'Roundabout':     '🔄 Roundabout',
    'DestinationReached': '🏁 Destination',
  };
  const dist = step.distance ? ` — ${Math.round(step.distance)}m` : '';
  return (icons[type] || '⬆️ ' + (step.text || 'Continue')) + dist;
}

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 5 — Pothole-Aware Navigation Warnings
   ═══════════════════════════════════════════════════════════════════════ */

const POTHOLE_WARN_DISTANCE_M = 40; // metres

function checkPotholeProximityNav(lat, lng) {
  const potholes = window.allPotholesData || [];
  if (potholes.length === 0) return;

  // Find the closest pothole within warning distance
  let closest     = null;
  let closestDist = Infinity;

  potholes.forEach(p => {
    if (!p.is_active) return;
    const d = haversineMeters(lat, lng, p.latitude, p.longitude);
    if (d <= POTHOLE_WARN_DISTANCE_M && d < closestDist) {
      closest     = p;
      closestDist = d;
    }
  });

  if (closest) {
    // Show floating warning card
    showPotholeWarning(closest, Math.round(closestDist));

    // Speak once per pothole per approach
    if (!NAV.spokenPotholes.has(closest.id)) {
      NAV.spokenPotholes.add(closest.id);
      speakNav(`Warning. ${closest.severity} severity pothole ahead in ${Math.round(closestDist)} metres.`);
    }
  } else {
    hidePotholeWarning();
    // Clear potholes that are now far away so we can warn again on next approach
    potholes.forEach(p => {
      const d = haversineMeters(lat, lng, p.latitude, p.longitude);
      if (d > 80) NAV.spokenPotholes.delete(p.id);
    });
  }
}

function showPotholeWarning(pothole, distMetres) {
  const card = document.getElementById('pothole-warning-card');
  if (!card) return;

  const sev = pothole.severity.toUpperCase();
  const emoji = pothole.severity === 'high' ? '🔴' : pothole.severity === 'medium' ? '🟡' : '🟢';
  card.innerHTML = `
    <div class="pw-icon">⚠️</div>
    <div class="pw-content">
      <div class="pw-title">${emoji} ${sev} Pothole Ahead</div>
      <div class="pw-dist">${distMetres} metres</div>
    </div>
  `;
  card.style.display = 'flex';
  card.classList.add('pw-visible');
}

function hidePotholeWarning() {
  const card = document.getElementById('pothole-warning-card');
  if (!card) return;
  card.classList.remove('pw-visible');
  // Delay hiding so the CSS animation plays out
  setTimeout(() => {
    if (!card.classList.contains('pw-visible')) {
      card.style.display = 'none';
    }
  }, 300);
}

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 7 — Enhanced Search: Recent Destinations & Favorites
   ═══════════════════════════════════════════════════════════════════════ */

const LS_RECENT = 'pp_recent_destinations';
const LS_FAVS   = 'pp_fav_destinations';
const LS_AUTO   = 'pp_auto_nav';

/** Returns array of recent destinations from localStorage. */
function getRecent() {
  try { return JSON.parse(localStorage.getItem(LS_RECENT)) || []; }
  catch { return []; }
}

function getFavs() {
  try { return JSON.parse(localStorage.getItem(LS_FAVS)) || []; }
  catch { return []; }
}

/** Save a destination to the recent list (max 5). */
function saveRecent(dest) {
  let list = getRecent().filter(d => !(d.lat === dest.lat && d.lon === dest.lon));
  list.unshift(dest);
  list = list.slice(0, 5);
  localStorage.setItem(LS_RECENT, JSON.stringify(list));
  renderRecentPanel();
}

function toggleFav(dest) {
  let favs = getFavs();
  const idx = favs.findIndex(d => d.lat === dest.lat && d.lon === dest.lon);
  if (idx >= 0) {
    favs.splice(idx, 1);
  } else {
    favs.unshift(dest);
    favs = favs.slice(0, 10);
  }
  localStorage.setItem(LS_FAVS, JSON.stringify(favs));
  renderRecentPanel();
  renderFavPanel();
}

function isFav(lat, lon) {
  return getFavs().some(d => d.lat === lat && d.lon === lon);
}

function renderRecentPanel() {
  const list = getRecent();
  const panel = document.getElementById('recent-dest-list');
  if (!panel) return;
  if (list.length === 0) {
    panel.innerHTML = '<div class="dest-item-empty">No recent destinations yet</div>';
    return;
  }
  panel.innerHTML = list.map(d => `
    <div class="dest-item" onclick="selectAndNavigate(${d.lat}, ${d.lon}, '${escapeHtml(d.name)}')">
      <span class="dest-icon">🕐</span>
      <span class="dest-name">${escapeHtml(d.name)}</span>
      <button class="dest-fav-btn ${isFav(d.lat, d.lon) ? 'fav-active' : ''}"
              onclick="event.stopPropagation(); toggleFavAndRender(${d.lat}, ${d.lon}, '${escapeHtml(d.name)}')"
              title="Toggle Favourite">★</button>
    </div>
  `).join('');
}

function renderFavPanel() {
  const list = getFavs();
  const panel = document.getElementById('fav-dest-list');
  if (!panel) return;
  if (list.length === 0) {
    panel.innerHTML = '<div class="dest-item-empty">No saved favourites yet</div>';
    return;
  }
  panel.innerHTML = list.map(d => `
    <div class="dest-item" onclick="selectAndNavigate(${d.lat}, ${d.lon}, '${escapeHtml(d.name)}')">
      <span class="dest-icon">⭐</span>
      <span class="dest-name">${escapeHtml(d.name)}</span>
      <button class="dest-fav-btn fav-active"
              onclick="event.stopPropagation(); toggleFavAndRender(${d.lat}, d.lon, '${escapeHtml(d.name)}')"
              title="Remove Favourite">★</button>
    </div>
  `).join('');
}

window.toggleFavAndRender = function(lat, lon, name) {
  toggleFav({ lat, lon, name });
};

window.toggleRecentPanel = function() {
  const panel = document.getElementById('recent-dest-panel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') renderRecentPanel();
};

window.toggleFavPanel = function() {
  const panel = document.getElementById('fav-dest-panel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') renderFavPanel();
};

/**
 * Select a destination from recent/fav list:
 * calls existing selectDestination(), saves to recent,
 * and optionally auto-starts navigation.
 */
window.selectAndNavigate = function(lat, lon, name) {
  // Close panels
  const rp = document.getElementById('recent-dest-panel');
  const fp = document.getElementById('fav-dest-panel');
  if (rp) rp.style.display = 'none';
  if (fp) fp.style.display = 'none';

  // Update search box
  const searchInput = document.getElementById('map-search');
  if (searchInput) searchInput.value = name;

  // Save to recent
  saveRecent({ lat, lon, name });

  // Store in NAV state
  NAV.destLat  = lat;
  NAV.destLon  = lon;
  NAV.destName = name;

  // Call existing map.js function
  window.selectDestination(lat, lon, name);
};

/**
 * Hook into the existing selectDestination function.
 * Wraps it so we can save to recent and handle auto-nav.
 */
(function patchSelectDestination() {
  const _original = window.selectDestination;
  window.selectDestination = function(lat, lon, displayName) {
    // Store destination in NAV state
    NAV.destLat  = lat;
    NAV.destLon  = lon;
    NAV.destName = displayName || 'Destination';

    // Save to recent destinations
    saveRecent({ lat, lon, name: displayName || 'Destination' });

    // Call original
    _original(lat, lon, displayName);

    // Auto-start navigation if enabled
    const autoToggle = document.getElementById('auto-nav-toggle');
    if (autoToggle && autoToggle.checked) {
      // Wait for directions to be fetched first
      setTimeout(() => {
        window.getDirections(lat, lon);
        // Wait a moment for LRM to compute route, then start nav
        setTimeout(() => {
          window.startNavigation(lat, lon, displayName);
        }, 2500);
      }, 300);
    }
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 6 — UX Helpers: Toast Notifications
   ═══════════════════════════════════════════════════════════════════════ */

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `nav-toast nav-toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  // Remove after 3s
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

/* ═══════════════════════════════════════════════════════════════════════
   ROUTING CONTROL HOOK — Extract route data after LRM routesfound
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Patch window.getDirections to capture route data for navigation use.
 * We wait for the routesfound event each time a new route is computed.
 */
(function patchGetDirections() {
  const _origGet = window.getDirections;
  window.getDirections = function(destLat, destLon) {
    NAV.destLat = destLat;
    NAV.destLon = destLon;

    _origGet(destLat, destLon);

    // After a tick, listen to routesfound on the new control
    setTimeout(() => {
      if (!window.routingControl) return;
      window.routingControl.on('routesfound', function(e) {
        const route = e.routes[0];
        NAV.currentRoute   = route.coordinates;
        NAV.routeSteps     = route.instructions || [];
        NAV.currentStepIndex = 0;
        NAV.spokenInstructions.clear();

        // Show Start Navigation button
        const startBtn = document.getElementById('btn-start-nav');
        if (startBtn) startBtn.style.display = 'inline-flex';

        console.log(`[Nav] Route loaded: ${route.coordinates.length} points, ${route.instructions?.length || 0} steps.`);
      });
    }, 200);
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════════════════════════ */

/** Haversine distance in metres between two lat/lng pairs. */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dPhi = (lat2 - lat1) * Math.PI / 180;
  const dLam = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dPhi / 2) ** 2 +
               Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Find closest point index on current route and distance to it (metres). */
function closestPointOnRoute(lat, lng) {
  if (!NAV.currentRoute || NAV.currentRoute.length === 0) return { idx: 0, dist: Infinity };
  let minDist = Infinity;
  let minIdx  = 0;
  NAV.currentRoute.forEach((pt, i) => {
    const d = haversineMeters(lat, lng, pt.lat, pt.lng);
    if (d < minDist) { minDist = d; minIdx = i; }
  });
  return { idx: minIdx, dist: minDist };
}

/** Sum of route segment lengths from index idx to end (metres). */
function routeLengthFrom(idx) {
  let total = 0;
  for (let i = idx; i < NAV.currentRoute.length - 1; i++) {
    total += haversineMeters(
      NAV.currentRoute[i].lat,  NAV.currentRoute[i].lng,
      NAV.currentRoute[i+1].lat, NAV.currentRoute[i+1].lng
    );
  }
  return total;
}

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ═══════════════════════════════════════════════════════════════════════
   INITIALISATION — runs once DOM is ready
   ═══════════════════════════════════════════════════════════════════════ */

(function initNavModule() {
  // Restore auto-nav preference
  const autoToggle = document.getElementById('auto-nav-toggle');
  if (autoToggle) {
    autoToggle.checked = localStorage.getItem(LS_AUTO) === 'true';
    autoToggle.addEventListener('change', () => {
      localStorage.setItem(LS_AUTO, autoToggle.checked);
    });
  }

  // Render panels on load
  renderRecentPanel();
  renderFavPanel();

  console.log('[PathPulse Navigation] Module loaded ✓');
})();
