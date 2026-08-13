/**
 * PathPulse AI — Pothole Detection Engine
 * Uses phone accelerometer + GPS to detect and report potholes in real-time
 *
 * IMPORTANT:
 * - Real GPS only
 * - No simulated GPS fallback
 * - Pothole reports require a valid GPS position
 */

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let isDetecting = false;
let watchId = null;
let detectionCount = 0;
let lastReportTime = 0;

const REPORT_COOLDOWN = 2000; // milliseconds
const PATHOLE_THRESHOLD = 18; // m/s²
const GRAVITY = 9.81;

// GPS state
let currentPosition = null;
let gpsAccuracy = null;
let gpsAvailable = false;
let gpsError = null;

// Audio state
let isMuted = false;
let alertedPatholes = new Set();
let allPatholesData = [];

// IndexedDB
let dbPromise = null;

// Accelerometer
const accelHistory = [];
const HISTORY_SIZE = 5;

let accelHandler = null;
let simInterval = null;

// Chart
let accelChart = null;


// ═══════════════════════════════════════════════════════════════════
// INDEXEDDB
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
                db.createObjectStore("patholes", {
                    keyPath: "id"
                });
            }
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

initIndexedDB();


// ═══════════════════════════════════════════════════════════════════
// DETECTION MAP
// ═══════════════════════════════════════════════════════════════════

const map = L.map("detect-map", {
    zoomControl: true
}).setView([12.971599, 77.594566], 15);

L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    {
        attribution: "&copy; CARTO &copy; OSM",
        maxZoom: 19
    }
).addTo(map);


// ═══════════════════════════════════════════════════════════════════
// MAP STATE
// ═══════════════════════════════════════════════════════════════════

let userMarker = null;
let userAccuracyCircle = null;
let pulseMarker = null;
let pulseTimer = null;

let routeLine = null;
const routeCoords = [];

const patholeLayer = L.layerGroup().addTo(map);


// ═══════════════════════════════════════════════════════════════════
// SEVERITY COLORS
// ═══════════════════════════════════════════════════════════════════

const SEVERITY_COLORS = {
    low: "#3b82f6",
    medium: "#f59e0b",
    high: "#ef4444"
};


// ═══════════════════════════════════════════════════════════════════
// GPS PERMISSION / STATUS
// ═══════════════════════════════════════════════════════════════════

function checkGPSAvailability() {
    if (!navigator.geolocation) {
        gpsAvailable = false;
        gpsError = "Geolocation is not supported by this browser.";

        updateGPSStatus(
            "error",
            "❌ GPS not supported"
        );

        return false;
    }

    return true;
}


function updateGPSStatus(state, message, accuracy = null) {

    const gpsStatus = document.getElementById("gps-status");
    const gpsAccuracyEl = document.getElementById("gps-accuracy");

    if (gpsStatus) {
        gpsStatus.textContent = message;

        gpsStatus.classList.remove(
            "success",
            "error",
            "warning",
            "active"
        );

        gpsStatus.classList.add(state);
    }

    if (gpsAccuracyEl) {

        if (accuracy !== null && Number.isFinite(accuracy)) {
            gpsAccuracyEl.textContent =
                `±${Math.round(accuracy)} m`;
        } else {
            gpsAccuracyEl.textContent = "--";
        }
    }

    // Also update general detection status when appropriate
    if (state === "error") {
        updateStatus("error", message);
    }
}


// ═══════════════════════════════════════════════════════════════════
// UPDATE GPS MARKER
// ═══════════════════════════════════════════════════════════════════

function updateUserLocationOnMap(
    lat,
    lng,
    accuracy,
    centerMap = false
) {

    const position = [lat, lng];

    // Main location marker
    if (!userMarker) {

        userMarker = L.circleMarker(position, {
            radius: 8,
            fillColor: "#06d6a0",
            fillOpacity: 1,
            color: "#ffffff",
            weight: 3
        })
        .addTo(map)
        .bindPopup("📍 You are here");

    } else {

        userMarker.setLatLng(position);

    }


    // Accuracy circle
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


    // Pulse marker
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

                if (!currentPosition || !pulseMarker) {
                    return;
                }

                pulseMarker.setLatLng([
                    currentPosition.lat,
                    currentPosition.lng
                ]);

            }, 500);
        }

    } else {

        pulseMarker.setLatLng(position);

    }


    if (centerMap) {
        map.setView(position, 17);
    }
}


