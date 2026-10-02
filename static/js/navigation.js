/**
 * PathPulse AI — 3D Live Navigation Module (navigation.js)
 * High-performance 3D Turn-by-Turn GPS Navigation Engine
 *
 * Features:
 * - 3D Camera Perspective Tilt (58° pitch) & dynamic forward road tracking
 * - 3D Navigation Puck with real-time directional heading
 * - Dynamic Turn-by-Turn instruction maneuver banner
 * - Smart Voice Guidance & Speech Synthesis
 * - Real-Time Pothole Hazard alerts along route
 * - Course-Up / North-Up Compass mode toggle
 */

const NAV = {
  isNavigating: false,
  isPaused: false,
  isFollowing: true,
  destLat: null,
  destLon: null,
  destName: '',
  currentRoute: null,     // Array of {lat, lng}
  routeSteps: [],         // Turn-by-turn steps
  currentStepIndex: 0,
  spokenInstructions: new Set(),
  spokenPatholes: new Set(),
  lastLat: null,
  lastLon: null,
  lastTimestamp: null,
  currentSpeed: 0,        // km/h
  totalDistance: 0,       // metres
  totalTime: 0,           // seconds
  lastCameraLat: null,
  lastCameraLon: null,
  cameraUpdateTime: 0
};
window.NAV = NAV;

let isCourseUpMode = true;
let currentMapBearing = 0;
const PATHOLE_WARN_DISTANCE_M = 50;

// ── Calculate Bearing Angle ─────────────────────────────────────────
function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = deg => deg * Math.PI / 180;
  const toDeg = rad => rad * 180 / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return (toDeg(theta) + 360) % 360;
}

function getForwardRouteBearing(lat, lng) {
  if (!NAV.currentRoute || NAV.currentRoute.length < 2) return 0;
  const { idx } = closestPointOnRoute(lat, lng);
  let targetIdx = idx;
  let accumulatedDist = 0;

  for (let i = idx; i < NAV.currentRoute.length - 1; i++) {
    const p1 = NAV.currentRoute[i];
    const p2 = NAV.currentRoute[i + 1];
    accumulatedDist += haversineMeters(p1.lat, p1.lng, p2.lat, p2.lng);
    targetIdx = i + 1;
    if (accumulatedDist >= 35) break;
  }

  let pFrom = NAV.currentRoute[idx];
  let pTo = NAV.currentRoute[targetIdx];

  if (!pFrom || !pTo || (pFrom.lat === pTo.lat && pFrom.lng === pTo.lng)) {
    if (idx > 0 && NAV.currentRoute[idx - 1]) {
      pFrom = NAV.currentRoute[idx - 1];
      pTo = NAV.currentRoute[idx];
    } else if (NAV.currentRoute.length >= 2) {
      pFrom = NAV.currentRoute[0];
      pTo = NAV.currentRoute[1];
    } else {
      return 0;
    }
  }

  return calculateBearing(pFrom.lat, pFrom.lng, pTo.lat, pTo.lng);
}

// ── 3D Camera Orientation Control ───────────────────────────────────
function setMapOrientation(bearing, isAnimated = true) {
  if (!NAV.isNavigating || !window.ppMap) return;
  const targetBearing = isCourseUpMode ? (bearing || 0) : 0;
  currentMapBearing = targetBearing;

  window.ppMap.easeTo({
    bearing: targetBearing,
    duration: isAnimated ? 450 : 0
  });

  // Rotate compass needle
  const compassEl = document.getElementById('live-compass-icon');
  if (compassEl) {
    compassEl.style.transform = `rotate(${targetBearing}deg)`;
  }
}

