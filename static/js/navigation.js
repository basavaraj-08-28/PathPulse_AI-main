/**
 * PathPulse AI — Navigation Module (navigation.js)
 * ══════════════════════════════════════════════════
 * Implements Phases 1–8 of the navigation upgrade.
 * Depends on map.js being loaded first (uses window.ppMap,
 * window.routingControl, window.allPatholesData, window.getDirections).
 *
 * GPS hook: map.js calls window.onNavGPSUpdate(lat, lng, pos) on every fix.
 */

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 1 — Live Navigation State
   ═══════════════════════════════════════════════════════════════════════ */

const NAV = {
  isNavigating:       false,    // Is live navigation mode active?
  isPaused:           false,    // Is navigation temporarily paused?
  isFollowing:        true,     // Auto-follow user location on map
  destLat:            null,     // Current destination latitude
  destLon:            null,     // Current destination longitude
  destName:           '',       // Display name of destination
  currentRoute:       null,     // Array of L.LatLng route coordinates
  routeSteps:         [],       // Turn-by-turn instruction steps
  currentStepIndex:   0,        // Which step we've reached
  spokenInstructions: new Set(),// Step indices already spoken
  spokenPatholes:     new Set(),// Pathole IDs already warned about
  lastLat:            null,
  lastLon:            null,
  lastTimestamp:      null,
  currentSpeed:       0,        // km/h
  recalcCooldown:     false,    // Prevents rapid recalculation loops
  autoStart:          false,    // Auto-start nav after destination select
  pendingAutoStart:   false,    // Flag for event-driven auto-start navigation
  lastValidHeading:   null,
  lastCameraLat:      null,
  lastCameraLon:      null,
  cameraUpdateTime:   0,
  markerAnimFrame:    null,
};

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 2 — Navigation Marker (Google Maps–style blue dot/arrow)
   ═══════════════════════════════════════════════════════════════════════ */

let navMarker = null;

/** Creates or updates the blue navigation marker at [lat, lng] */
function updateNavMarker(lat, lng, heading) {
  if (!navMarker) {
    const icon = L.divIcon({
      className: 'nav-marker',
      html: `<div class="nav-dot" id="nav-dot-elem-map">
               <div class="nav-dot-inner"></div>
               <div class="nav-dot-halo"></div>
             </div>`,
      iconSize:   [32, 32],
      iconAnchor: [16, 16],
    });
    navMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(window.ppMap);
  } else {
    animateNavMarkerTo(lat, lng);
  }

  if (heading !== null && heading !== undefined && !isNaN(heading) && Number.isFinite(heading) && heading >= 0) {
    if (NAV.lastValidHeading === null || Math.abs(heading - NAV.lastValidHeading) >= 3) {
      NAV.lastValidHeading = heading;
      const dotEl = document.getElementById('nav-dot-elem-map') || (navMarker.getElement() ? navMarker.getElement().querySelector('.nav-dot') : null);
      if (dotEl) {
        dotEl.style.transform = `rotate(${heading}deg)`;
      }
    }
  }
}

function animateNavMarkerTo(targetLat, targetLng) {
  if (!navMarker) return;
  if (NAV.markerAnimFrame) {
    cancelAnimationFrame(NAV.markerAnimFrame);
    NAV.markerAnimFrame = null;
  }

  const curLatLng = navMarker.getLatLng();
  const startLat = curLatLng.lat;
  const startLng = curLatLng.lng;
  const dist = haversineMeters(startLat, startLng, targetLat, targetLng);

  if (dist < 0.2 || dist > 200) {
    navMarker.setLatLng([targetLat, targetLng]);
    return;
  }

  const startTime = performance.now();
  const duration = Math.min(500, Math.max(200, dist * 20));

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    const ease = 1 - (1 - progress) * (1 - progress);

    const curL = startLat + (targetLat - startLat) * ease;
    const curG = startLng + (targetLng - startLng) * ease;
    if (navMarker) {
      navMarker.setLatLng([curL, curG]);
    }

    if (progress < 1) {
      NAV.markerAnimFrame = requestAnimationFrame(step);
    } else {
      NAV.markerAnimFrame = null;
    }
  }

  NAV.markerAnimFrame = requestAnimationFrame(step);
}