// ═══════════════════════════════════════════════════════════════════
// START GPS
// ═══════════════════════════════════════════════════════════════════

function startGPSTracking() {

    if (!checkGPSAvailability()) {
        return false;
    }


    // Clear old watcher
    if (watchId !== null) {

        navigator.geolocation.clearWatch(watchId);
        watchId = null;

    }


    gpsAvailable = false;
    gpsError = null;

    updateGPSStatus(
        "warning",
        "⏳ Acquiring GPS..."
    );


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


// ═══════════════════════════════════════════════════════════════════
// STOP GPS
// ═══════════════════════════════════════════════════════════════════

function stopGPSTracking() {

    if (watchId !== null) {

        navigator.geolocation.clearWatch(watchId);
        watchId = null;

    }

    gpsAvailable = false;

    updateGPSStatus(
        "warning",
        "GPS tracking stopped"
    );
}


// ═══════════════════════════════════════════════════════════════════
// START DETECTION
// ═══════════════════════════════════════════════════════════════════

function startDetection() {

    if (!checkGPSAvailability()) {
        return;
    }


    const btnStart = document.getElementById("btn-start");
    const btnStop = document.getElementById("btn-stop");


    // Check secure context
    const isLocalhost =
        location.hostname === "localhost" ||
        location.hostname === "127.0.0.1";

    if (!window.isSecureContext && !isLocalhost) {

        alert(
            "GPS requires HTTPS on mobile browsers.\n\n" +
            "Please open PathPulse using HTTPS."
        );

        updateGPSStatus(
            "error",
            "❌ HTTPS required for GPS"
        );

        return;
    }


    isDetecting = true;

    if (btnStart) {
        btnStart.disabled = true;
    }

    if (btnStop) {
        btnStop.disabled = false;
    }


    updateStatus(
        "detecting",
        "📡 Acquiring GPS..."
    );


    // Start GPS
    const gpsStarted = startGPSTracking();

    if (!gpsStarted) {

        isDetecting = false;

        if (btnStart) {
            btnStart.disabled = false;
        }

        if (btnStop) {
            btnStop.disabled = true;
        }

        return;
    }


    // Start accelerometer
    startAccelerometer();
}


// ═══════════════════════════════════════════════════════════════════
// STOP DETECTION
// ═══════════════════════════════════════════════════════════════════

function stopDetection() {

    isDetecting = false;

    stopGPSTracking();
    stopAccelerometer();


    updateStatus(
        "idle",
        "⏹ Detection stopped"
    );


    const btnStart = document.getElementById("btn-start");
    const btnStop = document.getElementById("btn-stop");

    if (btnStart) {
        btnStart.disabled = false;
    }

    if (btnStop) {
        btnStop.disabled = true;
    }
}


// ═══════════════════════════════════════════════════════════════════
// GPS SUCCESS
// ═══════════════════════════════════════════════════════════════════

function onPositionUpdate(position) {

    if (!position || !position.coords) {
        return;
    }


    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const accuracy = position.coords.accuracy;


    // Validate coordinates
    if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
    ) {
        console.warn("Invalid GPS coordinates.");
        return;
    }


    currentPosition = {
        lat: lat,
        lng: lng,
        accuracy: accuracy,
        timestamp: position.timestamp
    };


    gpsAccuracy = accuracy;
    gpsAvailable = true;
    gpsError = null;


    updateGPSStatus(
        "success",
        "📍 GPS Active",
        accuracy
    );


    // Update marker
    updateUserLocationOnMap(
        lat,
        lng,
        accuracy,
        userMarker === null
    );


    // Track route
    addRouteCoordinate(lat, lng);


    // Update general status
    if (isDetecting) {

        updateStatus(
            "detecting",
            "🔍 Scanning road surface..."
        );

    }


    // Check nearby potholes
    checkProximity(lat, lng);
}


// ═══════════════════════════════════════════════════════════════════
// GPS ERROR
// ═══════════════════════════════════════════════════════════════════

