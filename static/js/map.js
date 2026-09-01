/**
 * PathPulse AI — Dashboard Map Script
 * Initializes the main map and loads pothole markers
 *
 * GPS FIXED VERSION
 * - Uses real device GPS
 * - Uses continuous watchPosition()
 * - Removes fake Chennai GPS fallback
 * - Requires HTTPS on mobile
 * - Keeps route/search/pothole functionality
 */

// ── Map Initialization ──────────────────────────────────────────────

const map = L.map('main-map', {
  zoomControl: true,
  attributionControl: true
}).setView([12.971599, 77.594566], 11); // Default: Bengaluru, India

window.ppMap = map;

let _mapResizeTimer = null;
window.addEventListener('resize', () => {
  if (document.body.classList.contains('live-nav-active')) return;
  clearTimeout(_mapResizeTimer);
  _mapResizeTimer = setTimeout(() => {
    if (map) map.invalidateSize({ pan: false });
  }, 250);
}, { passive: true });

window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (map) map.invalidateSize({ pan: false });
  }, 200);
}, { passive: true });


// ── Map Layers ──────────────────────────────────────────────────────

const standardLayer = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }
);

const satelliteLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19
  }
);

const terrainLayer = L.tileLayer(
  'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  {
    attribution:
      '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxZoom: 17
  }
);

standardLayer.addTo(map);

const baseMaps = {
  "Standard": standardLayer,
  "Satellite": satelliteLayer,
  "Terrain": terrainLayer
};

L.control.layers(
  baseMaps,
  null,
  {
    position: 'bottomright'
  }
).addTo(map);


// ── Severity Colors ─────────────────────────────────────────────────

const SEVERITY_COLORS = {
  low: '#09681fff',
  medium: '#f59e0b',
  high: '#ef4444'
};

const SEVERITY_RADIUS = {
  low: 8,
  medium: 10,
  high: 13
};


// ── Added Feature State ─────────────────────────────────────────────

let allPatholesData = [];

window.allPatholesData = allPatholesData;

let alertedPatholes = new Set();

let isMuted = false;


// Configurable route proximity threshold

window.ROUTE_PROXIMITY_THRESHOLD_METERS = 25;

let currentRouteCoordinates = null;


// ====================================================================
// USER GPS LOCATION
// ====================================================================

let userLocationMarker = null;

let userLocationCircle = null;

let locationWatchId = null;

let lastKnownGPSPosition = null;


// GPS configuration

const GPS_OPTIONS = {

  enableHighAccuracy: true,

  timeout: 30000,

  maximumAge: 3000

};


// ── Show User Location ──────────────────────────────────────────────