// ── Start 3D Live Navigation ────────────────────────────────────────
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
  NAV.isPaused = false;
  NAV.isFollowing = true;
  NAV.destLat = destLat;
  NAV.destLon = destLon;
  NAV.destName = destName || 'Destination';
  NAV.currentStepIndex = 0;
  NAV.spokenInstructions = new Set();
  NAV.spokenPatholes = new Set();
  isCourseUpMode = true;
  currentMapBearing = 0;

  // Resolve starting location
  if (!NAV.lastLat || !NAV.lastLon) {
    if (window.lastKnownGPSPosition) {
      NAV.lastLat = window.lastKnownGPSPosition.latitude;
      NAV.lastLon = window.lastKnownGPSPosition.longitude;
    } else if (NAV.currentRoute && NAV.currentRoute.length > 0) {
      NAV.lastLat = NAV.currentRoute[0].lat;
      NAV.lastLon = NAV.currentRoute[0].lng;
    }
  }

  // 1. Show detected pothole marks along the route in live navigation mode
  if (typeof window.filterMarkers === 'function') {
    window.filterMarkers();
  }

  // 2. Activate Full-Screen Navigation layout
  document.body.classList.add('live-nav-active');

  // 3. Show dedicated Live Navigation UI components
  const topCard = document.getElementById('live-nav-top-card');
  const speedBadge = document.getElementById('live-nav-speed-badge');
  const floatControls = document.getElementById('live-nav-floating-controls');
  const bottomCard = document.getElementById('live-nav-bottom-card');

  if (topCard) topCard.style.display = 'flex';
  if (speedBadge) speedBadge.style.display = 'flex';
  if (floatControls) floatControls.style.display = 'flex';
  if (bottomCard) bottomCard.style.display = 'flex';

  // 4. Smooth 3D Camera Swoop into driving perspective
  if (window.ppMap && NAV.lastLat && NAV.lastLon) {
    const initBearing = getForwardRouteBearing(NAV.lastLat, NAV.lastLon);
    window.ppMap.resize();
    window.ppMap.easeTo({
      center: [NAV.lastLon, NAV.lastLat],
      zoom: 18,
      pitch: 58,
      bearing: initBearing,
      duration: 1200
    });
    updateLiveNavUI(NAV.lastLat, NAV.lastLon);
  }

  // 5. Initial voice guidance and toast
  speakNav('Navigation started. Follow the highlighted 3D route.');
  showToast('🚗 3D Live Navigation active!', 'success');
};

// ── Stop Navigation ─────────────────────────────────────────────────
window.stopNavigation = function() {
  NAV.isNavigating = false;
  NAV.isPaused = false;
  NAV.isFollowing = true;

  // Hide pothole markers when navigation stops (clean preview mode)
  if (typeof window.filterMarkers === 'function') {
    window.filterMarkers();
  }

  // Deactivate navigation layout
  document.body.classList.remove('live-nav-active');

  const topCard = document.getElementById('live-nav-top-card');
  const speedBadge = document.getElementById('live-nav-speed-badge');
  const floatControls = document.getElementById('live-nav-floating-controls');
  const bottomCard = document.getElementById('live-nav-bottom-card');

  if (topCard) topCard.style.display = 'none';
  if (speedBadge) speedBadge.style.display = 'none';
  if (floatControls) floatControls.style.display = 'none';
  if (bottomCard) bottomCard.style.display = 'none';
  hidePatholeWarning();

  const startBtn = document.getElementById('btn-start-nav');
  if (startBtn) startBtn.style.display = 'inline-flex';

  // Return camera smoothly to 2D flat mode
  if (window.ppMap) {
    window.ppMap.resize();
    window.ppMap.easeTo({
      pitch: 0,
      bearing: 0,
      duration: 800
    });
    if (NAV.currentRoute && NAV.currentRoute.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      NAV.currentRoute.forEach(p => bounds.extend([p.lng, p.lat]));
      window.ppMap.fitBounds(bounds, { padding: 60, maxZoom: 16 });
    }
  }

  speakNav('Navigation ended.');
  showToast('🏁 Returned to 2D route preview.', 'info');
};