function onPositionError(error) {

    console.warn(
        "GPS Error:",
        error.code,
        error.message
    );


    gpsAvailable = false;
    gpsError = error;


    let message;


    switch (error.code) {

        case error.PERMISSION_DENIED:

            message =
                "❌ Location permission denied";

            break;


        case error.POSITION_UNAVAILABLE:

            message =
                "⚠️ GPS signal unavailable";

            break;


        case error.TIMEOUT:

            message =
                "⏳ GPS timeout — retrying...";

            break;


        default:

            message =
                "⚠️ Unable to get GPS location";
    }


    updateGPSStatus(
        "error",
        message
    );


    // DO NOT generate fake coordinates.
    //
    // This is intentional.
    //
    // If GPS is unavailable, detection continues,
    // but pothole reports will wait until a real
    // GPS position becomes available.


    if (isDetecting) {

        updateStatus(
            "warning",
            message
        );

    }
}


// ═══════════════════════════════════════════════════════════════════
// ROUTE TRACKING
// ═══════════════════════════════════════════════════════════════════

function addRouteCoordinate(lat, lng) {

    const lastPoint =
        routeCoords.length > 0
            ? routeCoords[routeCoords.length - 1]
            : null;


    // Avoid adding almost identical GPS points
    if (lastPoint) {

        const distance =
            getDistance(
                lastPoint[0],
                lastPoint[1],
                lat,
                lng
            );

        if (distance < 2) {
            return;
        }
    }


    routeCoords.push([lat, lng]);


    if (!routeLine) {

        routeLine = L.polyline(
            routeCoords,
            {
                color: "#06d6a0",
                weight: 3,
                opacity: 0.6,
                dashArray: "8, 8"
            }
        ).addTo(map);

    } else {

        routeLine.setLatLngs(routeCoords);

    }
}


// ═══════════════════════════════════════════════════════════════════
// ACCELEROMETER PERMISSION
// ═══════════════════════════════════════════════════════════════════

function startAccelerometer() {

    if (!window.DeviceMotionEvent) {

        console.warn(
            "DeviceMotionEvent is not supported."
        );

        updateStatus(
            "warning",
            "⚠️ Accelerometer unavailable"
        );

        return;
    }


    // iOS permission
    if (
        typeof DeviceMotionEvent.requestPermission ===
        "function"
    ) {

        DeviceMotionEvent.requestPermission()
            .then((state) => {

                if (state === "granted") {

                    attachAccelListener();

                } else {

                    alert(
                        "Accelerometer permission denied."
                    );

                }

            })
            .catch((error) => {

                console.error(
                    "Accelerometer permission error:",
                    error
                );

            });

    } else {

        attachAccelListener();

    }
}


// ═══════════════════════════════════════════════════════════════════
// ATTACH ACCELEROMETER
// ═══════════════════════════════════════════════════════════════════

function attachAccelListener() {

    if (accelHandler) {
        return;
    }


    accelHandler = (event) => {

        if (!isDetecting) {
            return;
        }


        const acc =
            event.accelerationIncludingGravity;


        if (
            acc &&
            Number.isFinite(acc.x) &&
            Number.isFinite(acc.y) &&
            Number.isFinite(acc.z)
        ) {

            processAccelData(
                acc.x,
                acc.y,
                acc.z
            );

        }

    };


    window.addEventListener(
        "devicemotion",
        accelHandler,
        {
            passive: true
        }
    );
}


// ═══════════════════════════════════════════════════════════════════
// STOP ACCELEROMETER
// ═══════════════════════════════════════════════════════════════════

function stopAccelerometer() {

    if (accelHandler) {

        window.removeEventListener(
            "devicemotion",
            accelHandler
        );

        accelHandler = null;
    }


    if (simInterval) {

        clearInterval(simInterval);
        simInterval = null;

    }
}


// ═══════════════════════════════════════════════════════════════════
// PROCESS ACCELEROMETER
// ═══════════════════════════════════════════════════════════════════

