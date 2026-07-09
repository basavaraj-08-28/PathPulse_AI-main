/**
 * PathPulse AI — Pothole Detection Engine
 * Uses phone accelerometer + GPS to detect and report potholes in real-time
 */

// ── State ───────────────────────────────────────────────────────────
let isDetecting = false;
let watchId = null;
let detectionCount = 0;
let lastReportTime = 0;
const REPORT_COOLDOWN = 2000; // ms between reports (avoid duplicates)
const POTHOLE_THRESHOLD = 18; // m/s² — spike threshold for detection
const GRAVITY = 9.81;

// ── Added Feature State ─────────────────────────────────────────────
let isMuted = false;
let alertedPotholes = new Set();
let allPotholesData = [];

// IndexedDB database setup
let dbPromise = null;
function initIndexedDB() {
  if (!window.indexedDB) return;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('PathPulseOffline', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('potholes')) {
        db.createObjectStore('potholes', { keyPath: 'id' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}
initIndexedDB();


// Accelerometer history for smoothing
const accelHistory = [];
const HISTORY_SIZE = 5;

// ── Map Setup ───────────────────────────────────────────────────────
const map = L.map('detect-map', {
  zoomControl: true
}).setView([13.0827, 80.2707], 15);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; CARTO &copy; OSM',
  maxZoom: 19
}).addTo(map);

let userMarker = null;
let routeLine = null;
const routeCoords = [];
const potholeLayer = L.layerGroup().addTo(map);

// Load existing potholes
loadExistingPotholes();

// ── Severity Colors ─────────────────────────────────────────────────
const SEVERITY_COLORS = {
  low:    '#3b82f6',
  medium: '#f59e0b',
  high:   '#ef4444'
};

// ── Start Detection ─────────────────────────────────────────────────
function startDetection() {
  // Check for required APIs
  if (!navigator.geolocation) {
    alert('Geolocation is not supported by your browser.');
    return;
  }

  isDetecting = true;
  updateStatus('detecting', '🔍 Scanning road surface...');
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-stop').disabled = false;

  // Start GPS tracking
  watchId = navigator.geolocation.watchPosition(
    onPositionUpdate,
    onPositionError,
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );

  // Start accelerometer
  startAccelerometer();
}

// ── Stop Detection ──────────────────────────────────────────────────
function stopDetection() {
  isDetecting = false;
  updateStatus('idle', '⏹ Detection stopped');
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled = true;

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  stopAccelerometer();
}

// ── Accelerometer ───────────────────────────────────────────────────
let accelHandler = null;

function startAccelerometer() {
  if (window.DeviceMotionEvent) {
    // Check if permission is needed (iOS 13+)
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission()
        .then(state => {
          if (state === 'granted') {
            attachAccelListener();
          } else {
            alert('Accelerometer permission denied. Using simulation mode.');
            startSimulatedAccelerometer();
          }
        })
        .catch(() => {
          startSimulatedAccelerometer();
        });
    } else {
      attachAccelListener();
      // If no real data comes in 2 seconds, switch to simulation
      setTimeout(() => {
        if (isDetecting && accelHistory.length === 0) {
          console.log('No accelerometer data detected, switching to simulation');
          startSimulatedAccelerometer();
        }
      }, 2000);
    }
  } else {
    startSimulatedAccelerometer();
  }
}

function attachAccelListener() {
  accelHandler = (event) => {
    if (!isDetecting) return;
    const acc = event.accelerationIncludingGravity;
    if (acc && acc.x !== null) {
      processAccelData(acc.x, acc.y, acc.z);
    }
  };
  window.addEventListener('devicemotion', accelHandler);
}

function stopAccelerometer() {
  if (accelHandler) {
    window.removeEventListener('devicemotion', accelHandler);
    accelHandler = null;
  }
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
}

// ── Simulated Accelerometer (for desktop testing) ───────────────────
let simInterval = null;