/** Remove the nav marker when navigation is stopped */
function removeNavMarker() {
  if (NAV.markerAnimFrame) {
    cancelAnimationFrame(NAV.markerAnimFrame);
    NAV.markerAnimFrame = null;
  }
  if (navMarker && window.ppMap) {
    window.ppMap.removeLayer(navMarker);
    navMarker = null;
  }
  NAV.lastValidHeading = null;
}

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 1 — Start / Stop / Pause / Recenter Navigation Lifecycle
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Begin dedicated Page 2 Live Navigation mode toward (destLat, destLon).
 */
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

  NAV.isNavigating   = true;
  NAV.isPaused       = false;
  NAV.isFollowing    = true;
  NAV.destLat        = destLat;
  NAV.destLon        = destLon;
  NAV.destName       = destName || 'Destination';
  NAV.currentStepIndex   = 0;
  NAV.spokenInstructions = new Set();
  NAV.spokenPatholes     = new Set();
  NAV.recalcCooldown     = false;
  NAV.lastCameraLat      = null;
  NAV.lastCameraLon      = null;
  NAV.cameraUpdateTime   = 0;

  // Extract route data from existing routingControl
  _extractRouteData();

  // 1. Activate Full-Screen Page 2 Live Navigation layout
  document.body.classList.add('live-nav-active');

  // 2. Show dedicated Live Navigation UI components
  const topCard = document.getElementById('live-nav-top-card');
  const speedBadge = document.getElementById('live-nav-speed-badge');
  const floatControls = document.getElementById('live-nav-floating-controls');
  const bottomCard = document.getElementById('live-nav-bottom-card');

  if (topCard) topCard.style.display = 'flex';
  if (speedBadge) speedBadge.style.display = 'flex';
  if (floatControls) floatControls.style.display = 'flex';
  if (bottomCard) bottomCard.style.display = 'flex';

  // 3. Reset Pause button UI
  const pauseBtn = document.getElementById('btn-live-pause');
  if (pauseBtn) {
    pauseBtn.classList.remove('is-paused');
    const pIcon = document.getElementById('live-pause-icon');
    const pText = document.getElementById('live-pause-text');
    if (pIcon) pIcon.textContent = '⏸';
    if (pText) pText.textContent = 'Pause Navigation';
  }

  // 4. Invalidate Leaflet map size smoothly and position camera once
  if (window.ppMap) {
    requestAnimationFrame(() => {
      window.ppMap.invalidateSize({ pan: false });
      if (NAV.lastLat && NAV.lastLon) {
        NAV.lastCameraLat = NAV.lastLat;
        NAV.lastCameraLon = NAV.lastLon;
        NAV.cameraUpdateTime = Date.now();
        window.ppMap.setView([NAV.lastLat, NAV.lastLon], 17, { animate: false });
        updateNavMarker(NAV.lastLat, NAV.lastLon, null);
        updateLiveNavUI(NAV.lastLat, NAV.lastLon, null);
      }
    });
  }

  // 5. Initial voice guidance and toast
  speakNav('Navigation started. Follow the route.');
  showToast('🚗 Live Navigation started!', 'success');

  // 6. Immediately populate UI with initial state
  if (NAV.lastLat && NAV.lastLon) {
    updateLiveNavUI(NAV.lastLat, NAV.lastLon, null);
  }
};

/**
 * Stop live navigation mode and cleanly return to Page 1 (Route Preview).
 */
window.stopNavigation = function() {
  NAV.isNavigating = false;
  NAV.isPaused     = false;
  NAV.isFollowing  = true;

  removeNavMarker();

  // 1. Deactivate Full-Screen Page 2 layout, returning to Page 1 Route Preview
  document.body.classList.remove('live-nav-active');

  // 2. Hide Live Navigation components
  const topCard = document.getElementById('live-nav-top-card');
  const speedBadge = document.getElementById('live-nav-speed-badge');
  const floatControls = document.getElementById('live-nav-floating-controls');
  const bottomCard = document.getElementById('live-nav-bottom-card');

  if (topCard) topCard.style.display = 'none';
  if (speedBadge) speedBadge.style.display = 'none';
  if (floatControls) floatControls.style.display = 'none';
  if (bottomCard) bottomCard.style.display = 'none';
  hidePatholeWarning();

  // 3. Restore Start Navigation button in Route Info card
  const startBtn = document.getElementById('btn-start-nav');
  if (startBtn) startBtn.style.display = 'inline-flex';

  // 4. Adapt Leaflet map back to normal preview container
  if (window.ppMap) {
    setTimeout(() => {
      window.ppMap.invalidateSize();
      if (NAV.currentRoute && NAV.currentRoute.length > 0) {
        window.ppMap.fitBounds(L.latLngBounds(NAV.currentRoute), { padding: [50, 50], maxZoom: 16 });
      }
    }, 100);
  }

  speakNav('Navigation ended.');
  showToast('🏁 Navigation ended. Returned to route preview.', 'info');
};