function processAccelData(x, y, z) {

    const accelX =
        document.getElementById("accel-x");

    const accelY =
        document.getElementById("accel-y");

    const accelZ =
        document.getElementById("accel-z");

    if (accelX) {
        accelX.textContent = x.toFixed(1);
    }

    if (accelY) {
        accelY.textContent = y.toFixed(1);
    }

    if (accelZ) {
        accelZ.textContent = z.toFixed(1);
    }


    // Calculate total acceleration
    const magnitude =
        Math.sqrt(
            x * x +
            y * y +
            z * z
        );


    // Remove gravity baseline
    const deviation =
        Math.abs(
            magnitude - GRAVITY
        );


    const magnitudeValue =
        document.getElementById(
            "magnitude-value"
        );

    if (magnitudeValue) {

        magnitudeValue.textContent =
            deviation.toFixed(1) +
            " m/s²";

    }


    // Update bar
    const barPercent =
        Math.min(
            100,
            (deviation / 40) * 100
        );


    const fill =
        document.getElementById(
            "magnitude-fill"
        );


    if (fill) {

        fill.style.width =
            barPercent + "%";


        if (
            deviation >
            PATHOLE_THRESHOLD
        ) {

            fill.style.background =
                "linear-gradient(90deg, #f59e0b, #ef4444)";

        } else if (
            deviation >
            PATHOLE_THRESHOLD * 0.6
        ) {

            fill.style.background =
                "linear-gradient(90deg, #06d6a0, #f59e0b)";

        } else {

            fill.style.background =
                "var(--gradient-1)";

        }
    }


    // History
    accelHistory.push(deviation);

    if (
        accelHistory.length >
        HISTORY_SIZE
    ) {

        accelHistory.shift();

    }


    // Chart
    if (accelChart) {

        accelChart.data.datasets[0].data.push(
            deviation
        );

        accelChart.data.datasets[0].data.shift();

        accelChart.update("none");
    }


    // Detection
    const now = Date.now();


    if (
        deviation >
        PATHOLE_THRESHOLD &&
        now - lastReportTime >
        REPORT_COOLDOWN
    ) {

        lastReportTime = now;

        onPatholeDetected(
            deviation
        );
    }
}


// ═══════════════════════════════════════════════════════════════════
// POTHOLE DETECTED
// ═══════════════════════════════════════════════════════════════════

async function onPatholeDetected(accelPeak) {

    detectionCount++;


    // VERY IMPORTANT:
    // Do not create a fake location.
    if (!currentPosition || !gpsAvailable) {

        console.warn(
            "Pothole detected, but no valid GPS position is available."
        );


        updateStatus(
            "warning",
            "⚠️ Pothole detected — waiting for GPS..."
        );


        addLogEntry(
            "medium",
            null,
            null,
            accelPeak,
            false
        );


        return;
    }


    const lat =
        currentPosition.lat;

    const lng =
        currentPosition.lng;

    const accuracy =
        currentPosition.accuracy;


    // Severity
    let severity;

    if (accelPeak >= 25) {

        severity = "high";

    } else if (accelPeak >= 15) {

        severity = "medium";

    } else {

        severity = "low";

    }


    // Status
    updateStatus(
        "alert",
        `🚨 POTHOLE DETECTED — ${severity.toUpperCase()}`
    );


    setTimeout(() => {

        if (isDetecting) {

            updateStatus(
                "detecting",
                "🔍 Scanning road surface..."
            );

        }

    }, 2000);


    // Add temporary marker
    addDetectedPotholeMarker(
        lat,
        lng,
        severity,
        accelPeak,
        accuracy
    );


    // Log
    addLogEntry(
        severity,
        lat,
        lng,
        accelPeak,
        true
    );


    // Prepare report
    const reportData = {

        latitude: lat,
        longitude: lng,

        accel_peak: accelPeak,

        confidence:
            Math.min(
                1.0,
                accelPeak / 40
            ),

        accuracy:
            accuracy || null,

        created_at:
            new Date().toISOString()
    };


    // Offline
    if (!navigator.onLine) {

        saveOfflinePathole(
            lat,
            lng,
            accelPeak,
            accuracy
        );

        return;
    }


    // Online
    try {

        const response =
            await fetch(
                "/api/patholes",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify(
                            reportData
                        )
                }
            );


        if (!response.ok) {

            throw new Error(
                `Server returned ${response.status}`
            );

        }


        console.log(
            "Pothole report uploaded successfully."
        );


    } catch (error) {

        console.warn(
            "Network request failed. Saving offline.",
            error
        );


        saveOfflinePathole(
            lat,
            lng,
            accelPeak,
            accuracy
        );

    }
}