function startSimulatedAccelerometer() {
  console.log('🎮 Running in simulation mode (no real accelerometer)');
  simInterval = setInterval(() => {
    if (!isDetecting) return;

    // Normal driving vibration
    let x = (Math.random() - 0.5) * 3;
    let y = (Math.random() - 0.5) * 3;
    let z = GRAVITY + (Math.random() - 0.5) * 2;

    // Random pothole spike (~5% chance)
    if (Math.random() < 0.05) {
      const spike = 15 + Math.random() * 20;
      z += spike * (Math.random() > 0.5 ? 1 : -1);
      x += (Math.random() - 0.5) * 10;
    }

    processAccelData(x, y, z);
  }, 100);
}

// ── Process Accelerometer Data ──────────────────────────────────────
let currentPosition = null;

function processAccelData(x, y, z) {
  // Update UI
  document.getElementById('accel-x').textContent = x.toFixed(1);
  document.getElementById('accel-y').textContent = y.toFixed(1);
  document.getElementById('accel-z').textContent = z.toFixed(1);

  // Calculate magnitude (removing gravity baseline)
  const magnitude = Math.sqrt(x * x + y * y + z * z);
  const deviation = Math.abs(magnitude - GRAVITY);

  document.getElementById('magnitude-value').textContent = deviation.toFixed(1) + ' m/s²';

  // Update magnitude bar (max at 40 m/s²)
  const barPercent = Math.min(100, (deviation / 40) * 100);
  const fill = document.getElementById('magnitude-fill');
  fill.style.width = barPercent + '%';

  // Color the bar based on intensity
  if (deviation > POTHOLE_THRESHOLD) {
    fill.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
  } else if (deviation > POTHOLE_THRESHOLD * 0.6) {
    fill.style.background = 'linear-gradient(90deg, #06d6a0, #f59e0b)';
  } else {
    fill.style.background = 'var(--gradient-1)';
  }

  // Smoothing: keep history
  accelHistory.push(deviation);
  if (accelHistory.length > HISTORY_SIZE) accelHistory.shift();

  // Dynamic Chart Update
  if (accelChart) {
    accelChart.data.datasets[0].data.push(deviation);
    accelChart.data.datasets[0].data.shift();
    accelChart.update('none'); // Silent update for performance
  }

  // Detect pothole: spike above threshold
  const now = Date.now();
  if (deviation > POTHOLE_THRESHOLD && (now - lastReportTime) > REPORT_COOLDOWN) {
    lastReportTime = now;
    onPotholeDetected(deviation);
  }
}

// ── GPS Position Update ─────────────────────────────────────────────
function onPositionUpdate(position) {
  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  currentPosition = { lat, lng };

  // Update user marker
  if (!userMarker) {
    userMarker = L.circleMarker([lat, lng], {
      radius: 8,
      fillColor: '#06d6a0',
      fillOpacity: 1,
      color: '#ffffff',
      weight: 3
    }).addTo(map);

    // Add pulsing effect
    const pulseMarker = L.circleMarker([lat, lng], {
      radius: 20,
      fillColor: '#336ac8ff',
      fillOpacity: 0.2,
      color: '#06d6a0',
      weight: 1,
      opacity: 0.5
    }).addTo(map);

    setInterval(() => {
      if (currentPosition) {
        pulseMarker.setLatLng([currentPosition.lat, currentPosition.lng]);
      }
    }, 1000);
  } else {
    userMarker.setLatLng([lat, lng]);
  }

  // Track route
  routeCoords.push([lat, lng]);
  if (routeLine) {
    routeLine.setLatLngs(routeCoords);
  } else {
    routeLine = L.polyline(routeCoords, {
      color: '#06d6a0',
      weight: 3,
      opacity: 0.6,
      dashArray: '8, 8'
    }).addTo(map);
  }

  map.panTo([lat, lng]);

  // Check proximity to potholes
  checkProximity(lat, lng);
}

function onPositionError(err) {
  console.warn('GPS Error:', err.message);
  if (isDetecting && !currentPosition) {
    // Use a simulated position for testing on desktop
    currentPosition = {
      lat: 13.0827 + (Math.random() - 0.5) * 0.01,
      lng: 80.2707 + (Math.random() - 0.5) * 0.01
    };
    updateStatus('detecting', '🔍 Scanning (GPS simulated)');
    // Check proximity to potholes with simulated GPS coords
    checkProximity(currentPosition.lat, currentPosition.lng);
  }
}