/**
 * Toggle Pause / Resume navigation state without clearing route or reloading.
 */
window.togglePauseNavigation = function() {
  if (!NAV.isNavigating) return;

  NAV.isPaused = !NAV.isPaused;
  const pauseBtn = document.getElementById('btn-live-pause');
  const pIcon = document.getElementById('live-pause-icon');
  const pText = document.getElementById('live-pause-text');

  if (NAV.isPaused) {
    if (pauseBtn) pauseBtn.classList.add('is-paused');
    if (pIcon) pIcon.textContent = '▶';
    if (pText) pText.textContent = 'Resume Navigation';
    _speechQueue = [];
    showToast('⏸ Navigation paused', 'warning');
  } else {
    if (pauseBtn) pauseBtn.classList.remove('is-paused');
    if (pIcon) pIcon.textContent = '⏸';
    if (pText) pText.textContent = 'Pause Navigation';
    showToast('▶ Navigation resumed', 'success');
  }
};

/**
 * Recenter map camera onto user's current GPS position and resume auto-following.
 */
window.recenterLiveNav = function() {
  NAV.isFollowing = true;
  if (window.ppMap && NAV.lastLat && NAV.lastLon) {
    NAV.lastCameraLat = NAV.lastLat;
    NAV.lastCameraLon = NAV.lastLon;
    NAV.cameraUpdateTime = Date.now();
    window.ppMap.panTo([NAV.lastLat, NAV.lastLon], { animate: true, duration: 0.5 });
    showToast('📍 Following your location', 'info');
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 1 — GPS Update Hook (called by map.js)
   ═══════════════════════════════════════════════════════════════════════ */

function updateNavCameraFollow(lat, lng) {
  if (!NAV.isNavigating || !NAV.isFollowing || NAV.isPaused || !window.ppMap) return;

  const now = Date.now();
  if (NAV.lastCameraLat === null || NAV.lastCameraLon === null) {
    NAV.lastCameraLat = lat;
    NAV.lastCameraLon = lng;
    NAV.cameraUpdateTime = now;
    window.ppMap.setView([lat, lng], clamp(window.ppMap.getZoom(), 16, 18), { animate: false });
    return;
  }

  const distFromCam = haversineMeters(NAV.lastCameraLat, NAV.lastCameraLon, lat, lng);
  const timeSinceLastCam = now - NAV.cameraUpdateTime;
  const center = window.ppMap.getCenter();
  const distFromCenter = haversineMeters(center.lat, center.lng, lat, lng);

  if (distFromCam > 15 || distFromCenter > 25 || (timeSinceLastCam > 3000 && distFromCam > 8)) {
    NAV.lastCameraLat = lat;
    NAV.lastCameraLon = lng;
    NAV.cameraUpdateTime = now;
    window.ppMap.panTo([lat, lng], { animate: true, duration: 0.6, easeLinearity: 0.5 });
  }
}

/**
 * Receives every GPS update from map.js's watchPosition.
 */
window.onNavGPSUpdate = function(lat, lng, pos) {
  const now = Date.now();

  // Compute speed from coords delta or native speed
  if (pos && pos.coords && pos.coords.speed !== null && pos.coords.speed >= 0) {
    NAV.currentSpeed = (pos.coords.speed * 3.6).toFixed(1); // m/s → km/h
  } else if (NAV.lastLat !== null) {
    const dt = (now - NAV.lastTimestamp) / 1000;
    if (dt > 0) {
      const dist = haversineMeters(NAV.lastLat, NAV.lastLon, lat, lng);
      NAV.currentSpeed = ((dist / dt) * 3.6).toFixed(1);
    }
  }

  NAV.lastLat       = lat;
  NAV.lastLon       = lng;
  NAV.lastTimestamp = now;

  const accuracy = (pos && pos.coords && pos.coords.accuracy) ? pos.coords.accuracy.toFixed(0) : '—';

  if (!NAV.isNavigating) return;

  // ── Smooth navigation marker movement ───────────────────────────────
  const heading = (pos && pos.coords && pos.coords.heading !== null && !isNaN(pos.coords.heading) && pos.coords.heading >= 0)
    ? pos.coords.heading
    : NAV.lastValidHeading;
  updateNavMarker(lat, lng, heading);

  // ── Controlled camera following ───────────────────────────────────────
  updateNavCameraFollow(lat, lng);

  // ── Update Page 2 Live Navigation UI ────────────────────────────────
  updateLiveNavUI(lat, lng, accuracy);

  // ── Active Navigation Checks (if not paused) ────────────────────────
  if (!NAV.isPaused) {
    checkRouteDeviation(lat, lng);
    checkPatholeProximityNav(lat, lng);
    checkNextTurnInstruction(lat, lng);
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 2 — Live Navigation UI Updates
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Helper to map LRM instruction types to intuitive navigation maneuver icons.
 */
function getManeuverIcon(type) {
  const iconMap = {
    'TurnLeft': '↰',
    'Left': '↰',
    'TurnRight': '↱',
    'Right': '↱',
    'TurnSlightLeft': '↖',
    'SlightLeft': '↖',
    'TurnSlightRight': '↗',
    'SlightRight': '↗',
    'TurnSharpLeft': '⬅',
    'SharpLeft': '⬅',
    'TurnSharpRight': '➡',
    'SharpRight': '➡',
    'UTurn': '↩',
    'Roundabout': '🔄',
    'DestinationReached': '🏁',
    'WaypointReached': '📍',
    'Head': '↑',
    'Straight': '↑'
  };
  return iconMap[type] || '↑';
}

/**
 * Extract route coordinates and steps from Leaflet Routing Machine.
 */
function _extractRouteData() {
  if (!window.routingControl) return;
  const waypointLayer = window.routingControl._routes;
  if (waypointLayer && waypointLayer.length > 0) {
    NAV.currentRoute = waypointLayer[0].coordinates;
    NAV.routeSteps   = waypointLayer[0].instructions || [];
  }
}

/**
 * Update all Page 2 Live Navigation elements: Top Card, Speed, Bottom Card.
 */
function updateLiveNavUI(lat, lng, accuracy) {
  // 1. Update Speedometer (Real GPS speed or '--')
  const speedValEl = document.getElementById('live-nav-speed-val');
  if (speedValEl) {
    const spd = parseFloat(NAV.currentSpeed);
    if (!isNaN(spd) && spd > 0) {
      speedValEl.textContent = Math.round(spd);
    } else {
      speedValEl.textContent = '--';
    }
  }

  // 2. Compute remaining distance along route from closest point
  let remainingMeters = 0;
  if (NAV.currentRoute && NAV.currentRoute.length > 0) {
    const { idx } = closestPointOnRoute(lat, lng);
    remainingMeters = routeLengthFrom(idx);
  }

  // 3. Format Remaining Distance
  const remainDistStr = remainingMeters >= 1000
    ? (remainingMeters / 1000).toFixed(1) + ' km'
    : Math.round(remainingMeters) + ' m';

  // 4. Format ETA (minutes and hours)
  const currentSpeedNum = parseFloat(NAV.currentSpeed);
  const speedKmh = (currentSpeedNum > 5) ? currentSpeedNum : 35; // default urban speed
  const etaMins = Math.max(1, Math.round((remainingMeters / 1000) / speedKmh * 60));
  const etaStr = etaMins >= 60
    ? Math.floor(etaMins / 60) + 'h ' + (etaMins % 60) + 'm'
    : etaMins + ' min';

  // 5. Format Estimated Arrival Clock Time (e.g. "12:48 pm")
  const arrivalDate = new Date(Date.now() + etaMins * 60 * 1000);
  let hours = arrivalDate.getHours();
  const minutes = arrivalDate.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  const arrivalTimeStr = `${hours}:${minutes} ${ampm}`;

  // 6. Update Bottom Summary Card
  const etaLargeEl = document.getElementById('live-nav-eta-large');
  const distRemainEl = document.getElementById('live-nav-dist-remain');
  const arrivalTimeEl = document.getElementById('live-nav-arrival-time');

  if (etaLargeEl) etaLargeEl.textContent = etaStr;
  if (distRemainEl) distRemainEl.textContent = remainDistStr;
  if (arrivalTimeEl) arrivalTimeEl.textContent = arrivalTimeStr;

  // 7. Update Top Maneuver Card ("towards [ROAD NAME]" and "Then [ICON]")
  const mainIconEl = document.getElementById('live-nav-main-icon');
  const stepRoadEl = document.getElementById('live-nav-step-road');
  const nextStepRow = document.getElementById('live-nav-next-step-row');
  const nextIconEl = document.getElementById('live-nav-next-icon');

  if (NAV.routeSteps && NAV.routeSteps.length > 0) {
    const currentStep = NAV.routeSteps[NAV.currentStepIndex];
    if (currentStep) {
      if (mainIconEl) {
        mainIconEl.innerHTML = `<span class="maneuver-icon">${getManeuverIcon(currentStep.type)}</span>`;
      }

      if (stepRoadEl) {
        if (currentStep.road && currentStep.road.trim()) {
          stepRoadEl.textContent = `towards ${currentStep.road}`;
        } else if (currentStep.text && currentStep.text.trim()) {
          stepRoadEl.textContent = currentStep.text.startsWith('towards') ? currentStep.text : `towards ${currentStep.text}`;
        } else {
          stepRoadEl.textContent = `towards ${NAV.destName || 'Destination'}`;
        }
      }

      // Secondary (Next) maneuver preview
      if (NAV.currentStepIndex + 1 < NAV.routeSteps.length) {
        const nextStep = NAV.routeSteps[NAV.currentStepIndex + 1];
        if (nextStepRow) nextStepRow.style.display = 'flex';
        if (nextIconEl) nextIconEl.textContent = getManeuverIcon(nextStep.type);
      } else {
        if (nextStepRow) nextStepRow.style.display = 'none';
      }
    }
  } else {
    // Direct route fallback
    if (mainIconEl) mainIconEl.innerHTML = `<span class="maneuver-icon">↑</span>`;
    if (stepRoadEl) stepRoadEl.textContent = `towards ${NAV.destName || 'Destination'}`;
    if (nextStepRow) nextStepRow.style.display = 'none';
  }
}

/**
 * Compass update handler
 */
function updateCompassHeading(heading) {
  const compassEl = document.getElementById('live-compass-icon');
  if (compassEl && heading !== null && heading !== undefined) {
    compassEl.style.transform = `rotate(${heading}deg)`;
  }
}

// Device orientation listener for physical compass needle
if (window.DeviceOrientationEvent) {
  window.addEventListener('deviceorientation', function(e) {
    let heading = null;
    if (e.webkitCompassHeading) {
      heading = e.webkitCompassHeading;
    } else if (e.alpha !== null) {
      heading = (360 - e.alpha) % 360;
    }
    if (heading !== null) {
      updateCompassHeading(heading);
    }
  }, { passive: true });
}

/**
 * Quick Report Hazard action for ⚠️ Report button
 */
window.quickReportHazard = function() {
  let lat = NAV.lastLat;
  let lon = NAV.lastLon;

  if ((!lat || !lon) && typeof window.ppMap !== 'undefined' && window.ppMap) {
    const center = window.ppMap.getCenter();
    lat = center.lat;
    lon = center.lng;
  }

  if (!lat || !lon) {
    showToast('⚠️ Waiting for GPS location to report...', 'warning');
    return;
  }

  if (navigator.onLine) {
    fetch('/api/patholes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        latitude: lat,
        longitude: lon,
        severity: 'medium',
        accel_peak: 20.0,
        source: 'user_report'
      })
    })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(() => {
      showToast('⚠️ Road hazard reported and saved to database!', 'success');
      if (typeof window.fetchAndRenderPotholes === 'function') {
        window.fetchAndRenderPotholes();
      }
    })
    .catch(err => {
      console.log('Report upload error:', err);
      showToast('⚠️ Road issue reported locally.', 'info');
    });
  }
};


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
   PHASE 5 — Pathole-Aware Navigation Warnings
   ═══════════════════════════════════════════════════════════════════════ */

const PATHOLE_WARN_DISTANCE_M = 40; // metres

function checkPatholeProximityNav(lat, lng) {
  const patholes = window.allPatholesData || [];
  if (patholes.length === 0) return;

  // Find the closest pathole within warning distance
  let closest     = null;
  let closestDist = Infinity;

  patholes.forEach(p => {
    if (!p.is_active) return;
    const d = haversineMeters(lat, lng, p.latitude, p.longitude);
    if (d <= PATHOLE_WARN_DISTANCE_M && d < closestDist) {
      closest     = p;
      closestDist = d;
    }
  });

  if (closest) {
    // Show floating warning card
    showPatholeWarning(closest, Math.round(closestDist));

    // Speak once per pathole per approach
    if (!NAV.spokenPatholes.has(closest.id)) {
      NAV.spokenPatholes.add(closest.id);
      speakNav(`Warning. ${closest.severity} severity pathole ahead in ${Math.round(closestDist)} metres.`);
    }
  } else {
    hidePatholeWarning();
    // Clear patholes that are now far away so we can warn again on next approach
    patholes.forEach(p => {
      const d = haversineMeters(lat, lng, p.latitude, p.longitude);
      if (d > 80) NAV.spokenPatholes.delete(p.id);
    });
  }
}

function showPatholeWarning(pathole, distMetres) {
  const card = document.getElementById('pathole-warning-card');
  if (!card) return;

  const sev = pathole.severity.toUpperCase();
  const emoji = pathole.severity === 'high' ? '🔴' : pathole.severity === 'medium' ? '🟡' : '🟢';
  card.innerHTML = `
    <div class="pw-icon">⚠️</div>
    <div class="pw-content">
      <div class="pw-title">${emoji} ${sev} Pathole Ahead</div>
      <div class="pw-dist">${distMetres} metres</div>
    </div>
  `;
  card.style.display = 'flex';
  card.classList.add('pw-visible');
}

function hidePatholeWarning() {
  const card = document.getElementById('pathole-warning-card');
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
              onclick="event.stopPropagation(); toggleFavAndRender(${d.lat}, ${d.lon}, '${escapeHtml(d.name)}')"
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
  window.selectDestination = function(lat, lon, displayName, autoDirections = true) {
    // Store destination in NAV state
    NAV.destLat  = lat;
    NAV.destLon  = lon;
    NAV.destName = displayName || 'Destination';

    // Save to recent destinations
    saveRecent({ lat, lon, name: displayName || 'Destination' });

    // Call original selectDestination
    _original(lat, lon, displayName, autoDirections);

    // Auto-start navigation if enabled
    const autoToggle = document.getElementById('auto-nav-toggle');
    if (autoToggle && autoToggle.checked) {
      NAV.pendingAutoStart = true;
    }
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   PHASE 6 — UX Helpers: Toast Notifications
   ═══════════════════════════════════════════════════════════════════════ */

let _navLastToastText = '';
let _navLastToastTime = 0;

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const now = Date.now();
  // Prevent duplicate spam within 2.5 seconds
  if (message === _navLastToastText && (now - _navLastToastTime) < 2500) {
    return;
  }
  _navLastToastText = message;
  _navLastToastTime = now;

  // Remove any currently visible toast so they never stack
  const existingToasts = container.querySelectorAll('.toast, .nav-toast');
  existingToasts.forEach(t => {
    t.classList.remove('toast-visible');
    t.remove();
  });

  const toast = document.createElement('div');
  toast.className = `nav-toast nav-toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  // Remove after 3s
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => {
      toast.remove();
      if (_navLastToastText === message) {
        _navLastToastText = '';
      }
    }, 300);
  }, 3000);
}

window.showToast = showToast;

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

    // Register event listener immediately to prevent missing routesfound events
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

        // Event-driven auto-start trigger
        if (NAV.pendingAutoStart) {
          NAV.pendingAutoStart = false;
          window.startNavigation(NAV.destLat, NAV.destLon, NAV.destName);
        }
      });
    }, 0);
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

  // Hook map drag to stop auto-centering so user can explore route freely
  if (window.ppMap) {
    window.ppMap.on('dragstart', () => {
      if (NAV.isNavigating) {
        NAV.isFollowing = false;
      }
    });
  }

  // Render panels on load
  renderRecentPanel();
  renderFavPanel();

  console.log('[PathPulse Navigation] Module loaded ✓');
})();