// ═══════════════════════════════════════════════════════════════════
// ADD DETECTED POTHOLE MARKER
// ═══════════════════════════════════════════════════════════════════

function addDetectedPotholeMarker(
    lat,
    lng,
    severity,
    accelPeak,
    accuracy
) {

    const color =
        SEVERITY_COLORS[severity];


    const radius =
        severity === "high"
            ? 13
            : severity === "medium"
                ? 10
                : 8;


    const marker =
        L.circleMarker(
            [lat, lng],
            {
                radius: radius,

                fillColor: color,

                fillOpacity: 0.85,

                color: "#ffffff",

                weight: 2
            }
        ).addTo(patholeLayer);


    marker.bindPopup(`
        <div class="popup-title">
            🕳️ Pothole Detected
        </div>

        <span class="popup-severity ${severity}">
            ${severity.toUpperCase()}
        </span>

        <div class="popup-meta">

            <div>
                📊 Acceleration:
                ${accelPeak.toFixed(1)} m/s²
            </div>

            <div>
                📍 ${lat.toFixed(5)},
                ${lng.toFixed(5)}
            </div>

            <div>
                🎯 GPS Accuracy:
                ±${accuracy ? Math.round(accuracy) : "--"} m
            </div>

        </div>
    `);

    marker.openPopup();
}


// ═══════════════════════════════════════════════════════════════════
// STATUS UI
// ═══════════════════════════════════════════════════════════════════

function updateStatus(state, text) {

    const indicator =
        document.getElementById(
            "status-indicator"
        );

    const statusText =
        document.getElementById(
            "status-text"
        );


    if (indicator) {

        indicator.className =
            "status-indicator " +
            state;

    }


    if (statusText) {

        statusText.textContent =
            text;

    }
}


// ═══════════════════════════════════════════════════════════════════
// DETECTION LOG
// ═══════════════════════════════════════════════════════════════════

function addLogEntry(
    severity,
    lat,
    lng,
    accelPeak,
    gpsValid = true
) {

    const log =
        document.getElementById(
            "detection-log"
        );

    const countEl =
        document.getElementById(
            "log-count"
        );


    if (!log) {
        return;
    }


    if (detectionCount === 1) {
        log.innerHTML = "";
    }


    const time =
        new Date().toLocaleTimeString();


    const entry =
        document.createElement("div");


    entry.className =
        "log-entry";


    const locationText =
        gpsValid
            ? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
            : "Waiting for GPS";


    entry.innerHTML = `
        <span class="severity-dot ${severity}"></span>

        <span>
            <strong>
                ${severity.toUpperCase()}
            </strong>
            —
            ${accelPeak.toFixed(1)} m/s²

            <br>

            <small>
                📍 ${locationText}
            </small>
        </span>

        <span class="log-time">
            ${time}
        </span>
    `;


    log.insertBefore(
        entry,
        log.firstChild
    );


    if (countEl) {

        countEl.textContent =
            detectionCount +
            " detection" +
            (
                detectionCount !== 1
                    ? "s"
                    : ""
            );

    }
}


// ═══════════════════════════════════════════════════════════════════
// LOAD EXISTING POTHOLES
// ═══════════════════════════════════════════════════════════════════