// ── Pothole Detected! ───────────────────────────────────────────────
async function onPotholeDetected(accelPeak) {
  detectionCount++;

  // Determine position
  let lat, lng;
  if (currentPosition) {
    lat = currentPosition.lat;
    lng = currentPosition.lng;
  } else {
    // Simulated position for desktop testing
    lat = 13.0827 + (Math.random() - 0.5) * 0.02;
    lng = 80.2707 + (Math.random() - 0.5) * 0.02;
  }

  // Determine severity
  let severity;
  if (accelPeak >= 25) severity = 'high';
  else if (accelPeak >= 15) severity = 'medium';
  else severity = 'low';

  // Flash status
  updateStatus('alert', `🚨 POTHOLE DETECTED — ${severity.toUpperCase()}`);
  setTimeout(() => {
    if (isDetecting) updateStatus('detecting', '🔍 Scanning road surface...');
  }, 2000);

  // Add marker to map
  const color = SEVERITY_COLORS[severity];
  const marker = L.circleMarker([lat, lng], {
    radius: severity === 'high' ? 13 : severity === 'medium' ? 10 : 8,
    fillColor: color,
    fillOpacity: 0.85,
    color: '#fff',
    weight: 2
  }).addTo(potholeLayer);

  marker.bindPopup(`
    <div class="popup-title">🕳️ Pothole Detected</div>
    <span class="popup-severity ${severity}">${severity.toUpperCase()}</span>
    <div class="popup-meta">
      <div>📊 Acceleration: ${accelPeak.toFixed(1)} m/s²</div>
      <div>📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
    </div>
  `);

  // Add to log
  addLogEntry(severity, lat, lng, accelPeak);

  // Report to server / offline queue
  if (!navigator.onLine) {
    saveOfflinePothole(lat, lng, accelPeak);
  } else {
    try {
      await fetch('/api/potholes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: lat,
          longitude: lng,
          accel_peak: accelPeak,
          confidence: Math.min(1.0, accelPeak / 40)
        })
      });
    } catch (err) {
      console.warn('Network request failed, queueing offline:', err);
      saveOfflinePothole(lat, lng, accelPeak);
    }
  }
}

// ── UI Helpers ──────────────────────────────────────────────────────
function updateStatus(state, text) {
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  indicator.className = 'status-indicator ' + state;
  statusText.textContent = text;
}

