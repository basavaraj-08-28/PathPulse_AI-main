# 🛣️ PathPulse AI — Smart Pothole Detection & Mapping System

PathPulse AI is a modern, real-time web application designed to automatically detect road anomalies (specifically potholes) using a phone's built-in accelerometer and GPS sensors. It dynamically logs and pins detected hazards to a global interactive map, warning other road users and routing them safely around high-severity issues.

---

## 🌟 Key Features

*   **Real-time Sensor Processing:** Uses browser-level accelerometer access (`DeviceMotionEvent`) to calculate instantaneous vertical acceleration changes.
*   **Intelligent Severity Mapping:** Automatically categorizes road damage severity (Low, Medium, High) based on peak acceleration spikes (m/s²).
*   **GPS-driven Heatmaps:** Displays potholes on an interactive leaflet map with dynamic markers and popup overlays.
*   **Smart Clustering & Deduplication:** Avoids duplicate reports. Detections within a 20-meter threshold of an existing pothole increment its confidence score and count rather than creating new pins.
*   **Routing & Directions:** Integration with Leaflet Routing Machine to calculate route distances and display alternative pathways avoiding high-impact potholes.
*   **Integrated Location Search:** Search places and get routing using the Komoot Photon geocoder API.
*   **Interactive Simulation Fallback:** Safe desktop fallback simulator that automatically generates random road noise and occasional pothole spikes for testing and validation.
*   **Modern Premium Dashboard:** Designed with premium glassmorphism styling, a floating particle mesh background, interactive counters, and fluid CSS transitions.

---

## 🛠️ Technology Stack

### Backend
*   **Python & Flask:** Lightweight API framework.
*   **Flask-SQLAlchemy:** SQLite-backed ORM management.
*   **CORS Support:** Integrated cross-origin controls.

### Frontend
*   **Leaflet.js:** Open-source interactive map rendering.
*   **Leaflet Routing Machine:** Core route plotting and distance metrics.
*   **Vanilla JS & CSS:** Clean logic implementation with native CSS design systems (no heavy frameworks).
*   **Responsive Typography:** Integrated Inter & JetBrains Mono Google fonts.

---

## 📁 Project Directory Structure

```text
PathPulse_AI/
│
├── app.py                      # Core Flask server and API endpoints
├── requirements.txt            # Python environment dependencies
├── pathpulse.db                # SQLite database (automatically generated)
│
├── templates/                  # Frontend pages
│   ├── index.html              # Main dashboard overview and stats
│   ├── map.html                # Dedicated routing and pothole map
│   └── detect.html             # Mobile-optimized accelerometer logging page
│
└── static/                     # Assets and static code
    ├── css/
    │   └── style.css           # Custom CSS styling & variables (dark-mode UI colors)
    └── js/
        ├── dashboard.js        # Main dashboard metrics loader
        ├── detect.js           # Client-side sensor capture & reporting engine
        └── map.js              # Dedicated interactive maps and routing control
```

---

## ⚙️ How it Works

### 1. Acceleration Physics & Detection
The application samples device movements along three coordinates ($X$, $Y$, and $Z$) via the `DeviceMotionEvent` listener:

$$\text{Magnitude} = \sqrt{x^2 + y^2 + z^2}$$
$$\text{Deviation} = |\text{Magnitude} - g|$$

where $g \approx 9.81 \text{ m/s}^2$ representing the baseline acceleration due to gravity. 
*   **Low Impact:** $\text{Deviation} < 15 \text{ m/s}^2$
*   **Medium Impact:** $15 \text{ m/s}^2 \le \text{Deviation} < 25 \text{ m/s}^2$
*   **High Impact (Dangerous):** $\text{Deviation} \ge 25 \text{ m/s}^2$

### 2. Proximity Clustering
To prevent map spamming:
*   When a pothole is detected at $(Lat, Lng)$, the server checks if another active pothole exists within a threshold range of `0.0002` coordinates (approximately 20 meters).
*   If found, the server updates the existing pothole record, increasing the count: `report_count += 1` and scaling confidence: `confidence = min(1.0, confidence + 0.1)`.
*   If the pothole is reported more than 5 times, it is upgraded to **Medium** severity. More than 10 times is upgraded to **High** severity.

---

## 🚀 Getting Started

### Prerequisites
Make sure you have **Python 3.8+** installed on your machine.

### Installation & Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/PathPulse_AI.git
    cd PathPulse_AI
    ```

2.  **Create and activate a virtual environment (Recommended):**
    *   **Windows (PowerShell):**
        ```powershell
        python -m venv env
        .\env\Scripts\Activate.ps1
        ```
    *   **macOS / Linux:**
        ```bash
        python3 -m venv env
        source env/bin/activate
        ```

3.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```

4.  **Run the Flask application:**
    ```bash
    python app.py
    ```
    The server will startup locally at **`http://127.0.5000`** (or port configured inside `app.py`).

---

## 🔌 API Reference

### 1. Get Potholes
*   **Endpoint:** `GET /api/potholes`
*   **Query Params (Optional - Bounding Box):** `lat_min`, `lat_max`, `lng_min`, `lng_max`
*   **Response:**
    ```json
    {
      "status": "success",
      "count": 1,
      "potholes": [
        {
          "id": 1,
          "latitude": 13.0827,
          "longitude": 80.2707,
          "severity": "medium",
          "confidence": 0.7,
          "reported_by": "anonymous",
          "report_count": 1,
          "accel_peak": 18.5,
          "created_at": "2026-07-07T13:00:00Z",
          "updated_at": "2026-07-07T13:00:00Z",
          "is_active": true
        }
      ]
    }
    ```

### 2. Report a Pothole
*   **Endpoint:** `POST /api/potholes`
*   **Request Body:**
    ```json
    {
      "latitude": 13.0827,
      "longitude": 80.2707,
      "accel_peak": 19.2,
      "confidence": 0.48
    }
    ```
*   **Response:**
    ```json
    {
      "status": "success",
      "message": "New pothole reported",
      "pothole": { ... }
    }
    ```

### 3. Resolve a Pothole
Marks a reported pothole as resolved/fixed (soft deletes it from live viewing layers).
*   **Endpoint:** `POST /api/potholes/<int:pothole_id>/resolve`
*   **Response:**
    ```json
    {
      "status": "success",
      "message": "Pothole marked as resolved"
    }
    ```

### 4. Fetch Statistics
Returns aggregate dashboard metrics.
*   **Endpoint:** `GET /api/stats`
*   **Response:**
    ```json
    {
      "status": "success",
      "stats": {
        "active_potholes": 12,
        "high_severity": 3,
        "resolved": 5,
        "total_reported": 17
      }
    }
    ```

---

## 🎮 Desktop Simulation Testing

For developer testing on desktops without real accelerometer support:
1.  Navigate to the `/detect` page and click **Start**.
2.  The application will automatically detect the absence of accelerometer data and switch to **Simulation Mode**.
3.  Simulated road vibration values will populate the dashboard metrics, with a 5% chance of generating a pothole detection event on randomized geographic offsets.

---

## 🛡️ License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.