async function loadExistingPatholes() {

    try {

        const response =
            await fetch(
                "/api/patholes"
            );


        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status}`
            );

        }


        const data =
            await response.json();


        if (!data.patholes) {
            return;
        }


        allPatholesData =
            data.patholes;


        patholeLayer.clearLayers();


        allPatholesData.forEach(
            (pothole) => {

                const color =
                    SEVERITY_COLORS[
                        pothole.severity
                    ] ||
                    SEVERITY_COLORS.medium;


                const radius =
                    pothole.severity === "high"
                        ? 13
                        : pothole.severity === "medium"
                            ? 10
                            : 8;


                const marker =
                    L.circleMarker(
                        [
                            pothole.latitude,
                            pothole.longitude
                        ],
                        {
                            radius: radius,

                            fillColor: color,

                            fillOpacity: 0.5,

                            color: "#ffffff",

                            weight: 1,

                            opacity: 0.6
                        }
                    ).addTo(patholeLayer);


                marker.bindPopup(`
                    <div class="popup-title">
                        🕳️ Previously Reported
                    </div>

                    <span class="popup-severity ${pothole.severity}">
                        ${(
                            pothole.severity ||
                            "medium"
                        ).toUpperCase()}
                    </span>

                    <div class="popup-meta">

                        <div>
                            📍
                            ${Number(
                                pothole.latitude
                            ).toFixed(5)},
                            ${Number(
                                pothole.longitude
                            ).toFixed(5)}
                        </div>

                        <div>
                            📊 Reports:
                            ${pothole.report_count || 1}
                        </div>

                        <div>
                            🎯 Confidence:
                            ${(
                                Number(
                                    pothole.confidence || 0
                                ) * 100
                            ).toFixed(0)}%
                        </div>

                    </div>
                `);
            }
        );


    } catch (error) {

        console.error(
            "Failed to load existing potholes:",
            error
        );

    }
}


// ═══════════════════════════════════════════════════════════════════
// AUDIO MUTE
// ═══════════════════════════════════════════════════════════════════

window.toggleMute = function () {

    isMuted = !isMuted;


    const button =
        document.getElementById(
            "btn-mute"
        );


    if (button) {

        button.textContent =
            isMuted
                ? "🔇"
                : "🔊";


        button.title =
            isMuted
                ? "Unmute alerts"
                : "Mute alerts";

    }
};


// ═══════════════════════════════════════════════════════════════════
// PROXIMITY WARNING
// ═══════════════════════════════════════════════════════════════════

function checkProximity(lat, lng) {

    if (
        isMuted ||
        allPatholesData.length === 0
    ) {
        return;
    }


    allPatholesData.forEach(
        (pothole) => {

            const distance =
                getDistance(
                    lat,
                    lng,
                    pothole.latitude,
                    pothole.longitude
                );


            if (distance <= 50) {

                if (
                    !alertedPatholes.has(
                        pothole.id
                    )
                ) {

                    alertedPatholes.add(
                        pothole.id
                    );


                    playAlertSound();


                    setTimeout(() => {

                        speakAlert(
                            `Warning: ${pothole.severity} severity pothole ahead.`
                        );

                    }, 400);

                }

            } else if (distance > 100) {

                alertedPatholes.delete(
                    pothole.id
                );

            }

        }
    );
}


// ═══════════════════════════════════════════════════════════════════
// DISTANCE CALCULATION
// ═══════════════════════════════════════════════════════════════════

function getDistance(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const R = 6371e3;


    const phi1 =
        lat1 *
        Math.PI /
        180;


    const phi2 =
        lat2 *
        Math.PI /
        180;


    const deltaPhi =
        (lat2 - lat1) *
        Math.PI /
        180;


    const deltaLambda =
        (lon2 - lon1) *
        Math.PI /
        180;


    const a =
        Math.sin(
            deltaPhi / 2
        ) *
        Math.sin(
            deltaPhi / 2
        ) +

        Math.cos(phi1) *
        Math.cos(phi2) *

        Math.sin(
            deltaLambda / 2
        ) *
        Math.sin(
            deltaLambda / 2
        );


    const c =
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );


    return R * c;
}


// ═══════════════════════════════════════════════════════════════════
// AUDIO ALERT
// ═══════════════════════════════════════════════════════════════════

function playAlertSound() {

    try {

        const AudioContext =
            window.AudioContext ||
            window.webkitAudioContext;


        if (!AudioContext) {
            return;
        }


        const audioCtx =
            new AudioContext();


        const oscillator =
            audioCtx.createOscillator();


        const gainNode =
            audioCtx.createGain();


        oscillator.connect(
            gainNode
        );


        gainNode.connect(
            audioCtx.destination
        );


        oscillator.type =
            "sine";


        oscillator.frequency.setValueAtTime(
            880,
            audioCtx.currentTime
        );


        gainNode.gain.setValueAtTime(
            0.15,
            audioCtx.currentTime
        );


        oscillator.start();


        oscillator.stop(
            audioCtx.currentTime +
            0.35
        );

    } catch (error) {

        console.error(
            "AudioContext failed:",
            error
        );

    }
}


// ═══════════════════════════════════════════════════════════════════
// VOICE ALERT
// ═══════════════════════════════════════════════════════════════════

function speakAlert(text) {

    if (
        "speechSynthesis" in
        window
    ) {

        const utterance =
            new SpeechSynthesisUtterance(
                text
            );


        utterance.rate = 1.0;
        utterance.volume = 1.0;


        window.speechSynthesis.speak(
            utterance
        );

    }
}


// ═══════════════════════════════════════════════════════════════════
// OFFLINE SAVE
// ═══════════════════════════════════════════════════════════════════

function saveOfflinePathole(
    lat,
    lng,
    accelPeak,
    accuracy = null
) {

    if (!dbPromise) {

        console.warn(
            "IndexedDB unavailable."
        );

        return;
    }


    dbPromise
        .then((db) => {

            return new Promise(
                (resolve, reject) => {

                    const tx =
                        db.transaction(
                            "patholes",
                            "readwrite"
                        );


                    const store =
                        tx.objectStore(
                            "patholes"
                        );


                    store.put({

                        id:
                            Date.now() +
                            Math.random(),

                        latitude: lat,

                        longitude: lng,

                        accel_peak:
                            accelPeak,

                        confidence:
                            Math.min(
                                1.0,
                                accelPeak / 40
                            ),

                        accuracy:
                            accuracy,

                        created_at:
                            new Date().toISOString()

                    });


                    tx.oncomplete =
                        () => resolve();


                    tx.onerror =
                        () => reject(
                            tx.error
                        );

                }
            );

        })
        .then(() => {

            updateOfflineUI();

        })
        .catch((error) => {

            console.error(
                "IndexedDB write failed:",
                error
            );

        });
}


// ═══════════════════════════════════════════════════════════════════
// SYNC OFFLINE QUEUE
// ═══════════════════════════════════════════════════════════════════

async function syncOfflineQueue() {

    if (
        !navigator.onLine ||
        !dbPromise
    ) {
        return;
    }


    try {

        const db =
            await dbPromise;


        const queuedPatholes =
            await new Promise(
                (resolve, reject) => {

                    const tx =
                        db.transaction(
                            "patholes",
                            "readonly"
                        );


                    const request =
                        tx.objectStore(
                            "patholes"
                        ).getAll();


                    request.onsuccess =
                        () =>
                            resolve(
                                request.result
                            );


                    request.onerror =
                        () =>
                            reject(
                                request.error
                            );

                }
            );


        if (
            !queuedPatholes ||
            queuedPatholes.length === 0
        ) {
            return;
        }


        const banner =
            document.getElementById(
                "offline-banner"
            );


        if (banner) {

            banner.className =
                "offline-banner synced";

            banner.textContent =
                `🔄 Syncing ${queuedPatholes.length} offline reports...`;

            banner.style.display =
                "flex";
        }


        let successCount = 0;


        for (
            const pothole
            of queuedPatholes
        ) {

            try {

                const response =
                    await fetch(
                        "/api/patholes",
                        {
                            method: "POST",

                            headers: {
                                "Content-Type":
                                    "application/json"
                            },

                            body:
                                JSON.stringify(
                                    pothole
                                )
                        }
                    );


                if (!response.ok) {
                    continue;
                }


                await new Promise(
                    (resolve, reject) => {

                        const deleteTx =
                            db.transaction(
                                "patholes",
                                "readwrite"
                            );


                        deleteTx
                            .objectStore(
                                "patholes"
                            )
                            .delete(
                                pothole.id
                            );


                        deleteTx.oncomplete =
                            () => resolve();


                        deleteTx.onerror =
                            () =>
                                reject(
                                    deleteTx.error
                                );

                    }
                );


                successCount++;


            } catch (error) {

                console.error(
                    "Failed to upload queued pothole:",
                    error
                );

            }
        }


        if (successCount > 0) {

            if (banner) {

                banner.textContent =
                    `✅ Synced ${successCount} reports successfully!`;


                setTimeout(() => {

                    banner.style.display =
                        "none";

                }, 3000);

            }


            loadExistingPatholes();

        } else {

            updateOfflineUI();

        }


    } catch (error) {

        console.error(
            "Offline sync failed:",
            error
        );

    }
}


// ═══════════════════════════════════════════════════════════════════
// OFFLINE UI
// ═══════════════════════════════════════════════════════════════════

async function updateOfflineUI() {

    const banner =
        document.getElementById(
            "offline-banner"
        );


    if (!banner) {
        return;
    }


    if (!navigator.onLine) {

        let count = 0;


        if (dbPromise) {

            try {

                const db =
                    await dbPromise;


                count =
                    await new Promise(
                        (resolve) => {

                            const tx =
                                db.transaction(
                                    "patholes",
                                    "readonly"
                                );


                            const request =
                                tx.objectStore(
                                    "patholes"
                                ).count();


                            request.onsuccess =
                                () =>
                                    resolve(
                                        request.result
                                    );


                            request.onerror =
                                () =>
                                    resolve(0);

                        }
                    );

            } catch (error) {

                console.error(
                    error
                );

            }
        }


        banner.style.display =
            "flex";


        banner.className =
            "offline-banner";


        banner.textContent =
            `⚠️ Running Offline — ${count} pothole report(s) queued locally.`;


    } else {

        banner.style.display =
            "none";

    }
}


// ═══════════════════════════════════════════════════════════════════
// ONLINE / OFFLINE EVENTS
// ═══════════════════════════════════════════════════════════════════

window.addEventListener(
    "online",
    () => {

        console.log(
            "🌐 Internet connection restored."
        );


        updateOfflineUI();
        syncOfflineQueue();

    }
);


window.addEventListener(
    "offline",
    () => {

        console.log(
            "📴 Internet connection lost."
        );


        updateOfflineUI();

    }
);


// ═══════════════════════════════════════════════════════════════════
// INITIAL GPS LOCATION
// ═══════════════════════════════════════════════════════════════════

function initializeGPS() {

    if (!checkGPSAvailability()) {
        return;
    }


    updateGPSStatus(
        "warning",
        "📍 Requesting GPS permission..."
    );


    navigator.geolocation.getCurrentPosition(
        (position) => {

            onPositionUpdate(
                position
            );

        },

        (error) => {

            onPositionError(
                error
            );

        },

        {
            enableHighAccuracy: true,

            timeout: 20000,

            maximumAge: 0
        }
    );
}


// ═══════════════════════════════════════════════════════════════════
// CHART
// ═══════════════════════════════════════════════════════════════════

function initAccelChart() {

    const canvas =
        document.getElementById(
            "accel-chart"
        );


    if (!canvas) {
        return;
    }


    if (typeof Chart === "undefined") {

        console.warn(
            "Chart.js is not loaded."
        );

        return;
    }


    const ctx =
        canvas.getContext("2d");


    const labels =
        Array(40).fill("");


    const data =
        Array(40).fill(0);


    accelChart =
        new Chart(
            ctx,
            {
                type: "line",

                data: {

                    labels: labels,

                    datasets: [
                        {
                            label:
                                "Acceleration (m/s²)",

                            data: data,

                            borderColor:
                                "#059669",

                            borderWidth: 2,

                            fill: true,

                            backgroundColor:
                                "rgba(5, 150, 105, 0.05)",

                            tension: 0.3,

                            pointRadius: 0
                        }
                    ]
                },


                options: {

                    responsive: true,

                    maintainAspectRatio:
                        false,

                    scales: {

                        x: {
                            display: false
                        },

                        y: {

                            min: 0,

                            max: 40,

                            grid: {
                                color:
                                    "rgba(0,0,0,0.05)"
                            },

                            ticks: {
                                color:
                                    "var(--text-secondary)",

                                font: {
                                    size: 9
                                }
                            }
                        }
                    },


                    plugins: {

                        legend: {
                            display: false
                        }
                    }
                }
            }
        );
}


// ═══════════════════════════════════════════════════════════════════
// PAGE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

document.addEventListener(
    "DOMContentLoaded",
    () => {

        console.log(
            "🚀 PathPulse Detection Engine initialized."
        );


        initAccelChart();


        loadExistingPatholes();


        setTimeout(
            updateOfflineUI,
            1000
        );


        // Request GPS immediately
        initializeGPS();

    }
);