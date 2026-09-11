"""
Test suite for PathPulse AI Pothole Storage & Deduplication Logic
"""
import os
import unittest
from unittest.mock import patch

# Mock Turso sync before importing app
import app as main_app
from app import app, db, Pathole, haversine_distance_meters

class TestPotholeDeduplication(unittest.TestCase):
    def setUp(self):
        self.app = app
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

        # Patch sync_to_turso so tests don't write to remote cloud
        self.turso_patcher = patch('app.sync_to_turso', return_value=None)
        self.mock_turso = self.turso_patcher.start()

        with self.app.app_context():
            db.create_all()
            # Ensure clean database for every test
            Pathole.query.delete()
            db.session.commit()

        # Log in as admin in session
        with self.client.session_transaction() as sess:
            sess['admin_logged_in'] = True

    def tearDown(self):
        self.turso_patcher.stop()
        with self.app.app_context():
            Pathole.query.delete()
            db.session.commit()

    def test_haversine_formula(self):
        lat1, lon1 = 12.971599, 77.594566
        # 8 meters north: ~0.000072 degrees
        lat2, lon2 = 12.971671, 77.594566
        dist = haversine_distance_meters(lat1, lon1, lat2, lon2)
        self.assertAlmostEqual(dist, 8.0, delta=0.5)

    def test_two_potholes_8_meters_apart_are_stored_separately(self):
        """Two potholes 8 meters apart must be stored as separate records"""
        lat1, lng1 = 12.971599, 77.594566
        # 8 meters north
        lat2, lng2 = 12.971671, 77.594566

        # Report Pothole 1
        res1 = self.client.post('/api/patholes', json={
            'latitude': lat1,
            'longitude': lng1,
            'severity': 'medium',
            'accel_peak': 18.5,
            'confidence': 0.7
        })
        self.assertEqual(res1.status_code, 201)
        data1 = res1.get_json()
        p1_id = data1['pathole']['id']

        # Report Pothole 2 (8 meters away)
        res2 = self.client.post('/api/patholes', json={
            'latitude': lat2,
            'longitude': lng2,
            'severity': 'high',
            'accel_peak': 26.0,
            'confidence': 0.85
        })
        self.assertEqual(res2.status_code, 201)
        data2 = res2.get_json()
        p2_id = data2['pathole']['id']

        # Assert two distinct database records exist
        self.assertNotEqual(p1_id, p2_id)
        with self.app.app_context():
            all_potholes = Pathole.query.all()
            self.assertEqual(len(all_potholes), 2)
            self.assertEqual(all_potholes[0].report_count, 1)
            self.assertEqual(all_potholes[1].report_count, 1)

    def test_repeated_detection_of_same_pothole_updates_count(self):
        """Multiple detections of the same pothole within GPS variance (<3m) update report_count"""
        lat, lng = 12.971599, 77.594566

        # First detection
        res1 = self.client.post('/api/patholes', json={
            'latitude': lat,
            'longitude': lng,
            'severity': 'low',
            'accel_peak': 12.0
        })
        self.assertEqual(res1.status_code, 201)
        p_id = res1.get_json()['pathole']['id']

        # Repeated detection (same spot + 0.5m GPS variance)
        res2 = self.client.post('/api/patholes', json={
            'latitude': lat + 0.000004,
            'longitude': lng + 0.000003,
            'severity': 'medium',
            'accel_peak': 17.5
        })
        self.assertEqual(res2.status_code, 200)
        data2 = res2.get_json()
        self.assertTrue(data2.get('duplicate'))
        self.assertEqual(data2['pathole']['id'], p_id)
        self.assertEqual(data2['pathole']['report_count'], 2)

        # Third detection (same spot - 0.3m GPS variance)
        res3 = self.client.post('/api/patholes', json={
            'latitude': lat - 0.000002,
            'longitude': lng - 0.000001,
            'severity': 'high',
            'accel_peak': 27.0
        })
        self.assertEqual(res3.status_code, 200)
        data3 = res3.get_json()
        self.assertEqual(data3['pathole']['id'], p_id)
        self.assertEqual(data3['pathole']['report_count'], 3)
        self.assertEqual(data3['pathole']['severity'], 'high')
        self.assertEqual(data3['pathole']['accel_peak'], 27.0)

        with self.app.app_context():
            all_potholes = Pathole.query.all()
            self.assertEqual(len(all_potholes), 1)
            self.assertEqual(all_potholes[0].report_count, 3)

    def test_three_consecutive_close_potholes(self):
        """Pothole 1 -> 8m -> Pothole 2 -> 5m -> Pothole 3 must result in 3 database records"""
        lat1, lng1 = 12.971599, 77.594566
        # Pothole 2 is 8 meters away
        lat2, lng2 = 12.971671, 77.594566
        # Pothole 3 is 5 meters away from P2 (13m from P1)
        lat3, lng3 = 12.971716, 77.594566

        r1 = self.client.post('/api/patholes', json={'latitude': lat1, 'longitude': lng1, 'severity': 'medium', 'accel_peak': 16.0})
        r2 = self.client.post('/api/patholes', json={'latitude': lat2, 'longitude': lng2, 'severity': 'high', 'accel_peak': 25.0})
        r3 = self.client.post('/api/patholes', json={'latitude': lat3, 'longitude': lng3, 'severity': 'low', 'accel_peak': 14.0})

        self.assertEqual(r1.status_code, 201)
        self.assertEqual(r2.status_code, 201)
        self.assertEqual(r3.status_code, 201)

        with self.app.app_context():
            all_p = Pathole.query.order_by(Pathole.id.asc()).all()
            self.assertEqual(len(all_p), 3)
            self.assertEqual(all_p[0].id, r1.get_json()['pathole']['id'])
            self.assertEqual(all_p[1].id, r2.get_json()['pathole']['id'])
            self.assertEqual(all_p[2].id, r3.get_json()['pathole']['id'])

    def test_edge_cases_5m_15m_25m(self):
        """Test Case 2 (5m), Case 3 (15m), Case 4 (25m)"""
        base_lat, base_lng = 12.971599, 77.594566
        # Case 2: 5m apart
        p1_res = self.client.post('/api/patholes', json={'latitude': base_lat, 'longitude': base_lng, 'severity': 'medium', 'accel_peak': 15.0})
        # 5m north (~0.000045 deg)
        p2_res = self.client.post('/api/patholes', json={'latitude': base_lat + 0.000045, 'longitude': base_lng, 'severity': 'medium', 'accel_peak': 16.0})
        self.assertEqual(p1_res.status_code, 201)
        self.assertEqual(p2_res.status_code, 201)

        # Case 3: 15m apart (~0.000135 deg)
        p3_res = self.client.post('/api/patholes', json={'latitude': base_lat + 0.000045 + 0.000135, 'longitude': base_lng, 'severity': 'high', 'accel_peak': 26.0})
        self.assertEqual(p3_res.status_code, 201)

        # Case 4: 25m apart (~0.000225 deg)
        p4_res = self.client.post('/api/patholes', json={'latitude': base_lat + 0.000045 + 0.000135 + 0.000225, 'longitude': base_lng, 'severity': 'low', 'accel_peak': 12.0})
        self.assertEqual(p4_res.status_code, 201)

        with self.app.app_context():
            all_p = Pathole.query.all()
            self.assertEqual(len(all_p), 4)

    def test_multi_user_report_on_same_physical_pothole(self):
        """Case 5: Multi-user reporting behavior preserves single record for the same physical pothole"""
        lat, lng = 12.971599, 77.594566
        # User 1 reports
        r1 = self.client.post('/api/patholes', json={'latitude': lat, 'longitude': lng, 'reported_by': 'Driver_Alice', 'accel_peak': 16.0})
        self.assertEqual(r1.status_code, 201)

        # User 2 reports same physical spot (1.1 meters away)
        r2 = self.client.post('/api/patholes', json={'latitude': lat + 0.00001, 'longitude': lng, 'reported_by': 'Driver_Bob', 'accel_peak': 22.0})
        self.assertEqual(r2.status_code, 200)

        with self.app.app_context():
            potholes = Pathole.query.all()
            self.assertEqual(len(potholes), 1)
            self.assertEqual(potholes[0].report_count, 2)
            self.assertEqual(potholes[0].accel_peak, 22.0)


if __name__ == '__main__':
    unittest.main()
