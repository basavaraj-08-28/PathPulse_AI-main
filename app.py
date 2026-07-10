"""
PathPulse AI - Pathole Detection & Mapping System
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

class Pathole(db.Model):
    """Stores detected pathole locations"""
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


@app.route('/api/patholes', methods=['GET'])
def get_patholes():
    """Get patholes, optionally filtered by bounds and active status"""
    lat_min = request.args.get('lat_min', type=float)
    lat_max = request.args.get('lat_max', type=float)
    lng_min = request.args.get('lng_min', type=float)
    lng_max = request.args.get('lng_max', type=float)
    status = request.args.get('status', 'active')  # active, resolved, all

    if status == 'active':
        query = Pathole.query.filter_by(is_active=True)
    elif status == 'resolved':
        query = Pathole.query.filter_by(is_active=False)
    else:
        query = Pathole.query

    if all(v is not None for v in [lat_min, lat_max, lng_min, lng_max]):
        query = query.filter(
            Pathole.latitude.between(lat_min, lat_max),
            Pathole.longitude.between(lng_min, lng_max)
        )

    patholes = query.order_by(Pathole.created_at.desc()).all()
    return jsonify({
        'status': 'success',
        'count': len(patholes),
        'patholes': [p.to_dict() for p in patholes]
    })


@app.route('/api/patholes', methods=['POST'])
def report_pathole():
    """Report a new pathole detected by accelerometer"""
    data = request.get_json()

    if not data or 'latitude' not in data or 'longitude' not in data:
        return jsonify({'status': 'error', 'message': 'latitude and longitude are required'}), 400

    lat = data['latitude']
    lng = data['longitude']

    # Check if a pathole already exists nearby (within ~20 meters)
    THRESHOLD = 0.0002  # roughly 20 meters
    existing = Pathole.query.filter(
        Pathole.latitude.between(lat - THRESHOLD, lat + THRESHOLD),
        Pathole.longitude.between(lng - THRESHOLD, lng + THRESHOLD),
        Pathole.is_active == True
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
            'message': 'Existing pathole report updated',
            'pathole': existing.to_dict()
        })

    # Determine severity from acceleration peak
    accel_peak = data.get('accel_peak', 0)
    if accel_peak >= 25:
        severity = 'high'
    elif accel_peak >= 15:
        severity = 'medium'
    else:
        severity = 'low'

    pathole = Pathole(
        latitude=lat,
        longitude=lng,
        severity=severity,
        confidence=data.get('confidence', 0.6),
        reported_by=data.get('reported_by', 'anonymous'),
        accel_peak=accel_peak
    )
    db.session.add(pathole)
    db.session.commit()

    return jsonify({
        'status': 'success',
        'message': 'New pathole reported',
        'pathole': pathole.to_dict()
    }), 201


@app.route('/api/patholes/<int:pathole_id>/resolve', methods=['POST'])
def resolve_pathole(pathole_id):
    """Mark a pathole as resolved/fixed"""
    if not session.get('admin_logged_in'):
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    pathole = Pathole.query.get_or_404(pathole_id)
    pathole.is_active = False
    pathole.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify({'status': 'success', 'message': 'Pathole marked as resolved'})


@app.route('/api/patholes/<int:pathole_id>/edit', methods=['POST', 'PUT'])
def edit_pathole(pathole_id):
    """Update pathole details"""
    if not session.get('admin_logged_in'):
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    
    pathole = Pathole.query.get_or_404(pathole_id)
    data = request.get_json() or {}
    
    try:
        pathole.latitude = float(data['latitude'])
        pathole.longitude = float(data['longitude'])
        pathole.severity = data.get('severity', pathole.severity)
        pathole.confidence = float(data.get('confidence', pathole.confidence))
        pathole.is_active = bool(data.get('is_active', pathole.is_active))
        pathole.updated_at = datetime.now(timezone.utc)
        
        db.session.commit()
        return jsonify({
            'status': 'success', 
            'message': 'Pathole updated successfully',
            'pathole': pathole.to_dict()
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400


@app.route('/api/patholes/<int:pathole_id>/delete', methods=['DELETE', 'POST'])
def delete_pathole(pathole_id):
    """Permanently delete a pathole report"""
    if not session.get('admin_logged_in'):
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    
    pathole = Pathole.query.get_or_404(pathole_id)
    db.session.delete(pathole)
    db.session.commit()
    return jsonify({'status': 'success', 'message': 'Pathole deleted permanently'})


@app.route('/api/stats', methods=['GET'])
def get_stats():
    """Get system statistics with breakdown details for visualization charts"""
    total = Pathole.query.count()
    active = Pathole.query.filter_by(is_active=True).count()
    resolved = total - active
    high_severity = Pathole.query.filter_by(is_active=True, severity='high').count()

    # Severity distribution
    low_count = Pathole.query.filter_by(is_active=True, severity='low').count()
    med_count = Pathole.query.filter_by(is_active=True, severity='medium').count()
    high_count = Pathole.query.filter_by(is_active=True, severity='high').count()

    # Timeline stats (last 7 days)
    from datetime import timedelta
    seven_days_ago = datetime.now(timezone.utc) - timedelta(days=7)

    daily_reports = db.session.query(
        db.func.date(Pathole.created_at).label('date_str'),
        db.func.count(Pathole.id).label('cnt')
    ).filter(Pathole.created_at >= seven_days_ago)\
     .group_by(db.func.date(Pathole.created_at))\
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
            'active_patholes': active,
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