function showUserLocation(
  lat,
  lng,
  accuracy,
  centerMap = false,
  pos = null
) {

  // Validate GPS coordinates

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {

    console.warn(
      '⚠️ Invalid GPS coordinates:',
      lat,
      lng
    );

    return;
  }


  const latLng = [
    lat,
    lng
  ];


  // If Live Navigation is active, suppress regular user markers so only navMarker is shown
  if (typeof NAV !== 'undefined' && NAV.isNavigating) {
    if (userLocationMarker && map.hasLayer(userLocationMarker)) map.removeLayer(userLocationMarker);
    if (userLocationCircle && map.hasLayer(userLocationCircle)) map.removeLayer(userLocationCircle);
  } else {
    // ────────────────────────────────────────────────────────────────
    // CREATE / UPDATE USER LOCATION MARKER
    // ────────────────────────────────────────────────────────────────
    if (!userLocationMarker) {
      userLocationMarker =
        L.circleMarker(
          latLng,
          {
            radius: 8,
            fillColor: '#06d6a0',
            fillOpacity: 1,
            color: '#ffffff',
            weight: 3
          }
        )
        .addTo(map)
        .bindPopup('📍 You are here');

      // GPS accuracy circle
      userLocationCircle =
        L.circle(
          latLng,
          {
            radius:
              Number.isFinite(accuracy) &&
              accuracy > 0
                ? accuracy
                : 30,
            fillColor: '#06d6a0',
            fillOpacity: 0.08,
            color: '#06d6a0',
            weight: 1,
            opacity: 0.3
          }
        )
        .addTo(map);
    } else {
      if (!map.hasLayer(userLocationMarker)) userLocationMarker.addTo(map);
      userLocationMarker.setLatLng(latLng);

      if (userLocationCircle) {
        if (!map.hasLayer(userLocationCircle)) userLocationCircle.addTo(map);
        userLocationCircle.setLatLng(latLng);

        if (Number.isFinite(accuracy) && accuracy > 0) {
          userLocationCircle.setRadius(accuracy);
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // CENTER MAP ON FIRST REAL GPS FIX (PREVIEW ONLY)
  // ──────────────────────────────────────────────────────────────
  if (centerMap && (typeof NAV === 'undefined' || !NAV.isNavigating)) {
    map.setView(latLng, 16);
  }

  // ──────────────────────────────────────────────────────────────
  // CHECK POTHOLE PROXIMITY
  // ──────────────────────────────────────────────────────────────
  checkProximity(lat, lng);

  // ──────────────────────────────────────────────────────────────
  // NAVIGATION GPS HOOK
  // ──────────────────────────────────────────────────────────────
  if (typeof window.onNavGPSUpdate === 'function') {
    window.onNavGPSUpdate(lat, lng, pos);
  }
}


// ── GPS Success Handler ─────────────────────────────────────────────

function handleGPSPosition(
  position
) {

  const lat =
    position.coords.latitude;

  const lng =
    position.coords.longitude;

  const accuracy =
    position.coords.accuracy;


  // Validate coordinates

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {

    console.error(
      '❌ Invalid GPS coordinates received.'
    );

    return;
  }


  // Save latest GPS position

  lastKnownGPSPosition = {

    latitude: lat,

    longitude: lng,

    accuracy: accuracy,

    timestamp:
      position.timestamp
  };


  console.log(
    `📍 LIVE GPS: ${lat.toFixed(6)}, ${lng.toFixed(6)} | ` +
    `Accuracy: ${
      Number.isFinite(accuracy)
        ? accuracy.toFixed(1)
        : 'unknown'
    }m`
  );


  // Check if this is first GPS fix

  const firstFix =
    !userLocationMarker;


  // Show REAL GPS location

  showUserLocation(
    lat,
    lng,
    accuracy,
    firstFix,
    position
  );


  // Update locate button

  const btn =
    document.getElementById(
      'btn-locate'
    );


  if (btn) {

    btn.innerHTML =
      '📍 My Location';

    btn.disabled =
      false;
  }


  // Show GPS success message

  if (
    firstFix &&
    typeof showToast ===
      'function'
  ) {

    const accuracyText =
      Number.isFinite(accuracy)
        ? Math.round(accuracy)
        : '?';


    showToast(
      `📍 Live GPS location found (${accuracyText}m accuracy)`,
      'success'
    );
  }
}


// ── GPS Error Handler ───────────────────────────────────────────────

function handleGPSError(
  error
) {

  console.warn(
    '⚠️ Geolocation error:',
    error.code,
    error.message
  );


  const btn =
    document.getElementById(
      'btn-locate'
    );


  if (btn) {

    btn.disabled =
      false;
  }


  let message;


  switch (
    error.code
  ) {

    case error.PERMISSION_DENIED:

      message =
        '📍 Location permission denied. Please allow location access in browser settings.';

      if (btn) {

        btn.innerHTML =
          '🔐 Allow GPS';
      }

      break;


    case error.POSITION_UNAVAILABLE:

      message =
        '📍 GPS signal unavailable. Please turn ON device Location/GPS.';

      if (btn) {

        btn.innerHTML =
          '📍 Retry GPS';
      }

      break;


    case error.TIMEOUT:

      message =
        '📍 GPS fix timed out. Searching for your location...';

      if (btn) {

        btn.innerHTML =
          '📍 Retry GPS';
      }

      break;


    default:

      message =
        '📍 Could not fetch your current GPS location.';

      if (btn) {

        btn.innerHTML =
          '📍 Retry GPS';
      }
  }


  if (
    typeof showToast ===
    'function'
  ) {

    showToast(
      message,
      'warning'
    );
  }


  /*
   * IMPORTANT:
   *
   * There is NO fake GPS fallback here.
   *
   * The old code used:
   *
   * 13.0827, 80.2707
   *
   * which is Chennai.
   *
   * That has been removed.
   */
}


// ── Start Live GPS Tracking ─────────────────────────────────────────

function startLiveLocation() {

  // Browser support check

  if (
    !navigator.geolocation
  ) {

    console.error(
      '❌ Geolocation is not supported by this browser.'
    );


    if (
      typeof showToast ===
      'function'
    ) {

      showToast(
        '❌ GPS is not supported by this browser.',
        'error'
      );
    }


    return false;
  }


  // ────────────────────────────────────────────────────────────────
  // HTTPS CHECK
  // ────────────────────────────────────────────────────────────────

  const isLocalhost =
    location.hostname ===
      'localhost' ||

    location.hostname ===
      '127.0.0.1';


  if (
    !window.isSecureContext &&
    !isLocalhost
  ) {

    console.error(
      '❌ Geolocation requires HTTPS.'
    );


    if (
      typeof showToast ===
      'function'
    ) {

      showToast(
        '⚠️ GPS requires HTTPS. Please open the HTTPS version of PathPulse.',
        'error'
      );
    }


    return false;
  }


  // ────────────────────────────────────────────────────────────────
  // CLEAR OLD WATCHER
  // ────────────────────────────────────────────────────────────────

  if (
    locationWatchId !== null
  ) {

    navigator.geolocation.clearWatch(
      locationWatchId
    );

    locationWatchId =
      null;
  }


  console.log(
    '🛰️ Starting live GPS tracking...'
  );


  // ────────────────────────────────────────────────────────────────
  // START CONTINUOUS GPS
  // ────────────────────────────────────────────────────────────────

  locationWatchId =
    navigator.geolocation.watchPosition(

      handleGPSPosition,

      handleGPSError,

      GPS_OPTIONS
    );


  return true;
}


// ── Stop Live GPS ──────────────────────────────────────────────────

function stopLiveLocation() {

  if (
    locationWatchId !== null
  ) {

    navigator.geolocation.clearWatch(
      locationWatchId
    );

    locationWatchId =
      null;


    console.log(
      '🛰️ Live GPS tracking stopped.'
    );
  }
}


// ── Locate User ─────────────────────────────────────────────────────

function locateUser() {

  const btn =
    document.getElementById(
      'btn-locate'
    );


  if (btn) {

    btn.innerHTML =
      '⏳ Acquiring GPS...';

    btn.disabled =
      true;
  }


  // Start continuous GPS

  const started =
    startLiveLocation();


  if (!started) {

    if (btn) {

      btn.innerHTML =
        '📍 Retry GPS';

      btn.disabled =
        false;
    }

    return;
  }


  // ────────────────────────────────────────────────────────────────
  // REQUEST A FRESH GPS FIX
  // ────────────────────────────────────────────────────────────────

  navigator.geolocation.getCurrentPosition(

    handleGPSPosition,

    handleGPSError,

    {
      enableHighAccuracy:
        true,

      timeout:
        30000,

      maximumAge:
        0
    }
  );
}


// Expose GPS functions globally

window.startLiveLocation =
  startLiveLocation;

window.stopLiveLocation =
  stopLiveLocation;

window.locateUser =
  locateUser;


// ====================================================================
// POTHOLE MARKERS LAYER
// ====================================================================

let patholeLayer =
  L.layerGroup().addTo(map);


// ── Create Pathole Marker ───────────────────────────────────────────

function createPatholeMarker(
  pathole
) {

  const color =
    SEVERITY_COLORS[
      pathole.severity
    ] ||
    SEVERITY_COLORS.medium;


  const radius =
    SEVERITY_RADIUS[
      pathole.severity
    ] ||
    10;


  const marker =
    L.circleMarker(
      [
        pathole.latitude,
        pathole.longitude
      ],
      {
        radius: radius,

        fillColor: color,

        fillOpacity: 0.85,

        color: '#ffffff',

        weight: 2.5,

        opacity: 0.95
      }
    );


  const date =
    pathole.created_at
      ? new Date(
          pathole.created_at
        ).toLocaleString()
      : 'Unknown';


  let distText = '';


  if (
    pathole.distToRoute !==
      undefined &&
    pathole.distToRoute !==
      null
  ) {

    distText =
      `<div>📏 Distance to Route: <strong>${pathole.distToRoute.toFixed(1)} m</strong></div>`;
  }


  marker.bindPopup(
    `
    <div class="popup-title">
      🕳️ Pathole Detected
    </div>

    <span class="popup-severity ${pathole.severity}">
      ${pathole.severity.toUpperCase()}
    </span>

    <div class="popup-meta">

      <div>
        📍 Coords:
        ${pathole.latitude.toFixed(5)},
        ${pathole.longitude.toFixed(5)}
      </div>

      ${distText}

      <div>
        📊 Reports:
        ${pathole.report_count}
        |
        Confidence:
        ${(pathole.confidence * 100).toFixed(0)}%
      </div>

      ${
        pathole.accel_peak
          ? `<div>⚡ Peak Accel: ${pathole.accel_peak.toFixed(1)} m/s²</div>`
          : ''
      }

      <div>
        📅 Date:
        ${date}
      </div>

    </div>
    `
  );


  return marker;
}


// ====================================================================
// LOAD POTHOLES
// ====================================================================

async function loadPatholes() {

  try {

    const res =
      await fetch(
        '/api/patholes'
      );


    const data =
      await res.json();


    if (
      data.patholes
    ) {

      allPatholesData =
        data.patholes;


      window.allPatholesData =
        allPatholesData;


      filterMarkers();


      // Fit bounds only when GPS is unavailable

      if (
        !userLocationMarker &&
        patholeLayer.getLayers().length > 0
      ) {

        const group =
          L.featureGroup(
            patholeLayer.getLayers()
          );


        map.fitBounds(
          group.getBounds().pad(0.2)
        );
      }
    }

  } catch (err) {

    console.error(
      'Failed to load patholes:',
      err
    );
  }
}


// ── Refresh ─────────────────────────────────────────────────────────

function refreshMap() {

  loadPatholes();
}


// ====================================================================
// ROUTING & SEARCH
// ====================================================================

let currentRouteLayer =
  null;

let destinationMarker =
  null;


// ── Search Setup ────────────────────────────────────────────────────

function setupSearch() {

  const searchInput =
    document.getElementById(
      'map-search'
    );


  const suggestionsBox =
    document.getElementById(
      'search-suggestions'
    );


  let searchTimeout =
    null;


  if (searchInput) {

    searchInput.addEventListener(
      'input',
      (e) => {

        clearTimeout(
          searchTimeout
        );


        const query =
          e.target.value.trim();


        if (
          query.length < 3
        ) {

          suggestionsBox.style.display =
            'none';

          return;
        }


        searchTimeout =
          setTimeout(
            () => {

              let url =
                `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=50&lang=en`;


              // Prioritize results near current map center

              if (map) {

                const center =
                  map.getCenter();


                url +=
                  `&lat=${center.lat}&lon=${center.lng}`;
              }


              fetch(url)

                .then(
                  res =>
                    res.json()
                )

                .then(
                  data => {

                    suggestionsBox.innerHTML =
                      '';


                    if (
                      !data.features ||
                      data.features.length === 0
                    ) {

                      suggestionsBox.innerHTML =
                        '<div class="suggestion-item">No results found</div>';

                    } else {

                      data.features.forEach(
                        feature => {

                          const place =
                            feature.properties;


                          const coords =
                            feature.geometry.coordinates;


                          const lat =
                            coords[1];


                          const lon =
                            coords[0];


                          const div =
                            document.createElement(
                              'div'
                            );


                          div.className =
                            'suggestion-item';


                          const parts =
                            [];


                          if (
                            place.name
                          ) {

                            parts.push(
                              place.name
                            );
                          }


                          if (
                            place.street
                          ) {

                            parts.push(
                              place.street
                            );
                          }


                          if (
                            place.district
                          ) {

                            parts.push(
                              place.district
                            );
                          }


                          if (
                            place.city ||
                            place.town
                          ) {

                            parts.push(
                              place.city ||
                              place.town
                            );
                          }


                          if (
                            place.state
                          ) {

                            parts.push(
                              place.state
                            );
                          }


                          const title =
                            place.name ||
                            place.street ||
                            place.city ||
                            place.town ||
                            'Unknown Location';


                          const subtitle =
                            parts
                              .filter(
                                p =>
                                  p !==
                                  title
                              )
                              .slice(
                                0,
                                3
                              )
                              .join(
                                ', '
                              ) ||
                            place.country ||
                            '';


                          div.innerHTML =
                            `
                            <strong>
                              ${title}
                            </strong>

                            <br>

                            <span
                              style="
                                font-size:0.75rem;
                                color:var(--text-muted);
                              "
                            >
                              ${subtitle}
                            </span>
                            `;


                          div.addEventListener(
                            'click',
                            () => {

                              selectDestination(
                                lat,
                                lon,
                                title
                              );


                              suggestionsBox.style.display =
                                'none';


                              searchInput.value =
                                title;
                            }
                          );


                          suggestionsBox.appendChild(
                            div
                          );
                        }
                      );
                    }


                    suggestionsBox.style.display =
                      'block';
                  }
                )

                .catch(
                  err =>
                    console.error(
                      'Search error:',
                      err
                    )
                );

            },
            400
          );
      }
    );


    // Hide suggestions when clicking outside

    document.addEventListener(
      'click',
      (e) => {

        if (
          !searchInput.contains(
            e.target
          ) &&
          !suggestionsBox.contains(
            e.target
          )
        ) {

          suggestionsBox.style.display =
            'none';
        }
      }
    );
  }
}


// ====================================================================
// MAP CLICK → DESTINATION
// ====================================================================

map.on(
  'click',
  function(e) {

    if (
      e.originalEvent &&
      (
        e.originalEvent._stopped ||
        e.originalEvent.defaultPrevented
      )
    ) {

      return;
    }


    const lat =
      e.latlng.lat;


    const lng =
      e.latlng.lng;


    const defaultTitle =
      `Selected Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;


    // Update search box

    const searchInput =
      document.getElementById(
        'map-search'
      );


    if (searchInput) {

      searchInput.value =
        defaultTitle;
    }


    // Calculate route

    selectDestination(
      lat,
      lng,
      defaultTitle,
      true
    );


    // Reverse geocoding

    fetch(
      `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`
    )

      .then(
        res =>
          res.json()
      )

      .then(
        data => {

          if (
            data &&
            data.features &&
            data.features.length > 0
          ) {

            const props =
              data.features[0].properties;


            const title =
              props.name ||
              props.street ||
              props.district ||
              props.city ||
              defaultTitle;


            const destEl =
              document.getElementById(
                'route-dest-name'
              );


            if (destEl) {

              destEl.textContent =
                title;
            }


            if (searchInput) {

              searchInput.value =
                title;
            }


            if (
              destinationMarker
            ) {

              destinationMarker.setPopupContent(
                `
                <div class="popup-title">
                  🎯 Destination
                </div>

                <div
                  class="popup-meta"
                  style="
                    margin-bottom:8px;
                    line-height:1.4;
                  "
                >
                  ${title}
                </div>

                <button
                  class="btn btn-primary btn-sm"
                  onclick="getDirections(${lat}, ${lng})"
                  style="
                    width:100%;
                    padding:8px;
                    margin-top:8px;
                  "
                >
                  🗺️ Recalculate Route
                </button>
                `
              );
            }
          }
        }
      )

      .catch(
        err =>
          console.log(
            'Reverse geocode fallback:',
            err
          )
      );
  }
);


// ====================================================================
// SELECT DESTINATION
// ====================================================================

window.selectDestination =
  function(
    lat,
    lon,
    displayName,
    autoDirections = true
  ) {

    map.setView(
      [
        lat,
        lon
      ],
      14
    );


    if (
      destinationMarker
    ) {

      map.removeLayer(
        destinationMarker
      );
    }


    destinationMarker =
      L.marker(
        [
          lat,
          lon
        ]
      )
      .addTo(map);


    destinationMarker.bindPopup(
      `
      <div class="popup-title">
        🎯 Destination
      </div>

      <div
        class="popup-meta"
        style="
          margin-bottom:8px;
          line-height:1.4;
        "
      >
        ${
          displayName ||
          'Selected Destination'
        }
      </div>

      <button
        class="btn btn-primary btn-sm"
        onclick="getDirections(${lat}, ${lon})"
        style="
          width:100%;
          padding:8px;
          margin-top:8px;
        "
      >
        🗺️ Get Directions
      </button>
      `
    );


    const destNameEl =
      document.getElementById(
        'route-dest-name'
      );


    if (destNameEl) {

      destNameEl.textContent =
        displayName ||
        'Selected Location';
    }


    if (autoDirections) {

      getDirections(
        lat,
        lon
      );
    }
  };


// ====================================================================
// GET DIRECTIONS
// ====================================================================

window.routingControl =
  null;


window.getDirections =
  function(
    destLat,
    destLon
  ) {

    // User GPS is required

    if (
      !userLocationMarker
    ) {

      console.log(
        'User location unknown. Requesting GPS...'
      );


      locateUser();


      setTimeout(
        () => {

          if (
            userLocationMarker
          ) {

            getDirections(
              destLat,
              destLon
            );

          } else {

            alert(
              'Your current GPS location is not available. Please allow location permission and wait for GPS.'
            );
          }

        },
        1500
      );


      return;
    }


    const userLat =
      userLocationMarker
        .getLatLng()
        .lat;


    const userLon =
      userLocationMarker
        .getLatLng()
        .lng;


    if (
      destinationMarker
    ) {

      destinationMarker.closePopup();
    }


    // Remove old route

    if (
      window.routingControl
    ) {

      map.removeControl(
        window.routingControl
      );

      window.routingControl =
        null;
    }


    if (
      currentRouteLayer
    ) {

      map.removeLayer(
        currentRouteLayer
      );

      currentRouteLayer =
        null;
    }


    // Create route

    window.selectedRouteIndex = 0;
    window.allComputedRoutes = [];

    // Create route with alternative routes enabled
    window.routingControl = L.Routing.control({
      waypoints: [
        L.latLng(userLat, userLon),
        L.latLng(destLat, destLon)
      ],
      routeWhileDragging: false,
      showAlternatives: true,
      altLineOptions: {
        styles: [
          { color: '#64748b', weight: 5, opacity: 0.6, dashArray: '6, 8' }
        ]
      },
      lineOptions: {
        styles: [
          { color: '#2563eb', weight: 6, opacity: 0.9 }
        ]
      },
      createMarker: function() { return null; }
    }).addTo(map);

    // Route found
    window.routingControl.on('routesfound', function(e) {
      window.allComputedRoutes = e.routes || [];
      window.selectedRouteIndex = 0;
      const route = e.routes[0];

      currentRouteCoordinates = route.coordinates;
      if (window.NAV) {
        window.NAV.currentRoute = route.coordinates;
        window.NAV.routeSteps = route.instructions || [];
      }

      const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
      const travelTimeMin = Math.round(route.summary.totalTime / 60);
      const etaStr = travelTimeMin >= 60
        ? Math.floor(travelTimeMin / 60) + 'h ' + (travelTimeMin % 60) + 'm'
        : travelTimeMin + ' min';

      // Fit route
      const bounds = L.latLngBounds(route.coordinates);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });

      // Route information
      const routeInfo = document.getElementById('route-info');
      const routeDistance = document.getElementById('route-distance');
      const routeEta = document.getElementById('route-eta');
      const startNameEl = document.getElementById('route-start-name');

      if (routeDistance) routeDistance.textContent = distanceKm;
      if (routeEta) routeEta.textContent = etaStr;
      if (startNameEl) startNameEl.textContent = 'Current GPS Location';
      if (routeInfo) routeInfo.style.display = 'flex';

      // Render alternative routes bar if multiple options found
      renderRouteAlternatives(e.routes);

      // Hide map click hint
      const hintEl = document.getElementById('map-click-hint');
      if (hintEl) hintEl.classList.add('hidden');

      // Filter potholes along route
      filterMarkers();

      const routePotholes = filterPotholesAlongRoute(
        currentRouteCoordinates,
        window.ROUTE_PROXIMITY_THRESHOLD_METERS
      );

      // Debounced Toast to prevent multi-firing
      if (window._routeFoundToastTimer) {
        clearTimeout(window._routeFoundToastTimer);
      }
      window._routeFoundToastTimer = setTimeout(() => {
        if (typeof showToast === 'function') {
          if (routePotholes.length > 0) {
            showToast(
              `⚠️ ${routePotholes.length} pothole(s) detected along selected route!`,
              'warning'
            );
          } else {
            showToast(
              `✅ Route clear! No potholes detected along selected route.`,
              'success'
            );
          }
        }
      }, 300);
    });

    // Routing error
    window.routingControl.on('routingerror', function(e) {
      console.error('Routing error:', e);
      alert('Could not calculate a route to the selected destination. Please try another location.');
    });
  };

/** Render interactive pills for fastest vs alternative/shortest routes */
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

  // Sort or identify fastest vs shortest
  let minDistanceIdx = 0;
  let minTimeIdx = 0;
  routes.forEach((r, i) => {
    if (r.summary.totalDistance < routes[minDistanceIdx].summary.totalDistance) minDistanceIdx = i;
    if (r.summary.totalTime < routes[minTimeIdx].summary.totalTime) minTimeIdx = i;
  });

  routes.forEach((rt, index) => {
    const distKm = (rt.summary.totalDistance / 1000).toFixed(1);
    const timeMin = Math.round(rt.summary.totalTime / 60);
    const timeStr = timeMin >= 60 ? Math.floor(timeMin / 60) + 'h ' + (timeMin % 60) + 'm' : timeMin + ' min';

    let badgeLabel = index === minTimeIdx ? '⚡ Fastest' : (index === minDistanceIdx ? '📏 Shortest' : `Alt ${index + 1}`);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `route-alt-chip ${index === window.selectedRouteIndex ? 'active' : ''}`;
    chip.innerHTML = `<span class="alt-badge">${badgeLabel}</span> <span class="alt-time">${timeStr}</span> <span class="alt-dist">(${distKm} km)</span>`;
    chip.onclick = () => window.selectAlternativeRoute(index);
    bar.appendChild(chip);
  });
}

/** User clicked an alternative route */
window.selectAlternativeRoute = function(index) {
  if (!window.allComputedRoutes || !window.allComputedRoutes[index]) return;
  window.selectedRouteIndex = index;
  const route = window.allComputedRoutes[index];

  currentRouteCoordinates = route.coordinates;
  if (window.NAV) {
    window.NAV.currentRoute = route.coordinates;
    window.NAV.routeSteps = route.instructions || [];
  }

  const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
  const travelTimeMin = Math.round(route.summary.totalTime / 60);
  const etaStr = travelTimeMin >= 60 ? Math.floor(travelTimeMin / 60) + 'h ' + (travelTimeMin % 60) + 'm' : travelTimeMin + ' min';

  const routeDistance = document.getElementById('route-distance');
  const routeEta = document.getElementById('route-eta');
  if (routeDistance) routeDistance.textContent = distanceKm;
  if (routeEta) routeEta.textContent = etaStr;

  const countEl = document.getElementById('route-potholes-count');
  const routePotholes = filterPotholesAlongRoute(route.coordinates, window.ROUTE_PROXIMITY_THRESHOLD_METERS);
  if (countEl) countEl.textContent = routePotholes.length;

  // Update active styling on alternative chips
  document.querySelectorAll('.route-alt-chip').forEach((el, idx) => {
    if (idx === index) el.classList.add('active');
    else el.classList.remove('active');
  });

  // Re-style route lines so selected one is prominent
  if (window.routingControl && window.routingControl._routes) {
    window.routingControl._routes.forEach((layer, idx) => {
      if (layer.line) {
        if (idx === index) {
          layer.line.setStyle({ color: '#2563eb', opacity: 0.9, weight: 6, dashArray: null });
          layer.line.bringToFront();
        } else {
          layer.line.setStyle({ color: '#64748b', opacity: 0.6, weight: 5, dashArray: '6, 8' });
        }
      }
    });
  }

  if (typeof showToast === 'function') {
    showToast(`Selected Route: ${distanceKm} km • ${etaStr}`, 'info');
  }
};

// ====================================================================
// CLEAR ROUTE
// ====================================================================

window.clearRoute = function() {
  currentRouteCoordinates = null;
  window.allComputedRoutes = [];
  window.selectedRouteIndex = 0;

  const bar = document.getElementById('route-alternatives-bar');
  if (bar) {
    bar.style.display = 'none';
    bar.innerHTML = '';
  }

  if (window.routingControl) {
    map.removeControl(window.routingControl);
    window.routingControl = null;
  }


    if (
      currentRouteLayer
    ) {

      map.removeLayer(
        currentRouteLayer
      );

      currentRouteLayer =
        null;
    }


    if (
      destinationMarker
    ) {

      map.removeLayer(
        destinationMarker
      );

      destinationMarker =
        null;
    }


    const routeInfo =
      document.getElementById(
        'route-info'
      );


    if (routeInfo) {

      routeInfo.style.display =
        'none';
    }


    const hintEl =
      document.getElementById(
        'map-click-hint'
      );


    if (hintEl) {

      hintEl.classList.remove(
        'hidden'
      );
    }


    const searchInput =
      document.getElementById(
        'map-search'
      );


    if (searchInput) {

      searchInput.value =
        '';
    }


    filterMarkers();
  };


// ====================================================================
// ROUTE PROXIMITY
// ====================================================================

function getDistanceToSegmentMeters(
  pLat,
  pLng,
  aLat,
  aLng,
  bLat,
  bLng
) {

  const midLatRad =
    (
      (aLat + bLat) /
      2
    ) *
    (
      Math.PI /
      180
    );


  const cosMidLat =
    Math.cos(
      midLatRad
    );


  const DEG_TO_M_LAT =
    111320;


  const DEG_TO_M_LNG =
    111320 *
    cosMidLat;


  const ax =
    0;


  const ay =
    0;


  const bx =
    (
      bLng -
      aLng
    ) *
    DEG_TO_M_LNG;


  const by =
    (
      bLat -
      aLat
    ) *
    DEG_TO_M_LAT;


  const px =
    (
      pLng -
      aLng
    ) *
    DEG_TO_M_LNG;


  const py =
    (
      pLat -
      aLat
    ) *
    DEG_TO_M_LAT;


  const dx =
    bx -
    ax;


  const dy =
    by -
    ay;


  const lenSq =
    dx * dx +
    dy * dy;


  let t =
    0;


  if (
    lenSq > 0
  ) {

    t =
      (
        px * dx +
        py * dy
      ) /
      lenSq;


    t =
      Math.max(
        0,
        Math.min(
          1,
          t
        )
      );
  }


  const projX =
    ax +
    t * dx;


  const projY =
    ay +
    t * dy;


  const distSq =
    (
      px -
      projX
    ) *
    (
      px -
      projX
    ) +

    (
      py -
      projY
    ) *
    (
      py -
      projY
    );


  return Math.sqrt(
    distSq
  );
}


// ── Minimum Distance to Route ───────────────────────────────────────

function getMinDistanceToRoute(
  pLat,
  pLng,
  routeCoords
) {

  if (
    !routeCoords ||
    routeCoords.length < 2
  ) {

    return Infinity;
  }


  let minDistance =
    Infinity;


  for (
    let i = 0;
    i <
      routeCoords.length - 1;
    i++
  ) {

    const p1 =
      routeCoords[i];


    const p2 =
      routeCoords[
        i + 1
      ];


    const d =
      getDistanceToSegmentMeters(
        pLat,
        pLng,

        p1.lat,
        p1.lng,

        p2.lat,
        p2.lng
      );


    if (
      d <
      minDistance
    ) {

      minDistance =
        d;


      if (
        minDistance < 1
      ) {

        break;
      }
    }
  }


  return minDistance;
}


// ── Filter Potholes Along Route ─────────────────────────────────────

function filterPotholesAlongRoute(
  routeCoords,
  thresholdMeters
) {

  if (
    !routeCoords ||
    routeCoords.length === 0
  ) {

    return [];
  }


  const showLow =
    document.getElementById(
      'filter-low'
    )?.checked ??
    true;


  const showMed =
    document.getElementById(
      'filter-medium'
    )?.checked ??
    true;


  const showHigh =
    document.getElementById(
      'filter-high'
    )?.checked ??
    true;


  const routePotholes =
    [];


  allPatholesData.forEach(
    p => {

      if (
        !p.is_active
      ) {

        return;
      }


      if (
        p.severity ===
          'low' &&
        !showLow
      ) {

        return;
      }


      if (
        p.severity ===
          'medium' &&
        !showMed
      ) {

        return;
      }


      if (
        p.severity ===
          'high' &&
        !showHigh
      ) {

        return;
      }


      const dist =
        getMinDistanceToRoute(
          p.latitude,
          p.longitude,
          routeCoords
        );


      if (
        dist <=
        thresholdMeters
      ) {

        p.distToRoute =
          dist;


        routePotholes.push(
          p
        );
      }
    }
  );


  return routePotholes;
}


// ── Filter Markers ──────────────────────────────────────────────────

window.filterMarkers =
  function() {

    patholeLayer.clearLayers();

    /*
     * IMPORTANT REQUIREMENT:
     * Main Map page — HIDE pothole markers completely.
     * Do NOT display pothole markers, pins, circles, or icons.
     * Keep pathole data in memory (window.allPatholesData) for route warnings,
     * statistics, and internal calculations, but keep map clean.
     */

    if (
      !currentRouteCoordinates ||
      currentRouteCoordinates.length === 0
    ) {

      const countEl =
        document.getElementById(
          'route-potholes-count'
        );

      if (countEl) {

        countEl.textContent =
          '0';
      }

      return;
    }

    const routePotholes =
      filterPotholesAlongRoute(
        currentRouteCoordinates,
        window.ROUTE_PROXIMITY_THRESHOLD_METERS
      );

    // Keep map clean: Do NOT add markers to patholeLayer
    // patholeLayer remains cleared.

    const countEl =
      document.getElementById(
        'route-potholes-count'
      );

    if (countEl) {

      countEl.textContent =
        routePotholes.length;
    }
  };



// ====================================================================
// MUTE / AUDIO WARNINGS
// ====================================================================

window.toggleMute =
  function() {

    isMuted =
      !isMuted;


    const btn =
      document.getElementById(
        'btn-mute'
      );


    if (btn) {

      btn.textContent =
        isMuted
          ? '🔇'
          : '🔊';


      btn.title =
        isMuted
          ? 'Unmute Audio Warnings'
          : 'Mute Audio Warnings';
    }
  };


// ── Proximity Warning ───────────────────────────────────────────────

function checkProximity(
  lat,
  lng
) {

  if (
    isMuted ||
    allPatholesData.length === 0
  ) {

    return;
  }


  allPatholesData.forEach(
    p => {

      const dist =
        getDistance(
          lat,
          lng,
          p.latitude,
          p.longitude
        );


      if (
        dist <= 50
      ) {

        if (
          !alertedPatholes.has(
            p.id
          )
        ) {

          alertedPatholes.add(
            p.id
          );


          playAlertSound();


          setTimeout(
            () => {

              speakAlert(
                `Warning: ${p.severity} severity pathole ahead.`
              );

            },
            400
          );
        }

      } else if (
        dist > 100
      ) {

        alertedPatholes.delete(
          p.id
        );
      }
    }
  );
}


// ── Distance Calculation ────────────────────────────────────────────

function getDistance(
  lat1,
  lon1,
  lat2,
  lon2
) {

  const R =
    6371e3;


  const phi1 =
    lat1 *
    Math.PI /
    180;


  const phi2 =
    lat2 *
    Math.PI /
    180;


  const deltaPhi =
    (
      lat2 -
      lat1
    ) *
    Math.PI /
    180;


  const deltaLambda =
    (
      lon2 -
      lon1
    ) *
    Math.PI /
    180;


  const a =

    Math.sin(
      deltaPhi / 2
    ) *
    Math.sin(
      deltaPhi / 2
    ) +

    Math.cos(
      phi1
    ) *
    Math.cos(
      phi2
    ) *

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
      Math.sqrt(
        1 - a
      )
    );


  return R * c;
}


// ── Alert Sound ─────────────────────────────────────────────────────

function playAlertSound() {

  try {

    const audioCtx =
      new (
        window.AudioContext ||
        window.webkitAudioContext
      )();


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
      'sine';


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

  } catch (e) {

    console.error(
      'AudioContext failed:',
      e
    );
  }
}


// ── Voice Alert ─────────────────────────────────────────────────────

function speakAlert(
  text
) {

  if (
    'speechSynthesis' in
    window
  ) {

    const utterance =
      new SpeechSynthesisUtterance(
        text
      );


    utterance.rate =
      1.0;


    utterance.volume =
      1.0;


    window.speechSynthesis.speak(
      utterance
    );
  }
}


// ====================================================================
// INITIAL LOAD
// ====================================================================

setupSearch();

loadPatholes();


// ── Auto-locate on load ─────────────────────────────────────────────

// This now requests REAL GPS only.
// There is NO simulated location fallback.

locateUser();


// ── Auto-refresh every 30 seconds ──────────────────────────────────

setInterval(
  refreshMap,
  30000
);