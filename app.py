"""
PathPulse AI - Pothole Detection & Mapping System
Backend API built with Flask
"""

from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from datetime import datetime, timezone
import os

app = Flask(__name__)
CORS(app)

# Database configuration
basedir = os.path.abspath(os.path.dirname(__file__))
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(basedir, 'pathpulse.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = 'pathpulse-secret-key-2026'

db = SQLAlchemy(app)


# ─── Models ───────────────────────────────────────────────────────────────────

class Pothole(db.Model):
    """Stores detected pothole locations"""
    id = db.Column(db.Integer, primary_key=True)
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)
    severity = db.Column(db.String(20), nullable=False, default='medium')  # low, medium, high
    confidence = db.Column(db.Float, nullable=False, default=0.5)
    reported_by = db.Column(db.String(100), default='anonymous')
    report_count = db.Column(db.Integer, default=1)
    accel_peak = db.Column(db.Float, nullable=True)  # peak acceleration value
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc),
                           onupdate=lambda: datetime.now(timezone.utc))
    is_active = db.Column(db.Boolean, default=True)

    def to_dict(self):
        return {
            'id': self.id,
            'latitude': self.latitude,
            'longitude': self.longitude,
            'severity': self.severity,
            'confidence': self.confidence,
            'reported_by': self.reported_by,
            'report_count': self.report_count,
            'accel_peak': self.accel_peak,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'is_active': self.is_active
        }


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    """Serve the main application page"""
    return render_template('index.html')


@app.route('/map')
def map_page():
    """Serve the dedicated map page"""
    return render_template('map.html')


@app.route('/detect')
def detect():
    """Serve the detection/ride mode page"""
    return render_template('detect.html')


@app.route('/admin')
def admin_page():
    """Serve the admin portal page"""
    return render_template('admin.html')


@app.route('/api/admin/login', methods=['POST'])
def admin_login():
    """Authenticate admin credentials and set session"""
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')

    expected_user = os.getenv('ADMIN_USER', 'basavarajyn123@gmail.com')
    expected_pass = os.getenv('ADMIN_PASSWORD', 'admin123')

    if username == expected_user and password == expected_pass:
        session['admin_logged_in'] = True
        return jsonify({'status': 'success', 'message': 'Logged in successfully'})
    return jsonify({'status': 'error', 'message': 'Invalid credentials'}), 401


@app.route('/api/admin/logout', methods=['POST'])
def admin_logout():
    """Clear admin session"""
    session.pop('admin_logged_in', None)
    return jsonify({'status': 'success', 'message': 'Logged out successfully'})


@app.route('/api/admin/check', methods=['GET'])
def admin_check():
    """Verify if admin session is active"""
    is_logged_in = session.get('admin_logged_in', False)
    return jsonify({'logged_in': is_logged_in})


@app.route('/api/potholes', methods=['GET'])
def get_potholes():
    """Get potholes, optionally filtered by bounds and active status"""
    lat_min = request.args.get('lat_min', type=float)
    lat_max = request.args.get('lat_max', type=float)
    lng_min = request.args.get('lng_min', type=float)
    lng_max = request.args.get('lng_max', type=float)
    status = request.args.get('status', 'active')  # active, resolved, all

    if status == 'active':
        query = Pothole.query.filter_by(is_active=True)
    elif status == 'resolved':
        query = Pothole.query.filter_by(is_active=False)
    else:
        query = Pothole.query

    if all(v is not None for v in [lat_min, lat_max, lng_min, lng_max]):
        query = query.filter(
            Pothole.latitude.between(lat_min, lat_max),
            Pothole.longitude.between(lng_min, lng_max)
        )

    potholes = query.order_by(Pothole.created_at.desc()).all()
    return jsonify({
        'status': 'success',
        'count': len(potholes),
        'potholes': [p.to_dict() for p in potholes]
    })


@app.route('/api/potholes', methods=['POST'])
def report_pothole():
    """Report a new pothole detected by accelerometer"""
    data = request.get_json()

    if not data or 'latitude' not in data or 'longitude' not in data:
        return jsonify({'status': 'error', 'message': 'latitude and longitude are required'}), 400

    lat = data['latitude']
    lng = data['longitude']

    # Check if a pothole already exists nearby (within ~20 meters)
    THRESHOLD = 0.0002  # roughly 20 meters
    existing = Pothole.query.filter(
        Pothole.latitude.between(lat - THRESHOLD, lat + THRESHOLD),
        Pothole.longitude.between(lng - THRESHOLD, lng + THRESHOLD),
        Pothole.is_active == True
    ).first()

    if existing:
        # Increase report count and confidence
        existing.report_count += 1
        existing.confidence = min(1.0, existing.confidence + 0.1)
        # Upgrade severity if reported many times
        if existing.report_count >= 10:
            existing.severity = 'high'
        elif existing.report_count >= 5:
            existing.severity = 'medium'
        existing.updated_at = datetime.now(timezone.utc)
        db.session.commit()
        return jsonify({
            'status': 'success',
            'message': 'Existing pothole report updated',
            'pothole': existing.to_dict()
        })

    # Determine severity from acceleration peak
    accel_peak = data.get('accel_peak', 0)
    if accel_peak >= 25:
        severity = 'high'
    elif accel_peak >= 15:
        severity = 'medium'
    else:
        severity = 'low'

    pothole = Pothole(
        latitude=lat,
        longitude=lng,
        severity=severity,
        confidence=data.get('confidence', 0.6),
        reported_by=data.get('reported_by', 'anonymous'),
        accel_peak=accel_peak
    )
    db.session.add(pothole)
    db.session.commit()

    return jsonify({
        'status': 'success',
        'message': 'New pothole reported',
        'pothole': pothole.to_dict()
    }), 201