function addLogEntry(severity, lat, lng, accelPeak) {
  const log = document.getElementById('detection-log');
  const countEl = document.getElementById('log-count');

  // Remove placeholder if present
  if (detectionCount === 1) {
    log.innerHTML = '';
  }

  const time = new Date().toLocaleTimeString();

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="severity-dot ${severity}"></span>
    <span><strong>${severity.toUpperCase()}</strong> — ${accelPeak.toFixed(1)} m/s²</span>
    <span class="log-time">${time}</span>
  `;

  log.insertBefore(entry, log.firstChild);
  countEl.textContent = detectionCount + ' detection' + (detectionCount !== 1 ? 's' : '');
}

// ── Load Existing Potholes ──────────────────────────────────────────
async function loadExistingPotholes() {
  try {
    const res = await fetch('/api/potholes');
    const data = await res.json();
    if (data.potholes) {
      allPotholesData = data.potholes;
      potholeLayer.clearLayers();
      allPotholesData.forEach(p => {
        const color = SEVERITY_COLORS[p.severity] || SEVERITY_COLORS.medium;
        L.circleMarker([p.latitude, p.longitude], {
          radius: p.severity === 'high' ? 13 : p.severity === 'medium' ? 10 : 8,
          fillColor: color,
          fillOpacity: 0.5,
          color: '#fff',
          weight: 1,
          opacity: 0.6
        }).addTo(potholeLayer).bindPopup(`
          <div class="popup-title">🕳️ Previously Reported</div>
          <span class="popup-severity ${p.severity}">${p.severity.toUpperCase()}</span>
          <div class="popup-meta">
            Reports: ${p.report_count} | Confidence: ${(p.confidence * 100).toFixed(0)}%
          </div>
        `);
      });
    }
  } catch (e) {
    console.error('Failed to load existing potholes:', e);
  }
}

// ── Center on user location ─────────────────────────────────────────
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    onPositionUpdate,
    () => {},
    { enableHighAccuracy: true, timeout: 5000 }
  );
}

// ── Added Feature Logic ─────────────────────────────────────────────

// Chart.js Oscilloscope Setup
let accelChart = null;
function initAccelChart() {
  const canvas = document.getElementById('accel-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  const labels = Array(40).fill('');
  const data = Array(40).fill(0);
  
  accelChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Acceleration (m/s²)',
        data: data,
        borderColor: '#059669',
        borderWidth: 2,
        fill: true,
        backgroundColor: 'rgba(5, 150, 105, 0.05)',
        tension: 0.3,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { display: false },
        y: {
          min: 0,
          max: 40,
          grid: { color: 'rgba(0,0,0,0.05)' },
          ticks: { color: 'var(--text-secondary)', font: { size: 9 } }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

// Audio Alerts Control
window.toggleMute = function() {
  isMuted = !isMuted;
  const btn = document.getElementById('btn-mute');
  if (btn) {
    btn.textContent = isMuted ? '🔇' : '🔊';
    btn.title = isMuted ? 'Unmute alerts' : 'Mute alerts';
  }
};

// Proximity Warnings
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
    oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // A5 note
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

// IndexedDB Offline operations
function saveOfflinePothole(lat, lng, accelPeak) {
  if (!dbPromise) return;
  dbPromise.then(db => {
    const tx = db.transaction('potholes', 'readwrite');
    tx.objectStore('potholes').put({
      id: Date.now() + Math.random(),
      latitude: lat,
      longitude: lng,
      accel_peak: accelPeak,
      confidence: Math.min(1.0, accelPeak / 40),
      created_at: new Date().toISOString()
    });
    return tx.complete;
  }).then(() => {
    updateOfflineUI();
  }).catch(e => console.error("IndexedDB write failed:", e));
}

function syncOfflineQueue() {
  if (!navigator.onLine || !dbPromise) return;
  dbPromise.then(db => {
    const tx = db.transaction('potholes', 'readonly');
    return tx.objectStore('potholes').getAll();
  }).then(async (queuedPotholes) => {
    if (!queuedPotholes || queuedPotholes.length === 0) return;
    
    const banner = document.getElementById('offline-banner');
    if (banner) {
      banner.className = 'offline-banner synced';
      banner.textContent = `🔄 Syncing ${queuedPotholes.length} offline reports...`;
      banner.style.display = 'flex';
    }

    let successCount = 0;
    for (const p of queuedPotholes) {
      try {
        const res = await fetch('/api/potholes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p)
        });
        if (res.ok) {
          await dbPromise.then(db => {
            const deleteTx = db.transaction('potholes', 'readwrite');
            deleteTx.objectStore('potholes').delete(p.id);
            return deleteTx.complete;
          });
          successCount++;
        }
      } catch (e) {
        console.error("Failed to upload queued pothole:", e);
      }
    }
    
    if (successCount > 0) {
      if (banner) {
        banner.textContent = `✅ Synced ${successCount} reports successfully!`;
        setTimeout(() => {
          banner.style.display = 'none';
        }, 3000);
      }
      loadExistingPotholes();
    } else {
      updateOfflineUI();
    }
  });
}

function updateOfflineUI() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  
  if (!navigator.onLine) {
    if (dbPromise) {
      dbPromise.then(db => {
        const tx = db.transaction('potholes', 'readonly');
        return tx.objectStore('potholes').count();
      }).then(count => {
        banner.style.display = 'flex';
        banner.className = 'offline-banner';
        banner.textContent = `⚠️ Running Offline — ${count} pothole report(s) queued locally.`;
      });
    } else {
      banner.style.display = 'flex';
      banner.className = 'offline-banner';
      banner.textContent = '⚠️ Running Offline — sensor data will not sync.';
    }
  } else {
    banner.style.display = 'none';
  }
}

// Event Listeners for Offline status
window.addEventListener('online', () => {
  updateOfflineUI();
  syncOfflineQueue();
});
window.addEventListener('offline', updateOfflineUI);

// Initialize Chart & UI
document.addEventListener('DOMContentLoaded', () => {
  initAccelChart();
  setTimeout(updateOfflineUI, 1000);
});