// ── Real-Time GPS Navigation Updates ────────────────────────────────
window.onNavGPSUpdate = function(lat, lng, pos) {
  const now = Date.now();

  // Speed calculation
  if (pos && pos.coords && pos.coords.speed !== null && pos.coords.speed >= 0) {
    NAV.currentSpeed = (pos.coords.speed * 3.6).toFixed(1);
  } else if (NAV.lastLat !== null && NAV.lastTimestamp) {
    const dt = (now - NAV.lastTimestamp) / 1000;
    if (dt > 0) {
      const dist = haversineMeters(NAV.lastLat, NAV.lastLon, lat, lng);
      NAV.currentSpeed = ((dist / dt) * 3.6).toFixed(1);
    }
  }

  NAV.lastLat = lat;
  NAV.lastLon = lng;
  NAV.lastTimestamp = now;

  if (!NAV.isNavigating) return;

  // Compute forward bearing
  let forwardBearing = 0;
  if (pos && pos.coords && pos.coords.heading !== null && !isNaN(pos.coords.heading) && pos.coords.heading >= 0 && Number(NAV.currentSpeed) > 3) {
    forwardBearing = pos.coords.heading;
  } else {
    forwardBearing = getForwardRouteBearing(lat, lng);
  }

  // 3D Camera Follow
  if (NAV.isFollowing && !NAV.isPaused && window.ppMap) {
    window.ppMap.easeTo({
      center: [lng, lat],
      bearing: isCourseUpMode ? forwardBearing : 0,
      pitch: 58,
      duration: 400
    });
  }

  updateLiveNavUI(lat, lng);
  checkPatholeProximityNav(lat, lng);
  checkNextTurnInstruction(lat, lng);
};

// ── Turn-by-Turn Instruction Banner ─────────────────────────────────
function checkNextTurnInstruction(lat, lng) {
  if (!NAV.routeSteps || NAV.routeSteps.length === 0) return;

  const step = NAV.routeSteps[NAV.currentStepIndex] || NAV.routeSteps[0];
  if (!step) return;

  const maneuver = step.maneuver || {};
  const stepRoadEl = document.getElementById('live-nav-step-road');
  const mainIconEl = document.getElementById('live-nav-main-icon');

  const roadName = step.name ? `on ${step.name}` : (step.ref || 'towards Destination');
  const instructionText = `${formatManeuverModifier(maneuver.modifier || maneuver.type)} ${roadName}`;

  if (stepRoadEl) stepRoadEl.textContent = instructionText;
  if (mainIconEl) mainIconEl.innerHTML = `<span class="maneuver-icon">${getManeuverIcon(maneuver.modifier || maneuver.type)}</span>`;

  // Voice announcement
  if (!NAV.spokenInstructions.has(NAV.currentStepIndex)) {
    NAV.spokenInstructions.add(NAV.currentStepIndex);
    speakNav(instructionText);
  }
}

function getManeuverIcon(type = '') {
  const t = type.toLowerCase();
  if (t.includes('left')) return '↰';
  if (t.includes('right')) return '↱';
  if (t.includes('uturn')) return '↶';
  if (t.includes('roundabout')) return '🔄';
  if (t.includes('destination') || t.includes('arrive')) return '🏁';
  return '↑';
}

function formatManeuverModifier(type = '') {
  const t = type.toLowerCase();
  if (t === 'left' || t === 'turn-left') return 'Turn Left';
  if (t === 'right' || t === 'turn-right') return 'Turn Right';
  if (t === 'slight left') return 'Keep Left';
  if (t === 'slight right') return 'Keep Right';
  if (t === 'sharp left') return 'Sharp Left';
  if (t === 'sharp right') return 'Sharp Right';
  if (t === 'roundabout') return 'Enter Roundabout';
  return 'Continue Straight';
}