@app.route('/api/potholes/<int:pothole_id>/resolve', methods=['POST'])
def resolve_pothole(pothole_id):
    """Mark a pothole as resolved/fixed"""
    if not session.get('admin_logged_in'):
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    pothole = Pothole.query.get_or_404(pothole_id)
    pothole.is_active = False
    pothole.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify({'status': 'success', 'message': 'Pothole marked as resolved'})


@app.route('/api/potholes/<int:pothole_id>/edit', methods=['POST', 'PUT'])
def edit_pothole(pothole_id):
    """Update pothole details"""
    if not session.get('admin_logged_in'):
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    
    pothole = Pothole.query.get_or_404(pothole_id)
    data = request.get_json() or {}
    
    try:
        pothole.latitude = float(data['latitude'])
        pothole.longitude = float(data['longitude'])
        pothole.severity = data.get('severity', pothole.severity)
        pothole.confidence = float(data.get('confidence', pothole.confidence))
        pothole.is_active = bool(data.get('is_active', pothole.is_active))
        pothole.updated_at = datetime.now(timezone.utc)
        
        db.session.commit()
        return jsonify({
            'status': 'success', 
            'message': 'Pothole updated successfully',
            'pothole': pothole.to_dict()
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400


@app.route('/api/potholes/<int:pothole_id>/delete', methods=['DELETE', 'POST'])
def delete_pothole(pothole_id):
    """Permanently delete a pothole report"""
    if not session.get('admin_logged_in'):
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    
    pothole = Pothole.query.get_or_404(pothole_id)
    db.session.delete(pothole)
    db.session.commit()
    return jsonify({'status': 'success', 'message': 'Pothole deleted permanently'})


@app.route('/api/stats', methods=['GET'])
def get_stats():
    """Get system statistics with breakdown details for visualization charts"""
    total = Pothole.query.count()
    active = Pothole.query.filter_by(is_active=True).count()
    resolved = total - active
    high_severity = Pothole.query.filter_by(is_active=True, severity='high').count()

    # Severity distribution
    low_count = Pothole.query.filter_by(is_active=True, severity='low').count()
    med_count = Pothole.query.filter_by(is_active=True, severity='medium').count()
    high_count = Pothole.query.filter_by(is_active=True, severity='high').count()

    # Timeline stats (last 7 days)
    from datetime import timedelta
    seven_days_ago = datetime.now(timezone.utc) - timedelta(days=7)

    daily_reports = db.session.query(
        db.func.date(Pothole.created_at).label('date_str'),
        db.func.count(Pothole.id).label('cnt')
    ).filter(Pothole.created_at >= seven_days_ago)\
     .group_by(db.func.date(Pothole.created_at))\
     .order_by('date_str').all()

    timeline = {row.date_str: row.cnt for row in daily_reports if row.date_str is not None}

    chart_labels = []
    chart_data = []
    for i in range(6, -1, -1):
        d = (datetime.now(timezone.utc) - timedelta(days=i))
        d_str = d.strftime('%Y-%m-%d')
        chart_labels.append(d.strftime('%a'))  # e.g. Mon, Tue
        chart_data.append(timeline.get(d_str, 0))

    return jsonify({
        'status': 'success',
        'stats': {
            'total_reported': total,
            'active_potholes': active,
            'resolved': resolved,
            'high_severity': high_severity,
            'severity_distribution': {
                'low': low_count,
                'medium': med_count,
                'high': high_count
            },
            'weekly_timeline': {
                'labels': chart_labels,
                'data': chart_data
            }
        }
    })


# ─── Initialize ──────────────────────────────────────────────────────────────

with app.app_context():
    db.create_all()

if __name__ == '__main__':
    app.run(debug=True, port=5000)



from flask import send_from_directory

@app.route('/manifest.json')
def manifest():
    return send_from_directory('.', 'manifest.json')

@app.route('/service-worker.js')
def service_worker():
    return send_from_directory('.', 'service-worker.js')