// ── Live Navigation Metrics UI ──────────────────────────────────────
function updateLiveNavUI(lat, lng) {
  // Speed
  const speedValEl = document.getElementById('live-nav-speed-val');
  if (speedValEl) {
    const spd = parseFloat(NAV.currentSpeed);
    speedValEl.textContent = (!isNaN(spd) && spd > 0) ? String(Math.round(spd)) : '--';
  }

  // Remaining distance & ETA
  let remainingMeters = 0;
  if (NAV.currentRoute && NAV.currentRoute.length > 0) {
    const { idx } = closestPointOnRoute(lat, lng);
    for (let i = idx; i < NAV.currentRoute.length - 1; i++) {
      remainingMeters += haversineMeters(
        NAV.currentRoute[i].lat, NAV.currentRoute[i].lng,
        NAV.currentRoute[i+1].lat, NAV.currentRoute[i+1].lng
      );
    }
  }

  const remainDistStr = remainingMeters >= 1000
    ? (remainingMeters / 1000).toFixed(1) + ' km'
    : Math.round(remainingMeters) + ' m';

  let etaMins = Math.max(1, Math.round((remainingMeters / 1000) / 45 * 60));
  const etaLargeEl = document.getElementById('live-nav-eta-large');
  const distRemainEl = document.getElementById('live-nav-dist-remain');
  const arrivalTimeEl = document.getElementById('live-nav-arrival-time');

  if (etaLargeEl) etaLargeEl.textContent = `${etaMins} min`;
  if (distRemainEl) distRemainEl.textContent = remainDistStr;

  if (arrivalTimeEl) {
    const arr = new Date(Date.now() + etaMins * 60000);
    arrivalTimeEl.textContent = arr.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

// ── Pothole Warning System ──────────────────────────────────────────
function checkPatholeProximityNav(lat, lng) {
  const patholes = window.allPatholesData || [];
  if (patholes.length === 0) return;

  let closest = null;
  let closestDist = Infinity;

  patholes.forEach(p => {
    if (p.is_active === false) return;
    const d = haversineMeters(lat, lng, p.latitude, p.longitude);
    if (d <= PATHOLE_WARN_DISTANCE_M && d < closestDist) {
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
  }
}

function showPatholeWarning(pathole, distMetres) {
  const card = document.getElementById('pathole-warning-card');
  if (!card) return;

  const sev = (pathole.severity || 'medium').toUpperCase();
  const emoji = pathole.severity === 'high' ? '🔴' : pathole.severity === 'medium' ? '🟡' : '🟢';
  card.innerHTML = `
    <div class="pw-icon">⚠️</div>
    <div class="pw-content">
      <div class="pw-title">${emoji} ${sev} Pothole Ahead</div>
      <div class="pw-dist">${distMetres > 0 ? distMetres + ' metres away' : 'Approaching now'}</div>
    </div>
  `;
  card.style.display = 'flex';
  card.classList.add('pw-visible');
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

// ── Voice Guidance (Web Speech API) ─────────────────────────────────
function speakNav(text) {
  if (window.isMuted) return;
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.05;
    utt.pitch = 1.0;
    window.speechSynthesis.speak(utt);
  } catch (e) {
    console.warn('Speech error:', e);
  }
}

// ── Floating Action Buttons (Compass & Recenter) ────────────────────
window.resetCompassNorth = function() {
  isCourseUpMode = !isCourseUpMode;
  if (isCourseUpMode) {
    const fwdBearing = getForwardRouteBearing(NAV.lastLat, NAV.lastLon);
    setMapOrientation(fwdBearing, true);
    showToast('⬆️ 3D Course-Up Driving View', 'info');
  } else {
    setMapOrientation(0, true);
    showToast('🧭 North-Up (0°)', 'info');
  }
};

window.recenterLiveNav = function() {
  NAV.isFollowing = true;
  if (window.ppMap && NAV.lastLat && NAV.lastLon) {
    const fwdBearing = isCourseUpMode ? getForwardRouteBearing(NAV.lastLat, NAV.lastLon) : 0;
    window.ppMap.easeTo({
      center: [NAV.lastLon, NAV.lastLat],
      zoom: 18,
      pitch: 58,
      bearing: fwdBearing,
      duration: 800
    });
    showToast('📍 Centered on your vehicle', 'info');
  }
};

// ── Spatial Closest Point Helper ────────────────────────────────────
function closestPointOnRoute(lat, lng) {
  if (!NAV.currentRoute || NAV.currentRoute.length === 0) return { idx: 0, dist: Infinity };
  let minDist = Infinity;
  let minIdx = 0;
  NAV.currentRoute.forEach((pt, i) => {
    const d = haversineMeters(lat, lng, pt.lat, pt.lng);
    if (d < minDist) { minDist = d; minIdx = i; }
  });
  return { idx: minIdx, dist: minDist };
}
