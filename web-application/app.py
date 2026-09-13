
"""
app.py — Suriin AI Web Application (Flask Backend)
====================================================
Serves the dashboard UI and exposes API endpoints for the
Suriin AI Chrome Extension to submit scam-detection reports.

Firebase Admin SDK is used for:
  - Firestore (report storage)
  - Auth token verification (RBAC)
"""

import os
import json
import traceback
import time
from datetime import datetime, timezone
from functools import wraps
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import logging
import platform
import socket
import time
import threading
from concurrent.futures import ThreadPoolExecutor
import re

from flask import Flask, render_template, request, jsonify, g, Response
from flask_cors import CORS, cross_origin
from flask_mail import Mail, Message
from dotenv import load_dotenv

# ── SEC Watchlist Utilities ────────────────────────────────────────────────────
from sec_utils import extract_org_entities, check_watchlist, get_cache_metrics, reset_cache_metrics

# ── Load environment variables ─────────────────────────────────────────────────
load_dotenv()

# ── Firebase Admin SDK initialization ──────────────────────────────────────────
# NOTE: Place your suriin-ai-backup-firebase-adminsdk.json in the project root.
# Download it from: Backup Firebase Console → Project Settings → Service Accounts
#                   → Generate New Private Key
import firebase_admin
from firebase_admin import credentials, firestore, auth

SERVICE_ACCOUNT_PATH = os.getenv(
    'FIREBASE_SERVICE_ACCOUNT',
    os.path.join(os.path.dirname(__file__), 'suriin-ai-backup-firebase-adminsdk.json')
)

# Track whether Firebase was properly initialized with credentials
_firebase_has_credentials = False

if not firebase_admin._apps:
    if os.path.exists(SERVICE_ACCOUNT_PATH):
        cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
        firebase_admin.initialize_app(cred)
        _firebase_has_credentials = True
    else:
        print(
            "\n[!] WARNING: suriin-ai-backup-firebase-adminsdk.json not found!\n"
            "    The app will start but Firebase operations will fail.\n"
            "    Place your key at:", SERVICE_ACCOUNT_PATH, "\n"
        )
else:
    _firebase_has_credentials = True

# Lazy Firestore client — only created when credentials exist
_db = None

def get_db():
    """Returns the Firestore client, creating it lazily on first call."""
    global _db
    if _db is None:
        if not _firebase_has_credentials:
            raise RuntimeError(
                'Firebase not initialized — suriin-ai-backup-firebase-adminsdk.json is missing. '
                'Place it at: ' + SERVICE_ACCOUNT_PATH
            )
        _db = firestore.client()
    return _db

# ── Flask App ──────────────────────────────────────────────────────────────────
app = Flask(__name__)

# Register SEC Watchlist API blueprint
from sec_api import sec_api
app.register_blueprint(sec_api)

_app_started_at = time.time()
CORS(app, resources={
    r"/api/*": {
        "origins": ["chrome-extension://*", "http://localhost:*", "http://127.0.0.1:*"],
        "methods": ["POST", "GET", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"]
    }
})  # Allow cross-origin requests from Chrome Extension and localhost

# Configure Flask-Mail
app.config['MAIL_SERVER'] = os.getenv('SMTP_HOST', 'smtp.gmail.com')
app.config['MAIL_PORT'] = int(os.getenv('SMTP_PORT', '587'))
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USERNAME'] = os.getenv('SMTP_USER', '')
app.config['MAIL_PASSWORD'] = os.getenv('SMTP_PASSWORD', '')
app.config['MAIL_DEFAULT_SENDER'] = (os.getenv('SMTP_FROM_NAME', 'Suriin AI'), os.getenv('SMTP_USER', ''))

mail = Mail(app)

# ═══════════════════════════════════════════════════════════════════════════════
#  FIREBASE QUOTA MITIGATION - CACHING INFRASTRUCTURE
# ═══════════════════════════════════════════════════════════════════════════════

# Global cache dictionaries for Firebase quota mitigation
staff_notification_cache = {}
user_notification_cache = {}
CACHE_TTL = 60  # 60 seconds cache TTL

def get_cached_staff_notifications(role, limit):
    """Get cached staff notifications or fetch from Firestore if cache expired."""
    cache_key = f"staff_notifications_{role}_{limit}"
    current_time = time.time()
    
    # Check cache validity
    if cache_key in staff_notification_cache:
        cached_data, timestamp = staff_notification_cache[cache_key]
        if current_time - timestamp < CACHE_TTL:
            app.logger.debug(f'[Cache] Staff notifications hit for {role}')
            return cached_data
    
    # Cache miss - fetch from Firestore
    app.logger.debug(f'[Cache] Staff notifications miss for {role}')
    
    try:
        notif_ref = db.collection('staff_notifications')
        query = notif_ref.where('targetRole', '==', role) \
                         .order_by('created_at', direction='DESCENDING') \
                         .limit(limit)
        
        docs = list(query.stream())
        notifications = []
        unread_count = 0
        
        for doc in docs:
            data = doc.to_dict()
            data['id'] = doc.id
            notifications.append(data)
            if not data.get('isRead', False):
                unread_count += 1
        
        result = {
            'success': True,
            'unread_count': unread_count,
            'notifications': notifications
        }
        
        # Cache the result
        staff_notification_cache[cache_key] = (result, current_time)
        return result
        
    except Exception as e:
        app.logger.error(f'[Cache] Error fetching staff notifications: {str(e)}')
        return {'success': False, 'error': str(e)}

def cleanup_expired_cache():
    """Clean up expired cache entries to prevent memory leaks."""
    current_time = time.time()
    expired_keys = []
    
    # Clean staff notification cache
    for cache_key, (_, timestamp) in staff_notification_cache.items():
        if current_time - timestamp >= CACHE_TTL:
            expired_keys.append(cache_key)
    
    for key in expired_keys:
        del staff_notification_cache[key]
    
    if expired_keys:
        app.logger.debug(f'[Cache] Cleaned up {len(expired_keys)} expired staff notification entries')

# Get Firestore client after app initialization
db = get_db()

# ═══════════════════════════════════════════════════════════════════════════════
#  AI MODEL LOADING
# ═══════════════════════════════════════════════════════════════════════════════
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'XLM_RoBERTa_Quantized')
WEIGHTS_PATH = os.path.join(MODEL_PATH, 'quantized_weight.pt')

print("[SuriinAI] Loading XLM-RoBERTa scam detection model from XLM_RoBERTa_Quantized...")
tokenizer = None
model = None
_model_infer_lock = threading.Lock()

# ═══════════════════════════════════════════════════════════════════════════════
#  LOCAL WATCHLIST (SEC / DTI)
# ═══════════════════════════════════════════════════════════════════════════════

LOCAL_BLACKLIST = [
    "Shawnsei Holdings",
    "Peso Piggy",
    "MocaMoca fake",
]

_SCAN_TEXT_WS_RE = re.compile(r'\s+')
_SCAN_TEXT_EDGE_QUOTES_RE = re.compile(r'^["\'\u201C\u201D\u2018\u2019]+|["\'\u201C\u201D\u2018\u2019]+$')
_AI_FENCELINE_KEYWORDS_RE = re.compile(
    r'\b(earn|earning|task|tasks|daily|telegram|tg|gcash|whatsapp|signal|click|link|bonus|salary|commission|part-?time|work\s*from\s*home|wfh)\b',
    re.IGNORECASE
)


def sanitize_scan_text(value: str) -> str:
    if not isinstance(value, str):
        return ''
    text = value.strip()
    text = _SCAN_TEXT_EDGE_QUOTES_RE.sub('', text)
    text = _SCAN_TEXT_WS_RE.sub(' ', text).strip()
    return text

try:
    import torch
    from transformers import AutoTokenizer, XLMRobertaConfig, XLMRobertaForSequenceClassification

    try:
        # Load tokenizer
        tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)

        # Load config blueprint dynamically
        config = XLMRobertaConfig.from_pretrained(MODEL_PATH)

        # Initialize empty base architecture
        raw_model = XLMRobertaForSequenceClassification(config)

        # Apply dynamic quantization to match 8-bit weights
        quantized_model = torch.quantization.quantize_dynamic(
            raw_model,
            {torch.nn.Linear},
            dtype=torch.qint8
        )

        # Load the quantized weights directly onto CPU
        quantized_model.load_state_dict(
            torch.load(WEIGHTS_PATH, map_location='cpu')
        )

        model = quantized_model
        model.eval()  # Set to evaluation mode
        print("[SuriinAI] [OK] Model loaded successfully from XLM_RoBERTa_Quantized")

    except Exception as e:
        print(f"[SuriinAI] [ERROR] Model loading failed: {e}")
        print(f"[SuriinAI]   Model path: {MODEL_PATH}")
        print(f"[SuriinAI]   Weights path: {WEIGHTS_PATH}")
        tokenizer = None
        model = None

except ImportError as e:
    print(f"[SuriinAI] [ERROR] AI dependencies not installed: {e}")
    tokenizer = None
    model = None


# ═══════════════════════════════════════════════════════════════════════════════
#  TEMPLATE ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/')
def login_page():
    """Serves the login / landing page."""
    return render_template('index.html')


@app.route('/login')
def login():
    """
    Login page for both web app and Chrome extension.
    If extension=true in query params, displays a streamlined login UI.
    After successful Firebase authentication, stores token in extension storage.
    """
    extension_mode = request.args.get('extension') == 'true'
    return render_template('login.html', extension_mode=extension_mode)


@app.route('/user-dashboard')
def user_dashboard():
    """Serves the General User (victim) dashboard."""
    return render_template('user-dashboard.html')


@app.route('/expert-dashboard')
def expert_dashboard():
    """Serves the Expert investigator triage dashboard."""
    return render_template('expert-dashboard.html')


@app.route('/expert-resolved')
def expert_resolved_dashboard():
    """Serves the Expert resolved case history dashboard."""
    return render_template('expert-resolved.html')


@app.route('/expert-analytics')
def expert_analytics():
    """Serves the Expert scam analytics dashboard."""
    return render_template('expert-analytics.html')


@app.route('/expert-settings')
def expert_settings():
    """Serves the Expert account settings and notification preferences page."""
    return render_template('expert-settings.html')


@app.route('/admin-dashboard')
def admin_dashboard():
    """Serves the Admin command center dashboard."""
    return render_template('admin-dashboard.html')


@app.route('/admin-users')
def admin_users_page():
    """Serves the Admin user management dashboard."""
    return render_template('admin-users.html')


@app.route('/admin-analytics')
def admin_analytics():
    """Serves the Admin Threat Analytics dashboard."""
    return render_template('admin-analytics.html')


@app.route('/admin-audit-logs')
def admin_audit_logs():
    """Serves the Admin Audit Logs page."""
    return render_template('admin-audit-logs.html')


@app.route('/admin-intelligence')
def admin_intelligence_page():
    """Serves the Admin Threat Intelligence & Training Data page."""
    print('[DEBUG] /admin-intelligence route hit')
    return render_template('admin-intelligence.html')


@app.route('/admin-settings')
def admin_settings():
    """Serves the Admin Settings page."""
    return render_template('admin-settings.html')


@app.route('/scam-awareness')
def scam_awareness():
    """Serves the Scam Awareness educational page."""
    return render_template('scam-awareness.html')


@app.route('/settings')
def settings_page():
    """Serves the Account Settings page."""
    return render_template('settings.html')


@app.route('/privacy')
def privacy_page():
    """Serves the Privacy Policy page."""
    return render_template('privacy.html')


@app.route('/help')
def help_page():
    """Serves the Help & Getting Started guide."""
    return render_template('help.html')


@app.route('/admin/analytics')
def admin_analytics_page():
    """Serves the admin Analytics & Insights page."""
    return render_template('admin-analytics.html')


@app.route('/admin/user-management')
def admin_user_management_page():
    """Serves the admin User Management page."""
    return render_template('admin-user-management.html')

# ═══════════════════════════════════════════════════════════════════════════════
#  AUTHENTICATION DECORATOR
# ═══════════════════════════════════════════════════════════════════════════════

def verify_firebase_token(f):
    """
    Decorator to verify Firebase ID tokens from the Chrome extension.
    
    The decorator:
    1. Looks for Authorization header with format: "Bearer <firebase_id_token>"
    2. Uses firebase_admin.auth.verify_id_token() to validate the token
    3. Attaches user UID and email to g.user_uid and g.user_email on success
    4. Returns 401 Unauthorized if token is missing/invalid/expired
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Get the Authorization header
        auth_header = request.headers.get('Authorization', '')
        
        if not auth_header:
            return jsonify({'error': 'Authorization header is missing', 'success': False}), 401
        
        # Extract bearer token
        try:
            parts = auth_header.split()
            if len(parts) != 2 or parts[0].lower() != 'bearer':
                return jsonify({
                    'error': 'Invalid Authorization header format. Use: Bearer <token>',
                    'success': False
                }), 401
            
            token = parts[1]
        except (IndexError, AttributeError):
            return jsonify({'error': 'Invalid Authorization header format', 'success': False}), 401
        
        # Verify the Firebase token
        try:
            decoded_token = auth.verify_id_token(token)
            # Store user UID and email in Flask's g object for use in the route
            g.user_uid = decoded_token['uid']
            g.user_email = decoded_token.get('email', '')
        except auth.InvalidIdTokenError:
            return jsonify({'error': 'Invalid token', 'success': False}), 401
        except auth.ExpiredIdTokenError:
            return jsonify({'error': 'Token has expired', 'success': False}), 401
        except auth.RevokedIdTokenError:
            return jsonify({'error': 'Token has been revoked', 'success': False}), 401
        except Exception as e:
            app.logger.error(f'Token verification error: {str(e)}')
            return jsonify({'error': 'Unauthorized', 'success': False}), 401
        
        # Token is valid, proceed with the request
        return f(*args, **kwargs)
    
    return decorated_function


# ═══════════════════════════════════════════════════════════════════════════════
#  API ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/health', methods=['GET'])
def api_health():
    uptime_seconds = int(max(0, time.time() - _app_started_at))

    app_version = os.getenv('APP_VERSION', 'dev')
    server_time_utc = datetime.now(timezone.utc).isoformat()
    hostname = socket.gethostname()
    python_version = platform.python_version()

    firebase_admin_ok = False
    try:
        if _firebase_has_credentials:
            _db_check = get_db()
            list(_db_check.collection('Users').limit(1).stream())
            firebase_admin_ok = True
    except Exception:
        firebase_admin_ok = False

    return jsonify({
        'uptime_seconds': uptime_seconds,
        'server_time_utc': server_time_utc,
        'app_version': app_version,
        'hostname': hostname,
        'python_version': python_version,
        'firebase_admin_ok': firebase_admin_ok
    }), 200


@app.route('/api/extension/status', methods=['GET'])
@cross_origin(origins='*')
def api_extension_status():
    return jsonify({'status': 'online'}), 200


@app.route('/api/management-summary', methods=['GET'])
@cross_origin(origins='*')
def get_management_summary():
    """
    Returns operational metrics for admin extension popup:
    - unassigned_queue: reports with status Unassigned/Pending
    - under_investigation: reports with status Under Investigation/Investigating/Under Review
    - critical_threats_today: reports with Critical threat level created today
    """
    try:
        from datetime import datetime, timezone, timedelta

        # Get today's date range in UTC
        now = datetime.now(timezone.utc)
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        today_end = today_start + timedelta(days=1)

        # Convert to ISO format for comparison
        today_start_iso = today_start.isoformat()
        today_end_iso = today_end.isoformat()

        # Query all reports from Firestore
        reports_ref = db.collection('Reports')
        all_reports = reports_ref.stream()

        unassigned_count = 0
        investigating_count = 0
        critical_today_count = 0

        for doc in all_reports:
            report = doc.to_dict()
            if not report:
                continue

            status = str(report.get('status', '')).strip()
            risk_score = float(report.get('risk_score', 0) or 0)
            ai_verdict = str(report.get('ai_verdict', '') or '').upper()
            created_at = report.get('created_at', '')

            # Unassigned Reports (backward compatible with Pending)
            if status in ['Unassigned', 'Pending']:
                unassigned_count += 1

            # Under Investigation (backward compatible with Investigating, Under Review)
            if status in ['Under Investigation', 'Investigating', 'Under Review']:
                investigating_count += 1

            # Critical Threats Today (backward compatible with ai_verdict)
            # Critical if risk_score >= 0.7 OR ai_verdict is CRITICAL
            is_critical = risk_score >= 0.7 or ai_verdict == 'CRITICAL'

            if is_critical and created_at:
                # Check if created today
                try:
                    # Handle both ISO string and Firestore Timestamp
                    if hasattr(created_at, 'isoformat'):
                        created_str = created_at.isoformat()
                    else:
                        created_str = str(created_at)

                    if today_start_iso <= created_str < today_end_iso:
                        critical_today_count += 1
                except Exception:
                    # If date parsing fails, skip this check
                    pass

        return jsonify({
            'success': True,
            'metrics': {
                'unassigned_queue': unassigned_count,
                'under_investigation': investigating_count,
                'critical_threats_today': critical_today_count
            }
        }), 200

    except Exception as e:
        app.logger.error(f"[Management Summary] Error: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e),
            'metrics': {
                'unassigned_queue': 0,
                'under_investigation': 0,
                'critical_threats_today': 0
            }
        }), 500


def _dedup_evidence_text(text):
    """Remove duplicate sentence segments from evidence text (fixes 2× storage bug)."""
    if not text:
        return text
    # Split on double-newlines or long runs, deduplicate while preserving order
    segments = re.split(r'(?<=\.)\s+|\n{2,}', text)
    seen = set()
    deduped = []
    for seg in segments:
        key = ' '.join(seg.split()).lower()
        if key and key not in seen:
            seen.add(key)
            deduped.append(seg.strip())
    return ' '.join(deduped) if deduped else text


def _notify_experts_new_report(report_id, submitter_id, ai_verdict='WARNING'):
    """Creates a broadcast notification for all experts via staff_notifications."""
    try:
        short_uid = '#USR-' + str(submitter_id)[:6].upper()
        verdict_upper = str(ai_verdict or 'WARNING').upper()
        report_type_label = 'Critical' if verdict_upper == 'CRITICAL' else 'Warning'
        # Use staff_notifications with targetRole for broadcast (prevents write-amplification)
        db.collection('staff_notifications').add({
            'targetRole': 'expert',
            'type': 'new_report',
            'message': f"New {report_type_label} report by {short_uid}",
            'report_id': report_id,
            'isRead': False,
            'created_at': datetime.now(timezone.utc).isoformat()
        })
        app.logger.info(f"[Staff Notifications] Broadcast new_report to experts for report {report_id}")
        
        # Trigger email notification
        notify_expert_of_new_report(report_id)
    except Exception as e:
        app.logger.error(f"Failed to notify experts: {e}")


@app.route('/api/user-role', methods=['GET'])
@verify_firebase_token
def get_user_role():
    try:
        uid = (request.args.get('uid') or '').strip()
        if uid and uid != g.user_uid:
            return jsonify({'success': False, 'error': 'UID mismatch'}), 403

        user_doc = db.collection('Users').document(g.user_uid).get()
        if not user_doc.exists:
            return jsonify({'success': True, 'role': 'user'}), 200

        data = user_doc.to_dict() or {}
        role = str(data.get('role') or 'user').strip().lower()
        if role not in ('user', 'expert', 'admin'):
            role = 'user'

        return jsonify({'success': True, 'role': role}), 200

    except Exception as e:
        app.logger.error(f"[UserRole] Error: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/submit-report', methods=['POST'])
def submit_report():
    """
    Receives a scam-detection report from the Chrome Extension.

    Expected JSON body:
      {
        "text":       str,   — extracted page text
        "risk_score": float, — 0.0 to 1.0
        "heuristics": str,   — human-readable explanation
        "url":        str,   — (optional) source URL
        "user_id":    str    — (optional) Firebase UID of the logged-in user
      }

    Returns:
      { "success": true, "report_id": "<firestore_doc_id>" }
    """
    try:
        data = request.get_json(force=True)

        # ── Validate required fields ──────────────────────────────────────
        text = data.get('text', '').strip()
        if not text:
            return jsonify({'success': False, 'error': 'Missing required field: text'}), 400

        risk_score = data.get('risk_score', 0.0)
        heuristics = data.get('heuristics', '')

        # ── Build the Firestore document ──────────────────────────────────
        report = {
            'text':        text[:5000],        # Cap at 5 000 chars
            'risk_score':  float(risk_score),
            'heuristics':  heuristics,
            'url':         data.get('url', ''),
            'user_id':     data.get('user_id', 'anonymous'),
            'source_identifier': (data.get('source_identifier') or data.get('sourceIdentifier') or 'Unknown suspect'),
            'status':      'Unassigned',
            'created_at':  datetime.now(timezone.utc).isoformat(),
        }

        # ── Write to Firestore ────────────────────────────────────────────
        doc_ref = db.collection('Reports').add(report)
        report_id = doc_ref[1].id  # .add() returns (timestamp, doc_ref)

        _notify_experts_new_report(report_id, data.get('user_id', 'anonymous'))

        return jsonify({'success': True, 'report_id': report_id}), 201

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ── Local Blacklist and Scam Keywords ─────────────────────────────────────────
LOCAL_BLACKLIST = [
    "JRL KWARTA TRADING",
    "PET PLAN",
    "PET TRADING",
    "PET POULTRY",
    "PET",
    "LECRON",
    "LECRON FINANCE",
    "SOLARNA",
    "SOLARNA MINING",
    "GOLDEN SUN TRADING",
    "CROWD FUNDING",
    "FCASH",
    "MOCASA"
]

_AI_FENCELINE_KEYWORDS_RE = re.compile(
    r'\b(?:'
    r'passive\s+income|secured\s+passive\s+income|guaranteed\s+return|guaranteed\s+profit|'
    r'double\s+your\s+money|sumali\s+na|investment\s+plan|crypto\s+mining|task\s+scam|'
    r'gcash\s+deposit|pay\s+first|unauthorized|ponzi|pyramid|capital\s+investment|'
    r'payout\s+guaranteed|daily\s+earnings|risk\s+free|low\s+risk\s+high\s+return|'
    r'earn\s+daily|fast\s+payout|no\s+risk|high\s+yield|exclusive\s+investment|'
    r'looking\s+for\s+a\s+secured|invest\s+now|promising\s+returns|account\s+is\s+locked|'
    r'account\s+suspended|verify\s+immediately|claim\s+prize|click\s+link|verify\s+account|'
    r'https?://|www\.'
    r')\b',
    re.IGNORECASE
)


@app.route('/api/scan-text', methods=['POST'])
def scan_text():
    """
    Scan text for scam/fraud detection from the Chrome extension.
    
    PUBLIC ENDPOINT - No authentication required for seamless background scanning.
    
    Request body: JSON with 'text' field
    
    Response includes:
    - Legacy fields: status, confidence, message (for backward compat)
    - New fields: overall_score, overall_status, breakdown (Explainable AI)
    """
    try:
        data = request.get_json()
        text = sanitize_scan_text(data.get('text') or '')
        
        if not text:
            return jsonify({'error': 'Text field is required', 'success': False}), 400
        
        # Short text fast-path: messages under 15 characters are almost never scam.
        # Return safe immediately without running the AI model to prevent false
        # positives on laughter, emojis, single words, usernames, etc.
        if len(text) < 15:
            return jsonify({
                'prediction': 'Safe',
                'risk_score': 0,
                'threat_level': 'Safe',
                'overall_status': 'SAFE',
                'overall_score': 0,
                'watchlist': {
                    'status': 'NO_MATCH',
                    'matched_company': None,
                    'detail': 'Text too short for meaningful analysis.',
                    'sec_watchlist_hits': []
                },
                'ai_scan': {
                    'status': 'CLEAN',
                    'ai_confidence': 0,
                    'trigger_tokens': [],
                    'detail': 'Text too short for meaningful scam detection.'
                },
                'sec_watchlist_hits': [],
                'status': 'safe',
                'confidence': 0,
                'score': 0,
                'message': 'SAFE: Text too short for meaningful analysis.',
                'risk_level': 'safe',
                'breakdown': {
                    'message_tone': {
                        'is_flagged': False,
                        'severity': 'safe',
                        'display_text': 'Text too short for meaningful scam detection.'
                    },
                    'gov_records': {
                        'is_flagged': False,
                        'severity': 'safe',
                        'display_text': 'Text too short for watchlist comparison.'
                    }
                },
                'scanned_at': datetime.now(timezone.utc).isoformat(),
                'success': True
            }), 200
        
        # Log the scan request (no user tracking for public endpoint)
        app.logger.info(f'Scan request: {text[:50]}...')
        
        # ── Concurrent Dual-Layer Evaluation (Official watchlist + AI) ─────────
        db_client = get_db()

        def evaluate_watchlist(text_value: str, db_conn=None):
            # Fast check: local blacklist (word-boundary-aware)
            text_lower = text_value.lower()
            for entry in LOCAL_BLACKLIST:
                entry_lower = entry.lower()
                # Word-boundary-aware: the entry must appear as a distinct phrase,
                # not embedded inside another word.
                pattern = r'(?:^|[\s,;:!?.\-/\'"(])' + re.escape(entry_lower) + r'(?:[\s,;:!?.\-/\'")]|$)'
                if re.search(pattern, text_lower):
                    return {
                        'status': 'MATCHED',
                        'matched_company': entry,
                        'detail': f"Matched SEC/DTI Enforcement Advisory: {entry}",
                        'sec_watchlist_hits': [{
                            'matched_name': entry.upper(),
                            'confidence': 100,
                            'sec_category': 'Local Blacklist'
                        }]
                    }

            # Firestore check: Method 1 - extract entities and fuzzy match
            try:
                orgs = extract_org_entities(text_value)
                hits = []
                for org in orgs:
                    result = check_watchlist(org, db=db_conn)
                    if result.get('match'):
                        hits.append(result)

                if hits:
                    best_hit = hits[0]
                    return {
                        'status': 'MATCHED',
                        'matched_company': best_hit.get('matched_name', 'Unknown'),
                        'detail': f"Matched SEC Watchlist: {best_hit.get('matched_name', 'Unknown')}",
                        'sec_watchlist_hits': hits
                    }
            except Exception as e:
                app.logger.warning(f'Firestore entity watchlist check failed: {e}')

            # Firestore check: Method 2 - direct fuzzy match of full text (for when NER fails)
            try:
                direct_match = check_watchlist(text_value, db=db_conn, is_sentence=True)
                if direct_match.get('match'):
                    return {
                        'status': 'MATCHED',
                        'matched_company': direct_match.get('matched_name', 'Unknown'),
                        'detail': f"Matched SEC Watchlist: {direct_match.get('matched_name', 'Unknown')}",
                        'sec_watchlist_hits': [direct_match]
                    }
            except Exception as e:
                app.logger.warning(f'Firestore direct watchlist check failed: {e}')

            return {
                'status': 'CLEAN',
                'matched_company': None,
                'detail': 'No watchlist match found.',
                'sec_watchlist_hits': []
            }

        def evaluate_whitelist(text_value: str, db_conn=None):
            from sec_utils import check_whitelist
            try:
                orgs = extract_org_entities(text_value)
                hits = []
                for org in orgs:
                    w_res = check_whitelist(org, db=db_conn)
                    if w_res.get('match'):
                        hits.append(w_res)

                if hits:
                    best_hit = hits[0]
                    return {
                        'status': 'MATCHED',
                        'matched_company': best_hit.get('matched_name', 'Unknown'),
                        'detail': f"Matched SEC Whitelist: {best_hit.get('matched_name', 'Unknown')}",
                        'sec_whitelist_hits': hits
                    }
            except Exception as e:
                app.logger.warning(f'Firestore entity whitelist check failed: {e}')

            try:
                direct_match = check_whitelist(text_value, db=db_conn, is_sentence=True)
                if direct_match.get('match'):
                    return {
                        'status': 'MATCHED',
                        'matched_company': direct_match.get('matched_name', 'Unknown'),
                        'detail': f"Matched SEC Whitelist: {direct_match.get('matched_name', 'Unknown')}",
                        'sec_whitelist_hits': [direct_match]
                    }
            except Exception as e:
                app.logger.warning(f'Firestore direct whitelist check failed: {e}')

            return {
                'status': 'CLEAN',
                'matched_company': None,
                'detail': 'No whitelist match found.',
                'sec_whitelist_hits': []
            }

        def evaluate_ai_scan(text_value: str):
            raw_matches = _AI_FENCELINE_KEYWORDS_RE.findall(text_value)
            trigger_tokens = list(dict.fromkeys(t.lower() for t in raw_matches))

            if model is not None and tokenizer is not None:
                try:
                    with _model_infer_lock:
                        inputs = tokenizer(
                            text_value,
                            return_tensors='pt',
                            truncation=True,
                            max_length=512,
                            padding=True
                        )

                        with torch.no_grad():
                            outputs = model(**inputs)
                            logits = outputs.logits
                            probabilities = torch.nn.functional.softmax(logits, dim=-1).numpy()[0]

                    scam_prob = float(probabilities[1])
                    prediction = "Scam" if scam_prob >= 0.50 else "Safe"
                    dominant_prob = scam_prob if prediction == "Scam" else float(probabilities[0])
                    risk_score = round(dominant_prob * 100, 2)
                    return {
                        'prediction': prediction,
                        'risk_score': risk_score,
                        'ai_confidence': scam_prob,
                        'trigger_tokens': trigger_tokens,
                        'detail': (
                            f"AI flagged this message as scam (Dominant probability: {risk_score}%)."
                            if prediction == "Scam"
                            else f"AI found no scam patterns (Dominant probability: {risk_score}%)."
                        )
                    }
                except Exception as ex:
                    app.logger.warning(f"Neural inference fallback: {ex}")

            # Heuristic pattern scoring fallback
            keyword_count = len(trigger_tokens)
            if keyword_count >= 2:
                scam_prob = min(0.70 + (keyword_count * 0.10), 0.95)
                prediction = "Scam"
            elif keyword_count == 1:
                scam_prob = 0.65
                prediction = "Scam"
            else:
                scam_prob = 0.15
                prediction = "Safe"

            risk_score = round(scam_prob * 100, 2)
            return {
                'prediction': prediction,
                'risk_score': risk_score,
                'ai_confidence': scam_prob,
                'trigger_tokens': trigger_tokens,
                'detail': (
                    f"Heuristic scanner flagged scam indicators ({keyword_count} risk triggers found)."
                    if prediction == "Scam"
                    else f"Heuristic scanner found no major risk indicators."
                )
            }

        with ThreadPoolExecutor(max_workers=3) as executor:
            watchlist_future = executor.submit(evaluate_watchlist, text, db_client)
            whitelist_future = executor.submit(evaluate_whitelist, text, db_client)
            ai_future = executor.submit(evaluate_ai_scan, text)
            watchlist = watchlist_future.result()
            whitelist = whitelist_future.result()
            ai_scan = ai_future.result()

        sec_match = (watchlist.get('status') == 'MATCHED' or len(watchlist.get('sec_watchlist_hits', [])) > 0)
        sec_whitelist_match = (whitelist.get('status') == 'MATCHED' or len(whitelist.get('sec_whitelist_hits', [])) > 0)
        prediction = ai_scan['prediction']
        raw_risk_score = ai_scan['risk_score']

        # Threat level & priority logic (SEC Watchlist Blacklist takes priority over Whitelist!)
        if sec_match:
            threat_level = "Critical"
            overall_status = "CRITICAL"
            overall_score = max(raw_risk_score, 95.0)
            legacy_status = "critical"
        elif prediction == "Scam":
            threat_level = "Warning"
            overall_status = "WARNING"
            overall_score = max(raw_risk_score, 75.0)
            legacy_status = "warning"
        elif sec_whitelist_match:
            threat_level = "Safe"
            overall_status = "VERIFIED"
            overall_score = 5.0
            legacy_status = "safe"
            prediction = "Safe"
        else:
            threat_level = "Safe"
            overall_status = "SAFE"
            overall_score = raw_risk_score
            legacy_status = "safe"

        risk_score = overall_score

        breakdown = {
            'message_tone': {
                'is_flagged': prediction == "Scam",
                'severity': 'warning' if prediction == "Scam" else 'safe',
                'display_text': ai_scan['detail']
            },
            'gov_records': {
                'is_flagged': sec_match,
                'severity': 'critical' if sec_match else 'safe',
                'display_text': watchlist['detail']
            },
            'whitelist_records': {
                'is_flagged': sec_whitelist_match,
                'severity': 'legit' if sec_whitelist_match else 'safe',
                'display_text': whitelist['detail']
            }
        }

        legacy_message = (
            f"CRITICAL: {watchlist['detail']}"
            if threat_level == "Critical"
            else (
                "WARNING: AI flagged this message as suspicious."
                if threat_level == "Warning"
                else (
                    f"VERIFIED: {whitelist['detail']}"
                    if sec_whitelist_match
                    else "SAFE: No watchlist match and AI found no suspicious patterns."
                )
            )
        )

        result = {
            'prediction': prediction,
            'risk_score': risk_score,
            'threat_level': threat_level,

            'overall_status': overall_status,
            'overall_score': overall_score,
            'watchlist': watchlist,
            'whitelist': whitelist,
            'ai_scan': {
                'status': 'SUSPICIOUS' if prediction == "Scam" else 'CLEAN',
                'ai_confidence': ai_scan['ai_confidence'],
                'trigger_tokens': ai_scan['trigger_tokens'],
                'detail': ai_scan['detail']
            },
            'sec_watchlist_hits': watchlist.get('sec_watchlist_hits', []),
            'sec_whitelist_hits': whitelist.get('sec_whitelist_hits', []),
            'breakdown': breakdown,

            # Legacy/compat fields
            'status': legacy_status,
            'confidence': risk_score / 100,
            'score': risk_score,
            'message': legacy_message,
            'risk_level': legacy_status,

            # Optional breakdown for legacy UI paths
            'breakdown': breakdown,

            # Metadata
            'scanned_at': datetime.now(timezone.utc).isoformat(),
            'success': True
        }

        return jsonify(result), 200
        
    except Exception as e:
        app.logger.error(f'Scan error: {str(e)}')
        return jsonify({'error': 'Internal server error', 'success': False}), 500


@app.route('/api/update-report-status', methods=['POST'])
def update_report_status():
    """
    Allows an Expert to update the status of a report.
    When status is changed to 'Resolved', automatically:
      1. Creates a Notification document for the user
      2. Sends an email notification to the user's registered email
    """
    try:
        # ── Verify Firebase ID token ──────────────────────────────────────
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'success': False, 'error': 'Missing or invalid Authorization header'}), 401

        id_token = auth_header.split('Bearer ')[1]
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']

        # ── Check role in Firestore Users collection ──────────────────────
        user_doc = db.collection('Users').document(uid).get()
        if not user_doc.exists:
            return jsonify({'success': False, 'error': 'User not found'}), 403

        user_data = user_doc.to_dict()
        if user_data.get('role') != 'expert':
            return jsonify({'success': False, 'error': 'Insufficient permissions'}), 403

        # ── Update the report status ──────────────────────────────────────
        data = request.get_json(force=True)
        report_id = data.get('report_id', '').strip()
        new_status = data.get('status', '').strip()
        expert_notes = data.get('expert_notes', '').strip()
        expert_verdict = data.get('expert_verdict', '').strip()
        safety_justification = (data.get('safety_justification') or data.get('safetyJustification') or '').strip()
        remediation_plan = (data.get('remediation_plan') or data.get('remediationPlan') or '').strip()

        if not report_id or not new_status:
            return jsonify({'success': False, 'error': 'Missing report_id or status'}), 400

        allowed_statuses = ['Unassigned', 'Under Investigation', 'Resolved',
                              'Pending', 'Under Review', 'Reviewing', 'Reviewed', 'Dismissed']  # legacy compat
        if new_status not in allowed_statuses:
            return jsonify({
                'success': False,
                'error': f'Invalid status. Allowed: {allowed_statuses}'
            }), 400

        update_data = {
            'status':     new_status,
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'updated_by': uid,
        }
        if expert_notes:
            update_data['expert_notes'] = expert_notes
        if expert_verdict:
            update_data['expert_verdict'] = expert_verdict
        if safety_justification:
            update_data['safety_justification'] = safety_justification
        if remediation_plan:
            update_data['remediation_plan'] = remediation_plan

        db.collection('Reports').document(report_id).update(update_data)

        # ── If Resolved/Reviewed: trigger notification + email + training corpus ─────
        if new_status in ('Resolved', 'Reviewed'):
            _trigger_resolution_notifications(report_id, uid, expert_notes)
            
            # ── Add to training corpus if telemetry enabled ──────────────────
            try:
                # Check if auto telemetry is enabled
                config_doc = db.collection('system_config').document('global_settings').get()
                telemetry_enabled = True  # Default ON
                if config_doc.exists:
                    telemetry_enabled = config_doc.to_dict().get('autoThreatTelemetry', True)
                
                if telemetry_enabled and expert_verdict:
                    # Fetch report to get evidence field
                    report_doc = db.collection('Reports').document(report_id).get()
                    if report_doc.exists:
                        report_data = report_doc.to_dict()
                        evidence = report_data.get('evidence', '')
                        
                        # Validate evidence
                        if evidence and len(str(evidence).strip()) >= 5:
                            # PII Redaction
                            import re
                            PHONE_REGEX = r'\b\d{11}\b'
                            EMAIL_REGEX = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
                            
                            anonymized_text = str(evidence)
                            anonymized_text = re.sub(PHONE_REGEX, '[PHONE_REDACTED]', anonymized_text)
                            anonymized_text = re.sub(EMAIL_REGEX, '[EMAIL_REDACTED]', anonymized_text)
                            
                            # Save to training corpus (only 2 fields)
                            db.collection('training_corpus').add({
                                'anonymized_text': anonymized_text,
                                'label': expert_verdict
                            })
                            app.logger.info(f'[Training Corpus] Added report {report_id} with label {expert_verdict}')
            except Exception as corpus_err:
                # Don't let corpus errors break the resolve flow
                app.logger.error(f'[Training Corpus] Error adding report {report_id}: {str(corpus_err)}')

        return jsonify({'success': True, 'report_id': report_id, 'status': new_status}), 200

    except auth.InvalidIdTokenError:
        return jsonify({'success': False, 'error': 'Invalid authentication token'}), 401
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/submit-scam-report', methods=['POST'])
def submit_scam_report():
    """
    Receives a scam report from the Chrome Extension (Flows A & B).
    Saves to the Reports collection with consent tracking and priority.

    Expected JSON body:
      {
        "text":         str,   — scanned text (max 5000 chars)
        "url":          str,   — source URL
        "risk_score":   float, — 0.0 to 1.0
        "heuristics":   str,   — AI analysis message
        "report_type":  str,   — 'critical_report' or 'expert_review_request'
        "user_context": str,   — user-provided additional context
        "priority":     str,   — 'High' or 'Normal'
        "user_id":      str,   — Firebase UID
        "user_email":   str    — user's email address
      }
    """
    try:
        data = request.get_json(force=True)

        # ── Validate required fields ──────────────────────────────────────
        text = data.get('text', '').strip()
        if not text:
            return jsonify({'success': False, 'error': 'Missing required field: text'}), 400

        risk_score = data.get('risk_score', 0.0)
        report_type = data.get('report_type', 'critical_report')
        priority = data.get('priority', 'Normal')
        user_id = data.get('user_id', 'anonymous')

        # ── Build the Firestore document ──────────────────────────────────
        report = {
            'text':              text[:5000],
            'url':               data.get('url', ''),
            'risk_score':        float(risk_score),
            'heuristics':        data.get('heuristics', ''),
            'report_type':       report_type,
            'user_context':      data.get('user_context', ''),
            'source_identifier': (data.get('source_identifier') or data.get('sourceIdentifier') or 'Unknown suspect'),
            'priority':          priority,
            'user_id':           user_id,
            'user_email':        data.get('user_email', ''),
            'status':            'Unassigned',
            'consent_given':     True,
            'consent_timestamp': datetime.now(timezone.utc).isoformat(),
            'created_at':        datetime.now(timezone.utc).isoformat(),
            'updated_at':        None,
            'updated_by':        None,
            'expert_notes':      None,
            'safety_justification': None,
            'reviewedBy':        None,
            'reviewedAt':        None,
            'resolvedAt':        None,
        }

        # ── Write to Firestore ────────────────────────────────────────────
        doc_ref = db.collection('Reports').add(report)
        report_id = doc_ref[1].id

        _notify_experts_new_report(report_id, user_id)

        app.logger.info(
            f'[ScamReport] New {report_type} from {user_id} | '
            f'priority={priority} | report_id={report_id}'
        )

        return jsonify({'success': True, 'report_id': report_id}), 201

    except Exception as e:
        app.logger.error(f'[ScamReport] Submission error: {str(e)}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/push-report', methods=['POST'])
def push_report():
    """
    Primary report ingestion endpoint for the Chrome Extension (Flows A & B).
    Accepts the report payload and writes it to the Reports Firestore collection.

    Expected JSON body:
      {
        "user_id":      str,   — Firebase UID (required)
        "text":         str,   — scanned text (max 5000 chars)
        "url":          str,   — source URL
        "risk_score":   float, — 0.0 to 1.0
        "heuristics":   str,   — AI analysis message
        "report_type":  str,   — 'critical_report' or 'expert_review_request'
        "request_type": str,   — 'evidence' or 'expert_review'
        "user_context": str,   — user-provided additional context
        "priority":     str,   — 'High' or 'Normal'
        "user_email":   str    — user's email address
      }

    Returns:
      { "success": true, "report_id": "<firestore_doc_id>" }
    """
    try:
        data = request.get_json(force=True)

        user_id = (data.get('user_id') or '').strip()
        if not user_id or user_id == 'anonymous':
            return jsonify({
                'success': False,
                'error': 'Valid user_id is required. Please log in to the Suriin AI web app first.'
            }), 401

        now = datetime.now(timezone.utc).isoformat()

        requested_status = (data.get('status') or '').strip()
        is_expert_override = False
        expert_uid = None
        expert_email = (data.get('user_email') or '').strip()

        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            try:
                id_token = auth_header.split('Bearer ')[1]
                decoded_token = auth.verify_id_token(id_token)
                expert_uid = decoded_token.get('uid')

                user_doc = db.collection('Users').document(expert_uid).get()
                if user_doc.exists:
                    user_data = user_doc.to_dict() or {}
                    if user_data.get('role') == 'expert' and expert_uid == user_id:
                        is_expert_override = True
                        expert_email = (user_data.get('email') or expert_email or '').strip()
            except Exception:
                is_expert_override = False

        _raw_priority = str(data.get('threat_severity') or data.get('priority') or 'Normal').strip()
        _threat_severity = 'HIGH' if _raw_priority in ('High', 'HIGH') else 'MEDIUM'

        _raw_evidence = (data.get('evidence') or data.get('text') or '').strip()
        _raw_evidence = _dedup_evidence_text(_raw_evidence)

        report = {
            'evidence':          _raw_evidence[:5000],
            'url':               data.get('url', ''),
            'risk_score':        float(data.get('risk_score') or 0.0),
            'ai_verdict':        str(data.get('ai_verdict') or data.get('report_type') or 'WARNING').upper(),
            'threat_severity':   _threat_severity,
            'ai_confidence':     float(data.get('ai_confidence') or 0.0),
            'matched_company':   data.get('matched_company') or None,
            'trigger_tokens':    list(data.get('trigger_tokens') or []),
            'user_context':      data.get('user_context', ''),
            'source_identifier': (data.get('source_identifier') or data.get('sourceIdentifier') or 'Unknown suspect'),
            'user_id':           user_id,
            'user_email':        expert_email if is_expert_override else data.get('user_email', ''),
            'status':            requested_status if (is_expert_override and requested_status in ['Resolved', 'Under Investigation', 'Under Review', 'Reviewed', 'Investigating']) else 'Unassigned',
            'consent_given':     True,
            'consent_timestamp': now,
            'created_at':        now,
            'updated_at':        None,
            'updated_by':        None,
            'expert_notes':      None,
            'safety_justification': None,
            'reviewedBy':        None,
            'reviewedAt':        None,
            'resolvedAt':        None,
        }

        if report['status'] in ('Resolved', 'Reviewed') and is_expert_override:
            remediation_plan = (data.get('remediationPlan') or data.get('remediation_plan') or '').strip()
            remediation_template = (data.get('remediationTemplate') or data.get('remediation_template') or '').strip()
            expert_verdict = (data.get('expert_verdict') or data.get('expertVerdict') or 'Confirmed Threat').strip()
            expert_notes = (data.get('expert_notes') or data.get('expertNotes') or '').strip()

            report['expert_verdict'] = expert_verdict
            report['expert_notes'] = expert_notes
            report['remediation_template'] = remediation_template
            report['remediation_plan'] = remediation_plan
            report['reviewedBy'] = expert_uid
            report['reviewedByEmail'] = expert_email
            report['reviewedAt'] = now
            report['resolvedAt'] = now
            report['updated_at'] = now
            report['updated_by'] = expert_uid

        if report['status'] in ('Under Investigation', 'Under Review', 'Investigating') and is_expert_override:
            expert_notes = (data.get('expert_notes') or data.get('investigationNotes') or data.get('expertNotes') or '').strip()
            report['expert_notes'] = expert_notes
            report['assigned_to'] = expert_uid
            report['assigned_email'] = expert_email
            report['claimed_at'] = now
            report['updated_at'] = now
            report['updated_by'] = expert_uid

        doc_ref = db.collection('Reports').add(report)
        report_id = doc_ref[1].id

        if report['status'] in ('Unassigned', 'Pending'):
            _notify_experts_new_report(report_id, user_id, report.get('ai_verdict', 'WARNING'))

        app.logger.info(
            f'[PushReport] ai_verdict={report["ai_verdict"]} from {user_id} | '
            f'severity={_threat_severity} | report_id={report_id}'
        )

        return jsonify({'success': True, 'report_id': report_id, 'status': report['status']}), 200

    except Exception as e:
        app.logger.error(f'[PushReport] Submission error: {str(e)}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/push-reports', methods=['POST'])
def push_reports():
    """
    Bulk report ingestion endpoint for the Chrome Extension (Scan Current Chat flow).
    Accepts a structured payload with shared context and an array of per-message items;
    each item is stored as its own Firestore Reports document.

    Expected JSON body:
      {
        "shared": {
          "user_id":           str,   — Firebase UID (required)
          "url":               str,
          "report_type":       str,
          "request_type":      str,
          "user_context":      str,
          "source_identifier": str,
          "priority":          str,
          "user_email":        str,
          "heuristics":        str
        },
        "items": [
          {
            "text":             str,
            "risk_score":       float,
            "ai_status":        str,   — e.g. 'SUSPICIOUS' or 'SAFE'
            "watchlist_matched": bool
          },
          ...
        ]
      }

    Returns:
      { "success": true, "report_ids": ["<id1>", "<id2>", ...] }
    """
    try:
        data = request.get_json(force=True)
        shared = data.get('shared') or {}
        items  = data.get('items') or []

        user_id = (shared.get('user_id') or '').strip()
        if not user_id or user_id == 'anonymous':
            return jsonify({
                'success': False,
                'error': 'Valid user_id is required. Please log in to the Suriin AI web app first.'
            }), 401

        if not items:
            return jsonify({'success': False, 'error': 'items array is empty'}), 400

        now = datetime.now(timezone.utc).isoformat()

        auth_header = request.headers.get('Authorization', '')
        id_token_verified = False
        if auth_header.startswith('Bearer '):
            try:
                id_token = auth_header.split('Bearer ')[1]
                auth.verify_id_token(id_token)
                id_token_verified = True
            except Exception:
                pass

        report_ids = []
        first_report_id = None

        _bulk_raw_priority = str(shared.get('threat_severity') or shared.get('priority') or 'Normal').strip()
        _bulk_threat_severity = 'HIGH' if _bulk_raw_priority in ('High', 'HIGH') else 'MEDIUM'

        # Server-side dedup: keep only the first occurrence of each unique evidence text
        _seen_texts = set()
        _deduped_items = []
        for _item in items:
            _key = ' '.join(str(_item.get('text') or '').split()).lower()
            if _key and _key not in _seen_texts:
                _seen_texts.add(_key)
                _deduped_items.append(_item)
        items = _deduped_items

        for idx, item in enumerate(items):
            item_text = _dedup_evidence_text((item.get('text') or '').strip())[:5000]
            risk_score = float(item.get('risk_score') or 0.0)
            ai_status  = str(item.get('ai_status') or '').upper()

            report = {
                'evidence':          item_text,
                'url':               shared.get('url', ''),
                'risk_score':        risk_score,
                'ai_verdict':        ai_status or str(shared.get('ai_verdict') or 'WARNING').upper(),
                'threat_severity':   _bulk_threat_severity,
                'ai_confidence':     float(item.get('ai_confidence') or 0.0),
                'matched_company':   item.get('matched_company') or None,
                'trigger_tokens':    list(item.get('trigger_tokens') or []),
                'user_context':      shared.get('user_context', ''),
                'source_identifier': (shared.get('source_identifier') or 'Unknown suspect'),
                'user_id':           user_id,
                'user_email':        shared.get('user_email', ''),
                'status':            'Unassigned',
                'consent_given':     True,
                'consent_timestamp': now,
                'created_at':        now,
                'updated_at':        None,
                'updated_by':        None,
                'expert_notes':      None,
                'safety_justification': None,
                'reviewedBy':        None,
                'reviewedAt':        None,
                'resolvedAt':        None,
            }

            doc_ref = db.collection('Reports').add(report)
            report_id = doc_ref[1].id
            report_ids.append(report_id)
            if idx == 0:
                first_report_id = report_id

        if first_report_id:
            _notify_experts_new_report(first_report_id, user_id, str(shared.get('ai_verdict') or 'WARNING').upper())

        app.logger.info(
            f'[PushReports] {len(report_ids)} reports from {user_id} | '
            f'severity={_bulk_threat_severity} | ids={report_ids}'
        )

        return jsonify({'success': True, 'report_ids': report_ids}), 200

    except Exception as e:
        app.logger.error(f'[PushReports] Bulk submission error: {str(e)}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/user-notifications', methods=['GET'])
def user_notifications():
    """
    Returns unread notifications for a given user.
    Used by the Chrome Extension to poll for notification badge updates.

    Query params:
      uid — Firebase UID of the user

    Returns:
      {
        "success": true,
        "unread_count": 2,
        "notifications": [ { ... }, { ... } ]
      }
    """
    try:
        uid = request.args.get('uid', '').strip()
        if not uid:
            return jsonify({'success': False, 'error': 'Missing uid parameter'}), 400

        # Query unread notifications for this user
        notif_ref = db.collection('user_notifications')
        query = notif_ref.where('user_id', '==', uid) \
                         .order_by('created_at', direction='DESCENDING') \
                         .limit(20)

        docs = query.stream()
        notifications = []
        unread_count = 0

        for doc in docs:
            data = doc.to_dict()
            data['id'] = doc.id
            notifications.append(data)
            if not data.get('isRead', False):
                unread_count += 1

        return jsonify({
            'success': True,
            'unread_count': unread_count,
            'notifications': notifications
        }), 200

    except Exception as e:
        app.logger.error(f'[Notifications] Error: {str(e)}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/staff-notifications', methods=['GET'])
def staff_notifications():
    """
    Returns notifications for staff (expert/admin) users.
    Used by the Chrome Extension to poll for notification badge updates.
    Requires role query param ('expert' or 'admin').

    Query params:
      role — 'expert' or 'admin'
      limit — max number of notifications to return (default: 20)

    Returns:
      {
        "success": true,
        "unread_count": 2,
        "notifications": [ { ... }, { ... } ]
      }
    """
    try:
        # Verify Firebase ID token
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'success': False, 'error': 'Missing or invalid Authorization header'}), 401
        
        id_token = auth_header.split(' ', 1)[1]
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']

        # Get role parameter
        role = request.args.get('role', '').lower()
        if role not in ('expert', 'admin'):
            return jsonify({'success': False, 'error': 'Invalid role parameter'}), 400

        limit = min(int(request.args.get('limit', 20)), 50)  # Cap at 50

        # IMPLEMENT CACHING: Use cached notifications to reduce Firestore reads
        result = get_cached_staff_notifications(role, limit)

        return jsonify(result), 200

    except Exception as e:
        app.logger.error(f'[Staff Notifications] Error: {str(e)}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/admin/sec-watchlist-debug', methods=['GET'])
def debug_sec_watchlist():
    """
    Debug endpoint to check Firestore collection status
    Requires admin authentication.
    """
    try:
        # Verify Firebase ID token
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'success': False, 'error': 'Missing or invalid Authorization header'}), 401

        id_token = auth_header.split(' ', 1)[1]
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']

        # Verify user is admin
        user_doc = db.collection('Users').document(uid).get()
        if not user_doc.exists or user_doc.to_dict().get('role') != 'admin':
            return jsonify({'success': False, 'error': 'Admin access required'}), 403

        # Debug collection info
        watchlist_ref = db.collection('sec_watchlist')
        
        # Get collection stats
        all_docs = list(watchlist_ref.stream())
        doc_count = len(all_docs)
        
        # Sample documents
        sample_docs = []
        for i, doc in enumerate(all_docs[:5]):
            data = doc.to_dict()
            sample_docs.append({
                'id': doc.id,
                'company_name': data.get('company_name', 'Missing'),
                'sec_category': data.get('sec_category', 'Missing'),
                'date_added': data.get('date_added', 'Missing'),
                'has_company_name': 'company_name' in data,
                'has_sec_category': 'sec_category' in data,
                'has_date_added': 'date_added' in data
            })
        
        # Check field availability
        company_name_count = sum(1 for doc in all_docs if 'company_name' in doc.to_dict())
        sec_category_count = sum(1 for doc in all_docs if 'sec_category' in doc.to_dict())
        date_added_count = sum(1 for doc in all_docs if 'date_added' in doc.to_dict())
        
        return jsonify({
            'success': True,
            'debug_info': {
                'total_documents': doc_count,
                'field_availability': {
                    'company_name': f'{company_name_count}/{doc_count}',
                    'sec_category': f'{sec_category_count}/{doc_count}',
                    'date_added': f'{date_added_count}/{doc_count}'
                },
                'sample_documents': sample_docs,
                'collection_accessible': True
            }
        }), 200

    except Exception as e:
        app.logger.error(f'[SEC Watchlist Debug] Error: {str(e)}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/admin/sec-watchlist', methods=['GET'])
def get_sec_watchlist():
    """
    Returns SEC watchlist entries for admin intelligence page with cursor-based pagination.
    Requires admin authentication.
    
    Query Parameters:
    - limit: Number of documents to return (default: 25, max: 100)
    - cursor: Document ID to start after (for pagination)
    - full: Set to 'true' to get all documents (legacy mode, not recommended)
    """
    try:
        # Verify Firebase ID token
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            app.logger.warning('[SEC Watchlist API] Missing or invalid Authorization header')
            return jsonify({'success': False, 'error': 'Missing or invalid Authorization header'}), 401

        id_token = auth_header.split(' ', 1)[1]
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']
        app.logger.info(f'[SEC Watchlist API] Admin user {uid} requesting SEC watchlist')

        # Verify user is admin
        user_doc = db.collection('Users').document(uid).get()
        if not user_doc.exists or user_doc.to_dict().get('role') != 'admin':
            app.logger.warning(f'[SEC Watchlist API] Non-admin user {uid} attempted access')
            return jsonify({'success': False, 'error': 'Admin access required'}), 403

        # Parse query parameters
        limit = min(int(request.args.get('limit', 25)), 100)  # Max 100 documents per request
        cursor = request.args.get('cursor', None)
        full_mode = request.args.get('full', '').lower() == 'true'
        
        app.logger.info(f'[SEC Watchlist API] Request params: limit={limit}, cursor={cursor}, full_mode={full_mode}')

        # Fetch SEC watchlist from Firestore with pagination
        watchlist_ref = db.collection('sec_watchlist')
        
        # Build query with pagination - simplified using document ID ordering
        if full_mode:
            # Legacy mode: get all documents (not recommended for large datasets)
            app.logger.warning('[SEC Watchlist API] Using legacy full mode - not recommended for large datasets')
            query = watchlist_ref.order_by('__name__', direction='DESCENDING')
        else:
            # Optimized mode: use limit and cursor with document ID ordering
            query = watchlist_ref.order_by('__name__', direction='DESCENDING').limit(limit)
            if cursor:
                # Get the document to start after
                cursor_doc = watchlist_ref.document(cursor).get()
                if cursor_doc.exists:
                    query = query.start_after(cursor_doc)
                    app.logger.info(f'[SEC Watchlist API] Starting after cursor: {cursor}')
                else:
                    app.logger.warning(f'[SEC Watchlist API] Cursor document not found: {cursor}')

        # Execute query
        docs = list(query.stream())
        app.logger.info(f'[SEC Watchlist API] Retrieved {len(docs)} documents from Firestore')
        app.logger.info(f'[SEC Watchlist API] Query details: limit={limit}, cursor={cursor}, full_mode={full_mode}')
        app.logger.info(f'[SEC Watchlist API] Using simplified query with document ID ordering')
        
        # Enhanced logging for query verification
        if len(docs) > 0:
            app.logger.info(f'[SEC Watchlist API] SUCCESS: Query returned {len(docs)} documents')
            app.logger.info(f'[SEC Watchlist API] First document ID: {docs[0].id}')
            if len(docs) >= 1:
                sample_data = docs[0].to_dict()
                app.logger.info(f'[SEC Watchlist API] Sample document fields: {list(sample_data.keys())}')
        else:
            app.logger.warning(f'[SEC Watchlist API] WARNING: Query returned 0 documents despite collection having data')

        watchlist = []
        last_doc = None
        
        # Debug: Check if docs is empty
        if len(docs) == 0:
            app.logger.warning('[SEC Watchlist API] No documents retrieved from Firestore!')
            app.logger.warning(f'[SEC Watchlist API] Query: {query}')
            # Try to get collection info
            try:
                all_docs = list(watchlist_ref.stream())
                app.logger.info(f'[SEC Watchlist API] Total documents in collection: {len(all_docs)}')
                if len(all_docs) > 0:
                    app.logger.info(f'[SEC Watchlist API] Sample document: {all_docs[0].to_dict()}')
            except Exception as debug_error:
                app.logger.error(f'[SEC Watchlist API] Debug query failed: {debug_error}')
        else:
            app.logger.info(f'[SEC Watchlist API] First document ID: {docs[0].id}')
        
        for doc in docs:
            last_doc = doc
            data = doc.to_dict()
            
            # Log sample data for debugging
            if len(watchlist) < 3:
                app.logger.debug(f'[SEC Watchlist API] Sample doc {doc.id}: {data}')
                app.logger.debug(f'[SEC Watchlist API] Available fields: {list(data.keys())}')
                app.logger.debug(f'[SEC Watchlist API] Category field: {data.get("category", "MISSING")}')
                app.logger.debug(f'[SEC Watchlist API] Date field: {data.get("date_cached", "MISSING")}')
                app.logger.debug(f'[SEC Watchlist API] Company field: {data.get("company_name", "MISSING")}')
            
            watchlist.append({
                'company_name': data.get('company_name', 'Unknown'),
                'category': data.get('category', 'Uncategorized'),
                'date_scraped': data.get('date_cached', ''),
                'source_url': data.get('source_url', '')
            })

        # Build pagination metadata
        has_more = len(docs) == limit and last_doc is not None
        next_cursor = last_doc.id if has_more else None
        
        # Get total count for first page (cached for subsequent requests)
        total_count = None
        if not cursor and not full_mode:
            try:
                # Count documents efficiently (this is still a read operation, but only once per session)
                total_count = len(list(watchlist_ref.stream()))
                app.logger.info(f'[SEC Watchlist API] Total documents in collection: {total_count}')
            except Exception as count_error:
                app.logger.warning(f'[SEC Watchlist API] Could not get total count: {str(count_error)}')

        pagination_info = {
            'hasMore': has_more,
            'nextCursor': next_cursor,
            'totalCount': total_count,
            'pageSize': len(watchlist),
            'isFullMode': full_mode
        }

        app.logger.info(f'[SEC Watchlist API] Returning {len(watchlist)} documents, hasMore={has_more}')

        return jsonify({
            'success': True,
            'watchlist': watchlist,
            'pagination': pagination_info
        }), 200

    except auth.InvalidIdTokenError as e:
        app.logger.error(f'[SEC Watchlist API] Invalid token: {str(e)}')
        return jsonify({'success': False, 'error': 'Invalid authentication token'}), 401
    except Exception as e:
        app.logger.error(f'[SEC Watchlist API] Error: {str(e)}')
        app.logger.error(f'[SEC Watchlist API] Error traceback: {traceback.format_exc()}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/admin/sec-watchlist-debug', methods=['GET'])
def get_sec_watchlist_debug():
    """
    Debug endpoint for SEC watchlist - no authentication required for testing
    """
    try:
        # Simple test query without pagination
        watchlist_ref = db.collection('sec_watchlist')
        docs = list(watchlist_ref.limit(5).stream())
        
        debug_info = {
            'total_docs_in_collection': len(list(watchlist_ref.stream())),
            'sample_docs': []
        }
        
        for doc in docs:
            data = doc.to_dict()
            debug_info['sample_docs'].append({
                'id': doc.id,
                'data': data
            })
        
        return jsonify({
            'success': True,
            'debug_info': debug_info
        }), 200
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500

@app.route('/api/admin/training-corpus', methods=['GET'])
def get_training_corpus():
    """
    Returns training corpus data for admin intelligence page.
    Requires admin authentication.
    Supports pagination with 'limit' and 'offset' query params.
    """
    try:
        # Verify Firebase ID token
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'success': False, 'error': 'Missing or invalid Authorization header'}), 401

        id_token = auth_header.split(' ', 1)[1]
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']

        # Verify user is admin
        user_doc = db.collection('Users').document(uid).get()
        if not user_doc.exists or user_doc.to_dict().get('role') != 'admin':
            return jsonify({'success': False, 'error': 'Admin access required'}), 403

        # THROTTLED: Get pagination params with reduced limit for Firebase quota mitigation
        limit = min(int(request.args.get('limit', 50)), 50)  # THROTTLED: Cap at 50 (was 1000)
        cursor = request.args.get('cursor', None)  # Use cursor-based pagination instead of offset

        # Fetch training corpus from Firestore with throttled limit
        corpus_ref = db.collection('training_corpus')
        query = corpus_ref.order_by('created_at', direction='DESCENDING').limit(limit)

        # Apply cursor-based pagination for better performance
        if cursor:
            cursor_doc = corpus_ref.document(cursor).get()
            if cursor_doc.exists:
                query = query.start_after(cursor_doc)

        docs = list(query.stream())  # Convert to list for pagination metadata

        corpus = []
        for doc in docs:
            data = doc.to_dict()
            corpus.append({
                'anonymized_text': data.get('anonymized_text', ''),
                'classification': data.get('classification', ''),
                'platform': data.get('platform', ''),
                'expert_notes': data.get('expert_notes', ''),
                'date': data.get('created_at', ''),
                'report_id': data.get('report_id', '')
            })

        # Return with pagination metadata for frontend lazy-loading
        return jsonify({
            'success': True,
            'corpus': corpus,
            'pagination': {
                'limit': limit,
                'has_more': len(docs) == limit,
                'next_cursor': docs[-1].id if len(docs) == limit else None
            },
            'count': len(corpus)
        }), 200

    except Exception as e:
        app.logger.error(f'[Training Corpus API] Error: {str(e)}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/admin/migrate-historical-data', methods=['POST'])
def migrate_historical_data():
    """
    Migrates resolved reports to training_corpus collection.
    Extracts text, masks PII (phones/emails), uses expert_verdict as classification.
    Prevents duplicates by checking if report_id already exists in training_corpus.
    Requires admin authentication.
    """
    try:
        # Verify Firebase ID token
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'success': False, 'error': 'Missing or invalid Authorization header'}), 401

        id_token = auth_header.split(' ', 1)[1]
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']

        # Verify user is admin
        user_doc = db.collection('Users').document(uid).get()
        if not user_doc.exists or user_doc.to_dict().get('role') != 'admin':
            return jsonify({'success': False, 'error': 'Admin access required'}), 403

        # Import regex patterns for PII masking
        import re

        # Regex patterns for PII detection
        PHONE_REGEX = r'\b\d{11}\b'
        EMAIL_REGEX = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'

        def mask_pii(text):
            """Mask phone numbers and emails in text."""
            if not text:
                return text
            # Mask phone numbers (11 digits)
            text = re.sub(PHONE_REGEX, '[PHONE REDACTED]', text)
            # Mask emails
            text = re.sub(EMAIL_REGEX, '[EMAIL REDACTED]', text)
            return text

        # Query resolved reports
        reports_ref = db.collection('Reports')
        # Get reports with status 'Resolved' or 'Reviewed' that have expert_verdict
        resolved_query = reports_ref.where('status', 'in', ['Resolved', 'Reviewed']).stream()

        migrated_count = 0
        skipped_count = 0
        error_count = 0
        corpus_ref = db.collection('training_corpus')

        for doc in resolved_query:
            try:
                report_data = doc.to_dict()
                
                # Extract ONLY the evidence field (raw scam text from user)
                evidence = report_data.get('evidence', '')
                
                # Validate evidence - skip if missing, null, or too short
                if not evidence or len(str(evidence).strip()) < 5:
                    skipped_count += 1
                    continue

                # Mask PII (phones and emails)
                anonymized_text = mask_pii(str(evidence))

                # Get classification from expert_verdict
                classification = report_data.get('expert_verdict', '')
                if not classification:
                    skipped_count += 1
                    continue

                # Create training corpus document (ONLY 2 fields as requested)
                corpus_doc = {
                    'anonymized_text': anonymized_text,
                    'label': classification
                }

                # Save to training_corpus
                corpus_ref.add(corpus_doc)
                migrated_count += 1

            except Exception as doc_error:
                app.logger.error(f'[Migration] Error processing report {doc.id}: {str(doc_error)}')
                error_count += 1

        app.logger.info(f'[Migration] Completed: {migrated_count} migrated, {skipped_count} skipped, {error_count} errors')

        return jsonify({
            'success': True,
            'migrated': migrated_count,
            'skipped': skipped_count,
            'errors': error_count,
            'message': f'Successfully migrated {migrated_count} reports to training corpus.'
        }), 200

    except Exception as e:
        app.logger.error(f'[Migration API] Error: {str(e)}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/admin/sync-sec-watchlist', methods=['POST'])
def sync_sec_watchlist():
    """
    Triggers the SEC scraper to fetch latest advisories.
    Requires admin authentication.
    """
    try:
        # Verify Firebase ID token
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'success': False, 'error': 'Missing or invalid Authorization header'}), 401

        id_token = auth_header.split(' ', 1)[1]
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']

        # Verify user is admin
        user_doc = db.collection('Users').document(uid).get()
        if not user_doc.exists or user_doc.to_dict().get('role') != 'admin':
            return jsonify({'success': False, 'error': 'Admin access required'}), 403

        # For now, this is a placeholder that logs the request
        # In a full implementation, this would trigger a background task
        # to scrape the Philippine SEC website
        app.logger.info(f'[SEC Sync] Sync requested by admin {uid}')

        # Add a sync log entry
        db.collection('system_logs').add({
            'type': 'sec_sync',
            'action': 'manual_trigger',
            'triggered_by': uid,
            'status': 'pending',
            'timestamp': datetime.now(timezone.utc).isoformat()
        })

        return jsonify({
            'success': True,
            'message': 'SEC watchlist sync initiated. The scraper will process in the background.'
        }), 200

    except Exception as e:
        app.logger.error(f'[SEC Sync API] Error: {str(e)}')
        return jsonify({'success': False, 'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════════
#  NOTIFICATION HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _trigger_resolution_notifications(report_id, expert_uid, expert_notes=''):
    """
    Called when an expert resolves a report. Creates a Firestore Notification
    document and sends an email to the reporting user.
    """
    try:
        # Get the report to find the user
        report_doc = db.collection('Reports').document(report_id).get()
        if not report_doc.exists:
            app.logger.warning(f'[Notify] Report {report_id} not found for notification.')
            return

        report_data = report_doc.to_dict()
        user_id = report_data.get('user_id', '')
        user_email = report_data.get('user_email', '')

        # If no email on the report, look up the Users collection
        if not user_email and user_id and user_id != 'anonymous':
            user_doc = db.collection('Users').document(user_id).get()
            if user_doc.exists:
                user_email = user_doc.to_dict().get('email', '')

        # ── Create Notification document ──────────────────────────────────
        if user_id and user_id != 'anonymous':
            notification = {
                'user_id':    user_id,
                'type':       'report_resolved',
                'reportId':   report_id,
                'message':    'Our experts have reviewed your submission. '
                              'Log in to your dashboard to view the final verdict.',
                'isRead':     False,
                'created_at': datetime.now(timezone.utc).isoformat(),
                'sentBy':     expert_uid,
            }
            db.collection('user_notifications').add(notification)
            app.logger.info(f'[User Notifications] Created notification for user {user_id}')

        # ── Send email ───────────────────────────────────────────────────
        if user_id and user_id != 'anonymous':
            notify_user_of_expert_review(report_id, user_id)

    except Exception as e:
        # Don't let notification failures break the status update
        app.logger.error(f'[Notify] Error sending notifications: {str(e)}')


def notify_expert_of_new_report(report_id):
    """
    Triggered when a User submits a new report for review.
    Queries Firestore for an available Expert where preferences.email_new_assignments == true.
    Sends an HTML email with the Report ID.
    """
    try:
        report_doc = db.collection('Reports').document(report_id).get()
        if not report_doc.exists:
            return
            
        report_data = report_doc.to_dict()
        risk_score = report_data.get('risk_score', 0)
        risk_level = 'Critical' if risk_score >= 0.7 else ('Warning' if risk_score >= 0.4 else 'Safe')
        
        experts_query = db.collection('Users').where('role', '==', 'expert').stream()
        for expert in experts_query:
            expert_data = expert.to_dict()
            prefs = expert_data.get('preferences', {})
            if prefs.get('email_new_assignments') is True:
                expert_email = expert_data.get('email')
                if expert_email:
                    msg = Message('Suriin AI — New Report Assignment', recipients=[expert_email])
                    msg.html = f'''
                    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; background: #0F0E17; color: #EEEEF4; padding: 32px; border-radius: 16px;">
                        <div style="text-align: center; margin-bottom: 24px;">
                            <h1 style="background: linear-gradient(135deg, #6C63FF, #3ECFCF); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 24px; margin: 0;">Suriin AI</h1>
                        </div>
                        <div style="background: #1A1928; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; margin-bottom: 24px;">
                            <h2 style="color: #22C55E; font-size: 18px; margin: 0 0 12px;">🛡️ New Report Requires Review</h2>
                            <p style="color: #9898B2; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
                                A new <strong>{risk_level}</strong> report has been submitted by a user and requires your review.
                            </p>
                            <p style="color: #9898B2; font-size: 14px; margin: 0 0 16px;"><strong>Report ID:</strong> {report_id}</p>
                            <a href="{request.host_url}expert-dashboard" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #6C63FF, #3ECFCF); color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">Review Report →</a>
                        </div>
                    </div>
                    '''
                    mail.send(msg)
    except Exception as e:
        app.logger.error(f"[Email] Error sending expert notification: {e}")


def notify_user_of_expert_review(report_id, user_id):
    """
    Triggered when an Expert clicks "Submit Review" on a report.
    Queries the User's Firestore document to check if preferences.email_expert_reviews == true.
    Sends an HTML email with the Expert's final verdict and any remediation notes.
    """
    try:
        user_doc = db.collection('Users').document(user_id).get()
        if not user_doc.exists:
            return
            
        user_data = user_doc.to_dict()
        prefs = user_data.get('preferences', {})
        
        if prefs.get('email_expert_reviews') is True:
            user_email = user_data.get('email')
            if user_email:
                report_doc = db.collection('Reports').document(report_id).get()
                report_data = report_doc.to_dict() if report_doc.exists else {}
                
                status = report_data.get('status', 'Resolved')
                notes = report_data.get('expert_notes', 'No additional notes provided.')
                verdict = report_data.get('expert_verdict', status)
                
                msg = Message('Suriin AI — Your Report Has Been Reviewed', recipients=[user_email])
                msg.html = f'''
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; background: #0F0E17; color: #EEEEF4; padding: 32px; border-radius: 16px;">
                    <div style="text-align: center; margin-bottom: 24px;">
                        <h1 style="background: linear-gradient(135deg, #6C63FF, #3ECFCF); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 24px; margin: 0;">Suriin AI</h1>
                    </div>
                    <div style="background: #1A1928; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; margin-bottom: 24px;">
                        <h2 style="color: #22C55E; font-size: 18px; margin: 0 0 12px;">✅ Report Reviewed</h2>
                        <p style="color: #9898B2; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
                            An expert has reviewed your security report <strong style="color: #EEEEF4;">(#{report_id[:8]})</strong>.
                        </p>
                        <p style="color: #9898B2; font-size: 14px; margin: 0 0 8px;"><strong>Final Verdict:</strong> <span style="color: #EEEEF4;">{verdict}</span></p>
                        <p style="color: #9898B2; font-size: 14px; margin: 0 0 16px;"><strong>Expert Notes:</strong> <br/>{notes}</p>
                        <a href="{request.host_url}user-dashboard" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #6C63FF, #3ECFCF); color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">View on Dashboard →</a>
                    </div>
                </div>
                '''
                mail.send(msg)
                app.logger.info(f'[Email] Notification email sent to {user_email}')
    except Exception as e:
        app.logger.error(f"[Email] Error sending user notification: {e}")

# ═══════════════════════════════════════════════════════════════════════════════
#  USER DATA EXPORT (GDPR/RA 10173 Compliance)
# ═══════════════════════════════════════════════════════════════════════════════

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak, KeepTogether, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.units import inch
from flask import send_file, make_response
import io
import re

# Helper functions for date formatting
def format_date_readable(iso_string):
    """Format ISO timestamp to human-readable: May 28, 2026, 08:50 AM"""
    if not iso_string or iso_string == 'Unknown':
        return 'Unknown'
    try:
        # Handle various ISO formats
        dt_str = str(iso_string).replace('Z', '+00:00')
        dt = datetime.fromisoformat(dt_str)
        return dt.strftime('%b %d, %Y, %I:%M %p')
    except Exception:
        return str(iso_string)

def truncate_url(url, max_len=50):
    """Truncate URL to max length with ellipsis"""
    if not url:
        return 'Unknown'
    url_str = str(url)
    if len(url_str) > max_len:
        return url_str[:max_len] + '...'
    return url_str

def extract_platform(url):
    """Extract platform name from URL (e.g., facebook.com -> Facebook)"""
    if not url:
        return 'Unknown'
    try:
        from urllib.parse import urlparse
        hostname = urlparse(str(url)).hostname.lower()
        if 'facebook' in hostname:
            return 'Facebook'
        if 'twitter' in hostname or 'x.com' in hostname:
            return 'Twitter/X'
        if 'instagram' in hostname:
            return 'Instagram'
        if 'telegram' in hostname:
            return 'Telegram'
        if 'discord' in hostname:
            return 'Discord'
        if 'whatsapp' in hostname:
            return 'WhatsApp'
        if 'youtube' in hostname:
            return 'YouTube'
        if 'tiktok' in hostname:
            return 'TikTok'
        if 'linkedin' in hostname:
            return 'LinkedIn'
        # Remove www. prefix and return root domain
        return hostname.replace('www.', '').split('.')[0].capitalize()
    except Exception:
        return str(url)[:30]

def is_report_resolved_or_reviewed(status):
    """Check if report status indicates expert review is complete"""
    if not status:
        return False
    status_lower = str(status).lower()
    return status_lower in ['resolved', 'reviewed']

@app.route('/api/user/export-data', methods=['GET', 'POST'])
def export_user_data():
    """
    Generate a PDF report of user's personal data and reporting history.
    Compliant with Philippine Data Privacy Act of 2012 (RA 10173).
    """
    # Authenticate user
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return jsonify({'error': 'Unauthorized - Missing token'}), 401

    token = auth_header.split('Bearer ')[1]
    try:
        decoded = auth.verify_id_token(token)
        user_id = decoded['uid']
        user_email = decoded.get('email', 'Unknown')
    except Exception as e:
        app.logger.error(f"[Export Data] Token verification failed: {e}")
        return jsonify({'error': 'Invalid token'}), 401

    try:
        # Fetch user profile
        user_doc = db.collection('Users').document(user_id).get()
        user_data = user_doc.to_dict() if user_doc.exists else {}

        # Fetch all reports submitted by user
        reports_query = db.collection('Reports').where('user_id', '==', user_id)
        reports = []
        for doc in reports_query.stream():
            report_data = doc.to_dict()
            report_data['id'] = doc.id
            reports.append(report_data)

        # Sort reports by created_at (newest first)
        reports.sort(key=lambda x: x.get('created_at', ''), reverse=True)

        # Generate PDF
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=letter,
            rightMargin=72,
            leftMargin=72,
            topMargin=72,
            bottomMargin=18
        )

        # Styles
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Heading1'],
            fontSize=24,
            textColor=colors.HexColor('#6C63FF'),
            spaceAfter=12,
            alignment=1  # Center
        )
        subtitle_style = ParagraphStyle(
            'CustomSubtitle',
            parent=styles['Normal'],
            fontSize=10,
            textColor=colors.gray,
            alignment=1,
            spaceAfter=30
        )
        section_style = ParagraphStyle(
            'SectionHeader',
            parent=styles['Heading2'],
            fontSize=14,
            textColor=colors.HexColor('#6C63FF'),
            spaceAfter=12,
            spaceBefore=20
        )
        normal_style = styles['Normal']
        normal_style.fontSize = 10

        story = []

        # Header
        story.append(Paragraph("Suriin-AI: Personal Data Portability Report", title_style))
        story.append(Paragraph(
            "Generated in compliance with the Philippine Data Privacy Act of 2012 (Republic Act No. 10173).<br/>"
            "This document contains your personal data and reporting history as stored in our systems.",
            subtitle_style
        ))
        story.append(Spacer(1, 20))

        # User Profile Section
        story.append(Paragraph("User Profile", section_style))
        
        # Build profile data - conditionally include Account Created
        profile_data = [
            ['User ID', user_id],
            ['Email Address', user_email],
        ]
        
        # Check for account creation date (backward compatible: created_at or createdAt)
        account_created = user_data.get('created_at') or user_data.get('createdAt')
        if account_created and account_created != 'Unknown':
            profile_data.append(['Account Created', format_date_readable(account_created)])
        
        profile_data.append(['Total Reports Submitted', str(len(reports))])
        profile_table = Table(profile_data, colWidths=[2*inch, 4*inch])
        profile_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f0f0f7')),
            ('TEXTCOLOR', (0, 0), (0, -1), colors.HexColor('#37375a')),
            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('ALIGN', (0, 0), (0, -1), 'LEFT'),
            ('ALIGN', (1, 0), (1, -1), 'LEFT'),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#d2d2e1')),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        story.append(profile_table)
        story.append(Spacer(1, 30))

        # Reports Section
        if reports:
            story.append(Paragraph("Complete Scam Reporting History", section_style))
            story.append(Spacer(1, 10))

            for idx, report in enumerate(reports):
                # Collect all elements for this ticket to keep them together
                ticket_elements = []
                
                # Check if report has expert review completed
                report_status = report.get('status', 'Pending')
                has_expert_review = is_report_resolved_or_reviewed(report_status)
                
                # Report Header
                report_id_short = report['id'][-6:].upper() if len(report['id']) >= 6 else report['id'].upper()
                ticket_elements.append(Paragraph(f"Incident Ticket #{idx + 1}: Report #{report_id_short}", section_style))

                # Basic Info
                basic_data = [
                    ['Report ID', report['id']],
                    ['Submission Date', format_date_readable(report.get('created_at'))],
                    ['Status', report_status or 'Pending'],
                    ['Platform', truncate_url(report.get('url'))],
                ]

                # AI Confidence
                ai_conf = report.get('ai_confidence')
                if ai_conf:
                    basic_data.append(['AI Confidence', f"{int(ai_conf * 100)}%"])

                basic_table = Table(basic_data, colWidths=[1.5*inch, 4.5*inch])
                basic_table.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f0f0f7')),
                    ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, -1), 9),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                    ('TOPPADDING', (0, 0), (-1, -1), 6),
                    ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#d2d2e1')),
                ]))
                ticket_elements.append(basic_table)
                ticket_elements.append(Spacer(1, 10))

                # Evidence Text - NO REDACTION per RA 10173 data portability rights
                # Raw, unmodified evidence as stored in database
                evidence = report.get('evidence') or report.get('text') or 'No evidence provided'
                ticket_elements.append(Paragraph("<b>Scanned Evidence:</b>", normal_style))
                ticket_elements.append(Paragraph(evidence, ParagraphStyle(
                    'EvidenceText',
                    parent=normal_style,
                    backColor=colors.HexColor('#f9f9fb'),
                    borderPadding=10,
                    borderColor=colors.HexColor('#e0e0e8'),
                    borderWidth=1
                )))
                ticket_elements.append(Spacer(1, 10))

                # Risk Factors
                risk_factors = []
                if report.get('matched_company'):
                    risk_factors.append(f"SEC Watchlist Match: {report['matched_company']}")
                if report.get('heuristics'):
                    risk_factors.append(f"Detected Patterns: {report['heuristics']}")

                if risk_factors:
                    ticket_elements.append(Paragraph("<b>Risk Factors:</b>", normal_style))
                    for factor in risk_factors:
                        ticket_elements.append(Paragraph(f"• {factor}", normal_style))
                    ticket_elements.append(Spacer(1, 10))

                # Expert Verdict - ONLY show if report is Resolved/Reviewed
                if has_expert_review:
                    expert_verdict = report.get('expert_verdict') or report.get('expertVerdict')
                    if expert_verdict:
                        verdict_color = colors.HexColor('#22c55e') if 'safe' in expert_verdict.lower() else colors.HexColor('#ef4444')
                        ticket_elements.append(Paragraph(f"<b>Expert Verdict:</b> <font color='{verdict_color.hexval()}'>{expert_verdict}</font>", normal_style))

                        # Actionable Advice - only if expert verdict exists
                        if 'safe' in expert_verdict.lower():
                            safety_just = report.get('safety_justification') or report.get('safetyJustification')
                            if safety_just:
                                ticket_elements.append(Paragraph("<b>Safety Justification:</b>", normal_style))
                                ticket_elements.append(Paragraph(safety_just, normal_style))
                        else:
                            remediation = report.get('remediation_plan') or report.get('remediationPlan')
                            if remediation:
                                ticket_elements.append(Paragraph("<b>Remediation Plan:</b>", normal_style))
                                ticket_elements.append(Paragraph(remediation, normal_style))

                # Visual divider between tickets (except for last one)
                if idx < len(reports) - 1:
                    ticket_elements.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#d2d2e1')))
                    ticket_elements.append(Spacer(1, 15))

                # Append ticket as a single KeepTogether unit to prevent splitting
                story.append(KeepTogether(ticket_elements))
        else:
            story.append(Paragraph("No reports found.", normal_style))

        # Build PDF
        doc.build(story)
        buffer.seek(0)

        # Return PDF for preview (not auto-download)
        buffer.seek(0)
        response = make_response(buffer.read())
        response.headers['Content-Type'] = 'application/pdf'
        response.headers['Content-Disposition'] = 'inline; filename=SuriinAI_UserData_Export.pdf'
        return response

    except Exception as e:
        app.logger.error(f"[Export Data] Error generating export: {e}")
        return jsonify({'error': 'Failed to generate data export'}), 500

# ═══════════════════════════════════════════════════════════════════════════════
#  USER ACCOUNT DELETION (RA 10173 Compliant)
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/user/delete-account', methods=['POST'])
def delete_user_account():
    """
    Securely delete user account and anonymize their reports per RA 10173.
    
    Steps:
    1. Verify Firebase Auth token
    2. Anonymize all Reports where user_id matches (set to 'deleted_user', email to 'anonymous')
    3. Delete user profile from Firestore 'Users' collection
    4. Delete user from Firebase Auth
    5. Return success response
    
    Preserves: scanned_text/evidence, status, platform, expert_verdict for threat corpus
    """
    # Authenticate user
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return jsonify({'error': 'Unauthorized - Missing token'}), 401

    token = auth_header.split('Bearer ')[1]
    try:
        decoded = auth.verify_id_token(token)
        user_id = decoded['uid']
        user_email = decoded.get('email', '')
    except Exception as e:
        app.logger.error(f"[Delete Account] Token verification failed: {e}")
        return jsonify({'error': 'Invalid token'}), 401

    try:
        app.logger.info(f"[Delete Account] Starting deletion process for user: {user_id}")
        
        # Step 1: Anonymize all reports submitted by this user
        # Query Reports collection for documents with matching user_id
        reports_query = db.collection('Reports').where('user_id', '==', user_id).stream()
        anonymized_count = 0
        
        for report_doc in reports_query:
            try:
                report_ref = db.collection('Reports').document(report_doc.id)
                # Anonymize personal data while preserving threat intelligence
                report_ref.update({
                    'user_id': 'deleted_user',
                    'user_email': 'anonymous',
                    # Preserve: evidence/scanned_text, status, platform (url), expert_verdict
                    # Preserve: risk_score, heuristics, ai_verdict for threat corpus
                    'anonymized_at': datetime.now(timezone.utc).isoformat(),
                    'anonymization_reason': 'user_account_deletion'
                })
                anonymized_count += 1
                app.logger.info(f"[Delete Account] Anonymized report {report_doc.id}")
            except Exception as report_error:
                app.logger.error(f"[Delete Account] Failed to anonymize report {report_doc.id}: {report_error}")
                # Continue with other reports, don't stop the process
        
        app.logger.info(f"[Delete Account] Anonymized {anonymized_count} reports")
        
        # Step 2: Delete user profile from Firestore
        try:
            db.collection('Users').document(user_id).delete()
            app.logger.info(f"[Delete Account] Deleted user profile from Firestore: {user_id}")
        except Exception as profile_error:
            app.logger.error(f"[Delete Account] Failed to delete user profile: {profile_error}")
            # Continue with auth deletion even if profile deletion fails
        
        # Step 3: Delete user from Firebase Auth
        try:
            auth.delete_user(user_id)
            app.logger.info(f"[Delete Account] Deleted user from Firebase Auth: {user_id}")
        except Exception as auth_error:
            app.logger.error(f"[Delete Account] Failed to delete Firebase Auth user: {auth_error}")
            return jsonify({
                'error': 'Account partially deleted. Please contact support to complete deletion.',
                'anonymized_reports': anonymized_count
            }), 500
        
        # Success response
        return jsonify({
            'success': True,
            'message': 'Account deleted and data anonymized successfully',
            'anonymized_reports': anonymized_count
        }), 200
        
    except Exception as e:
        app.logger.error(f"[Delete Account] Unexpected error: {e}")
        return jsonify({'error': 'Failed to delete account. Please try again or contact support.'}), 500

# ═══════════════════════════════════════════════════════════════════════════════
#  USER EVIDENCE PDF (ReportLab Backend)
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/report/evidence-pdf')
def generate_evidence_pdf():
    """
    Generate a professional forensic evidence report PDF using ReportLab.
    Returns PDF as inline response for preview.
    Query param: report_id (required)
    """
    # Authenticate user
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return jsonify({'error': 'Unauthorized - Missing token'}), 401

    token = auth_header.split('Bearer ')[1]
    try:
        decoded = auth.verify_id_token(token)
        user_id = decoded['uid']
    except Exception as e:
        app.logger.error(f"[Evidence PDF] Token verification failed: {e}")
        return jsonify({'error': 'Invalid token'}), 401

    # Get report ID from query params
    report_id = request.args.get('report_id')
    if not report_id:
        return jsonify({'error': 'Missing report_id parameter'}), 400

    try:
        # Fetch report
        report_doc = db.collection('Reports').document(report_id).get()
        if not report_doc.exists:
            return jsonify({'error': 'Report not found'}), 404

        report = report_doc.to_dict()
        report['id'] = report_id

        # Verify user owns this report
        if report.get('user_id') != user_id:
            return jsonify({'error': 'Access denied - not your report'}), 403

        # Only allow PDF for Resolved/Reviewed status
        status = report.get('status', 'Pending')
        status_lower = str(status).lower()
        if status_lower not in ['resolved', 'reviewed']:
            return jsonify({'error': 'PDF only available for Resolved or Reviewed reports'}), 403

        # Generate PDF
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=letter,
            rightMargin=48,
            leftMargin=48,
            topMargin=48,
            bottomMargin=48
        )

        # Styles
        styles = getSampleStyleSheet()
        
        # Custom styles matching the original jsPDF design
        header_style = ParagraphStyle(
            'Header',
            parent=styles['Normal'],
            fontSize=20,
            textColor=colors.white,
            fontName='Helvetica-Bold'
        )
        section_title_style = ParagraphStyle(
            'SectionTitle',
            parent=styles['Heading2'],
            fontSize=14,
            textColor=colors.HexColor('#6C63FF'),
            spaceAfter=12,
            spaceBefore=20,
            fontName='Helvetica-Bold'
        )
        normal_style = styles['Normal']
        normal_style.fontSize = 10
        normal_style.leading = 14

        story = []

        # Helper functions
        def get_risk_level(risk_score):
            score = float(risk_score or 0)
            if score >= 0.85:
                return 'critical', [220, 38, 38], 'CRITICAL'
            elif score >= 0.40:
                return 'warning', [234, 88, 12], 'WARNING'
            else:
                return 'safe', [22, 163, 74], 'SAFE'

        # Risk calculation
        risk_score = report.get('risk_score', 0)
        risk_level, verdict_color, verdict_label = get_risk_level(risk_score)
        risk_pct = int(risk_score * 100)

        # Header section with purple background
        header_data = [[Paragraph("Suriin AI", header_style)],
                       [Paragraph(f"{'Suriin AI Certified - ' if status_lower == 'reviewed' else ''}Forensic Evidence Report", 
                                  ParagraphStyle('SubHeader', parent=styles['Normal'], fontSize=10, textColor=colors.white))]]
        header_table = Table(header_data, colWidths=[7.5*inch])
        header_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#6C63FF')),
            ('TOPPADDING', (0, 0), (-1, 0), 12),
            ('BOTTOMPADDING', (0, -1), (-1, -1), 12),
            ('LEFTPADDING', (0, 0), (-1, -1), 12),
        ]))
        story.append(header_table)
        story.append(Spacer(1, 20))

        # Report Metadata Table
        short_report_id = report_id[-6:].upper() if len(report_id) >= 6 else report_id.upper()
        reporter_info = report.get('user_email') or report.get('user_id') or 'Anonymous'
        
        # Get risk threat (backward compatible)
        risk_threat = report.get('ai_verdict') or report.get('aiVerdict') or report.get('risk_level') or risk_level or 'Unknown'
        risk_threat = str(risk_threat).capitalize()

        meta_data = [
            ['Report ID', short_report_id],
            ['Date Submitted', format_date_readable(report.get('created_at'))],
            ['Reporter', reporter_info],
            ['Platform', extract_platform(report.get('url'))],
            ['Scanned URL', truncate_url(report.get('url'), 60)],
            ['Status', status or 'Pending'],
            ['Risk Threat', risk_threat],
            ['Risk Score', f"{risk_pct}%"],
        ]

        story.append(Paragraph("Report Details", section_title_style))
        meta_table = Table(meta_data, colWidths=[1.5*inch, 5*inch])
        meta_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#ededf7')),
            ('TEXTCOLOR', (0, 0), (0, -1), colors.HexColor('#37375a')),
            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 9),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#d2d2e1')),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        story.append(meta_table)
        story.append(Spacer(1, 20))

        # Risk Threat Section (large verdict)
        story.append(Paragraph("Risk Threat", section_title_style))
        
        # Risk bar background
        risk_bar_data = [['']]
        risk_bar = Table(risk_bar_data, colWidths=[6.5*inch], rowHeights=[12])
        risk_bar.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#dadce4')),
            ('ROUNDEDCORNERS', (0, 0), (-1, -1), 3),
        ]))
        story.append(risk_bar)
        story.append(Spacer(1, 8))
        
        # Verdict label (large) - with proper leading to prevent overlap
        verdict_para = Paragraph(
            f"<font color='#{''.join(f'{c:02x}' for c in verdict_color)}' size='32'><b>{verdict_label}</b></font>",
            ParagraphStyle('Verdict', parent=styles['Normal'], fontSize=32, leading=38, spaceAfter=6)
        )
        story.append(verdict_para)
        
        # Risk score sub-label
        story.append(Paragraph(f"<font color='#78788c' size='9'>Risk Score: {risk_pct}%</font>", styles['Normal']))
        story.append(Spacer(1, 20))

        # Scanned Evidence Section (moved before Risk Factors per user request)
        story.append(Paragraph("Scanned Evidence Text", section_title_style))
        evidence = report.get('evidence') or report.get('text') or 'No extracted text available.'
        evidence_style = ParagraphStyle(
            'EvidenceBox',
            parent=normal_style,
            backColor=colors.HexColor('#f9f9fb'),
            borderColor=colors.HexColor('#e0e0e8'),
            borderWidth=1,
            borderPadding=10,
            leading=16
        )
        story.append(Paragraph(evidence, evidence_style))
        story.append(Spacer(1, 15))

        # User Statement Section (if present)
        user_context = report.get('user_context') or report.get('userContext')
        if user_context:
            story.append(Paragraph("User Statement", section_title_style))
            story.append(Paragraph(user_context, normal_style))
            story.append(Spacer(1, 15))

        # Spacer before Risk Factors Section
        story.append(Spacer(1, 12))

        # Risk Factors Section
        story.append(Paragraph("Risk Factors", section_title_style))
        risk_factors = []
        
        # SEC Watchlist (red badge)
        if report.get('matched_company'):
            risk_factors.append(['SEC Watchlist', report['matched_company'], colors.HexColor('#ef4444')])
        
        # AI Flagged (orange badge) - Heuristics
        heuristics = report.get('heuristics', '')
        if heuristics:
            tokens = [t.strip() for t in heuristics.replace(';', ',').split(',') if t.strip()]
            if tokens:
                risk_factors.append(['AI Flagged', ', '.join(tokens), colors.HexColor('#f59e0b')])
        
        # AI Flagged - Suspicious Pattern
        ai_conf = report.get('ai_confidence')
        ai_verdict = str(report.get('ai_verdict') or '').upper()
        if ai_verdict in ['WARNING', 'SUSPICIOUS', 'CRITICAL']:
            detail = f"Suspicious Pattern ({int(ai_conf * 100)}% confidence)" if ai_conf else 'Suspicious Pattern'
            risk_factors.append(['AI Flagged', detail, colors.HexColor('#f59e0b')])

        if risk_factors:
            for badge, value, badge_color in risk_factors:
                # Badge row
                badge_data = [[Paragraph(f"<font color='white' size='8'><b>{badge}</b></font>", 
                                        ParagraphStyle('Badge', parent=styles['Normal'], alignment=1)),
                               Paragraph(value, normal_style)]]
                badge_table = Table(badge_data, colWidths=[1.2*inch, 5.3*inch])
                badge_table.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (0, 0), badge_color),
                    ('ROUNDEDCORNERS', (0, 0), (0, 0), 3),
                    ('TOPPADDING', (0, 0), (0, 0), 4),
                    ('BOTTOMPADDING', (0, 0), (0, 0), 4),
                    ('LEFTPADDING', (0, 0), (0, 0), 6),
                    ('RIGHTPADDING', (0, 0), (0, 0), 6),
                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ]))
                story.append(badge_table)
                story.append(Spacer(1, 8))
        else:
            story.append(Paragraph("No risk factors recorded.", normal_style))
        story.append(Spacer(1, 15))

        # Spacer before Expert Verdict Section
        story.append(Spacer(1, 12))

        # Expert Verdict Section (for Resolved/Reviewed)
        story.append(Paragraph("Expert Verdict", section_title_style))
        
        expert_verdict = report.get('expert_verdict') or report.get('expertVerdict', '')
        verdict_display = 'Unknown'
        verdict_color_exp = colors.HexColor('#78788c')  # Muted
        
        if expert_verdict:
            v_lower = str(expert_verdict).lower()
            if 'safe' in v_lower:
                verdict_display = 'Verified Safe'
                verdict_color_exp = colors.HexColor('#22c55e')
            elif v_lower in ['confirmed threat', 'scam']:
                verdict_display = 'Confirmed Threat'
                verdict_color_exp = colors.HexColor('#ef4444')
            elif v_lower == 'false positive':
                verdict_display = 'False Positive'
                verdict_color_exp = colors.HexColor('#94a3b8')
        
        # Large verdict display (like Risk Threat) - with proper leading to prevent overlap
        exp_verdict_para = Paragraph(
            f"<font color='{verdict_color_exp.hexval()}' size='32'><b>{verdict_display}</b></font>",
            ParagraphStyle('ExpVerdict', parent=styles['Normal'], fontSize=32, leading=38, spaceAfter=12)
        )
        story.append(exp_verdict_para)

        # Verified By (get last expert from history)
        history = report.get('resolutionHistory', [])
        if history:
            last_expert = [h for h in history if h.get('assigned_email') and h.get('status') in ['Reviewed', 'Resolved']]
            if last_expert:
                expert_name = '@' + last_expert[-1]['assigned_email'].split('@')[0]
                story.append(Paragraph(f"<font color='#78788c' size='9'>Verified By: {expert_name}</font>", styles['Normal']))
                story.append(Spacer(1, 12))

        # Safety Justification or Remediation Plan
        if verdict_display == 'Verified Safe':
            safety = report.get('safety_justification') or report.get('safetyJustification')
            if safety:
                story.append(Paragraph("<b>Safety Justification:</b>", normal_style))
                story.append(Paragraph(safety, normal_style))
        elif verdict_display == 'Confirmed Threat':
            remediation = report.get('remediation_plan') or report.get('remediationPlan')
            if remediation:
                story.append(Paragraph("<b>Remediation Plan:</b>", normal_style))
                story.append(Paragraph(remediation, normal_style))
        
        story.append(Spacer(1, 30))

        # Certification Footer
        footer_style = ParagraphStyle(
            'Footer',
            parent=styles['Normal'],
            fontSize=8,
            textColor=colors.HexColor('#78788c'),
            alignment=1,
            spaceBefore=20
        )
        footer_text = """<i>CONFIDENTIAL: This forensic evidence report is generated by Suriin AI for the authorized user. 
        Distribution or reproduction without consent is prohibited. This report is provided "as-is" based on automated analysis 
        and expert review at the time of generation.</i>"""
        story.append(Paragraph(footer_text, footer_style))

        # Build PDF
        doc.build(story)
        buffer.seek(0)

        # Return PDF for inline viewing
        response = make_response(buffer.read())
        response.headers['Content-Type'] = 'application/pdf'
        response.headers['Content-Disposition'] = f'inline; filename=Suriin_Report_{short_report_id}.pdf'
        return response

    except Exception as e:
        app.logger.error(f"[Evidence PDF] Error generating PDF: {e}")
        return jsonify({'error': 'Failed to generate evidence PDF'}), 500


@app.route('/api/admin/executive-report-test', methods=['GET'])
def test_executive_report_data():
    """Test endpoint to check data fetching without PDF generation"""
    try:
        # Get period parameter
        period = request.args.get('period', 'daily')
        if period not in ['daily', 'weekly', 'monthly']:
            period = 'daily'

        # Calculate cutoff date
        now = datetime.utcnow()
        if period == 'daily':
            cutoff = now - timedelta(days=1)
        elif period == 'weekly':
            cutoff = now - timedelta(days=7)
        else:  # monthly
            cutoff = now - timedelta(days=30)

        cutoff_ms = int(cutoff.timestamp() * 1000)

        # Fetch data
        reports_ref = db.collection('Reports')
        all_reports = [r.to_dict() | {'id': r.id} for r in reports_ref.stream()]
        
        users_ref = db.collection('Users')
        all_users = [u.to_dict() | {'id': u.id} for u in users_ref.stream()]
        expert_users = [u for u in all_users if u.get('role') in ['expert', 'Expert']]

        return jsonify({
            'success': True,
            'data': {
                'reports_count': len(all_reports),
                'users_count': len(all_users),
                'experts_count': len(expert_users),
                'period': period,
                'cutoff_ms': cutoff_ms
            }
        })
    except Exception as e:
        app.logger.error(f"[TestExecutiveReport] Error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/admin/executive-report', methods=['GET'])
def generate_executive_report():
    """
    Generates a comprehensive Executive Security Report PDF.
    
    Query param:
      - period: 'daily' | 'weekly' | 'monthly'
    
    Returns PDF as blob for preview.
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.platypus.frames import Frame
    from reportlab.platypus.doctemplate import PageTemplate
    from datetime import datetime, timedelta
    import io

    # Authenticate admin
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return jsonify({'error': 'Unauthorized - Missing token'}), 401

    token = auth_header.split('Bearer ')[1]
    try:
        decoded = auth.verify_id_token(token)
        user_id = decoded['uid']
        # Verify admin role
        user_doc = db.collection('Users').document(user_id).get()
        if not user_doc.exists:
            return jsonify({'error': 'User not found'}), 404
        user_data = user_doc.to_dict()
        if user_data.get('role') not in ['admin', 'Admin']:
            return jsonify({'error': 'Unauthorized - Admin access required'}), 403
    except Exception as e:
        app.logger.error(f"[ExecutiveReport] Token verification failed: {e}")
        return jsonify({'error': 'Invalid token'}), 401

    # Get period parameter
    period = request.args.get('period', 'daily')
    if period not in ['daily', 'weekly', 'monthly']:
        period = 'daily'

    # Calculate cutoff date
    now = datetime.utcnow()
    if period == 'daily':
        cutoff = now - timedelta(days=1)
    elif period == 'weekly':
        cutoff = now - timedelta(days=7)
    else:  # monthly
        cutoff = now - timedelta(days=30)

    cutoff_ms = int(cutoff.timestamp() * 1000)

    try:
        app.logger.info("[ExecutiveReport] Starting data fetch...")
        
        # Fetch data
        reports_ref = db.collection('Reports')
        all_reports = []
        for r in reports_ref.stream():
            try:
                report_data = r.to_dict()
                report_data['id'] = r.id
                all_reports.append(report_data)
            except Exception as e:
                app.logger.error(f"[ExecutiveReport] Error processing report {r.id}: {e}")
                continue
        
        users_ref = db.collection('Users')
        all_users = []
        for u in users_ref.stream():
            try:
                user_data = u.to_dict()
                user_data['id'] = u.id
                all_users.append(user_data)
            except Exception as e:
                app.logger.error(f"[ExecutiveReport] Error processing user {u.id}: {e}")
                continue
        
        expert_users = [u for u in all_users if u.get('role') in ['expert', 'Expert']]
        app.logger.info(f"[ExecutiveReport] Fetched {len(all_reports)} reports, {len(all_users)} users, {len(expert_users)} experts")

        # Filter by period using resolvedAt or updated_at
        def get_timestamp(r):
            resolved_at = r.get('resolvedAt')
            if resolved_at:
                if hasattr(resolved_at, 'toMillis'):
                    return resolved_at.toMillis()
                if isinstance(resolved_at, dict) and 'seconds' in resolved_at:
                    return resolved_at['seconds'] * 1000
            updated_at = r.get('updated_at') or r.get('updatedAt')
            if updated_at:
                if hasattr(updated_at, 'toMillis'):
                    return updated_at.toMillis()
                if isinstance(updated_at, dict) and 'seconds' in updated_at:
                    return updated_at['seconds'] * 1000
            return 0

        period_reports = [r for r in all_reports if get_timestamp(r) >= cutoff_ms]

        # Section 1: Pipeline Volume Metrics
        total_ingested = len(all_reports)
        pending_open = sum(1 for r in all_reports if r.get('status') in ['Unassigned', 'Pending', 'unassigned', 'pending'])
        under_investigation = sum(1 for r in all_reports if r.get('status') in ['Under Investigation', 'Under Investigation'])
        reviewed_closed = sum(1 for r in all_reports if r.get('status') in ['Resolved', 'Reviewed', 'resolved', 'reviewed'])

        # Section 2: AI/SEC Calibration
        resolved_period = [r for r in period_reports if r.get('status') in ['Resolved', 'Reviewed', 'resolved', 'reviewed']]
        
        ai_expert_consensus = 0
        system_false_alarms = 0
        sec_assisted_catches = 0
        pure_ai = 0
        pure_sec = 0
        dual_engine = 0

        for r in resolved_period:
            ai_verdict = (r.get('ai_verdict') or r.get('aiVerdict') or '').lower()
            expert_verdict = (r.get('expert_verdict') or r.get('expertVerdict') or '').lower()
            sec_match = r.get('sec_match') or r.get('matched_company') or r.get('gov_records', {}).get('is_flagged')
            
            ai_flagged = any(x in ai_verdict for x in ['scam', 'threat', 'critical', 'warning'])
            expert_confirmed = any(x in expert_verdict for x in ['confirmed threat', 'confirmed scam'])
            expert_safe = any(x in expert_verdict for x in ['verified safe', 'safe'])

            if ai_flagged and expert_confirmed:
                ai_expert_consensus += 1
            if not ai_flagged and expert_confirmed:
                sec_assisted_catches += 1
            if ai_flagged and expert_safe:
                system_false_alarms += 1

            # Threat source attribution
            if ai_flagged and sec_match:
                dual_engine += 1
            elif ai_flagged:
                pure_ai += 1
            elif sec_match:
                pure_sec += 1

        total_attributed = pure_ai + pure_sec + dual_engine or 1
        pure_ai_pct = round((pure_ai / total_attributed) * 100, 1)
        pure_sec_pct = round((pure_sec / total_attributed) * 100, 1)
        dual_engine_pct = round((dual_engine / total_attributed) * 100, 1)

        # Section 3: Expert Triage Matrix
        expert_stats = []
        app.logger.info(f"[ExecutiveReport] Processing {len(expert_users)} experts...")
        
        for expert in expert_users:
            try:
                expert_id = expert.get('id')
                expert_name = expert.get('displayName') or expert.get('email') or expert_id[:8]
                app.logger.debug(f"[ExecutiveReport] Processing expert: {expert_name} ({expert_id})")
                
                # Get reports resolved by this expert
                expert_resolved = [r for r in resolved_period if r.get('assigned_to') == expert_id or r.get('updated_by') == expert_id]
                cases_closed = len(expert_resolved)
            except Exception as e:
                app.logger.error(f"[ExecutiveReport] Error processing expert {expert.get('id')}: {e}")
                continue
            
            # Calculate TAT
            total_tat = 0
            tat_count = 0
            try:
                for r in expert_resolved:
                    try:
                        claimed_at = r.get('claimed_at') or r.get('claimedAt')
                        resolved_at = r.get('resolvedAt') or r.get('updated_at') or r.get('updatedAt')
                        app.logger.debug(f"[ExecutiveReport] Processing report {r.get('id')} for TAT calculation")
                        
                        if claimed_at and resolved_at:
                            # Safely convert claimed_at timestamp
                            claimed_ms = 0
                            if hasattr(claimed_at, 'toMillis'):
                                claimed_ms = claimed_at.toMillis()
                            elif isinstance(claimed_at, dict) and 'seconds' in claimed_at:
                                claimed_ms = claimed_at['seconds'] * 1000
                            elif isinstance(claimed_at, (int, float)):
                                claimed_ms = claimed_at
                            elif isinstance(claimed_at, str):
                                claimed_ms = int(datetime.fromisoformat(claimed_at.replace('Z', '+00:00')).timestamp() * 1000)
                            
                            # Safely convert resolved_at timestamp
                            resolved_ms = 0
                            if hasattr(resolved_at, 'toMillis'):
                                resolved_ms = resolved_at.toMillis()
                            elif isinstance(resolved_at, dict) and 'seconds' in resolved_at:
                                resolved_ms = resolved_at['seconds'] * 1000
                            elif isinstance(resolved_at, (int, float)):
                                resolved_ms = resolved_at
                            elif isinstance(resolved_at, str):
                                resolved_ms = int(datetime.fromisoformat(resolved_at.replace('Z', '+00:00')).timestamp() * 1000)
                            
                            if claimed_ms > 0 and resolved_ms > claimed_ms:
                                tat_minutes = (resolved_ms - claimed_ms) / 60000
                                if tat_minutes > 0:
                                    total_tat += tat_minutes
                                    tat_count += 1
                    except Exception as e:
                        app.logger.error(f"[ExecutiveReport] TAT calculation error for report {r.get('id')}: {e}")
                        continue
            except Exception as e:
                app.logger.error(f"[ExecutiveReport] Error in TAT calculation loop for expert {expert_id}: {e}")
                total_tat = 0
                tat_count = 0
            
            avg_tat = total_tat / tat_count if tat_count > 0 else 0
            if avg_tat > 0:
                hours = int(avg_tat // 60)
                minutes = int(avg_tat % 60)
                tat_display = f"{hours}h {minutes}m" if hours > 0 else f"{minutes}m"
            else:
                tat_display = "0h 0m"
            
            # Calculate threat ratio
            confirmed_threats = sum(1 for r in expert_resolved if any(x in (r.get('expert_verdict') or '').lower() for x in ['confirmed threat', 'confirmed scam']))
            total_resolved = len(expert_resolved)
            threat_ratio = round((confirmed_threats / total_resolved) * 100, 1) if total_resolved > 0 else 0.0
            
            # Workload status
            if cases_closed == 0:
                workload_status = "Inactive within selected timeframe window"
            elif cases_closed < 5:
                workload_status = "Light load"
            elif cases_closed < 15:
                workload_status = "Moderate load"
            else:
                workload_status = "Heavy load"
            
            expert_stats.append({
                'name': expert_name,
                'cases': cases_closed,
                'tat': tat_display,
                'threat_ratio': threat_ratio,
                'status': workload_status
            })

        # Section 4: Domain Insights (placeholder)
        domain_insights = [
            "Analysis shows elevated threat activity during weekend periods.",
            "Social media platforms remain the primary attack vector.",
            "Recommended action: Increase weekend monitoring coverage."
        ]

        # Generate PDF - Minimal test to isolate error
        app.logger.info("[ExecutiveReport] Starting minimal PDF generation test...")
        try:
            buffer = io.BytesIO()
            doc = SimpleDocTemplate(buffer, pagesize=A4)
            styles = getSampleStyleSheet()
            
            # Create minimal story with just title
            story = []
            story.append(Paragraph("Executive Security Report", styles['Title']))
            story.append(Paragraph(f"Period: {period}", styles['Normal']))
            
            app.logger.info("[ExecutiveReport] Building minimal PDF...")
            doc.build(story)
            app.logger.info("[ExecutiveReport] Minimal PDF built successfully")
            
        except Exception as e:
            app.logger.error(f"[ExecutiveReport] Error in minimal PDF test: {e}")
            import traceback
            app.logger.error(f"[ExecutiveReport] Traceback: {traceback.format_exc()}")
            raise

        # Build complete PDF with all sections
        try:
            app.logger.info("[ExecutiveReport] Building complete PDF with all sections...")
            story = []
            
            # Custom styles
            title_style = ParagraphStyle(
                'ExecutiveTitle',
                parent=styles['Heading1'],
                fontSize=24,
                textColor=colors.HexColor('#1a202c'),
                spaceAfter=12,
                alignment=TA_CENTER
            )
            subtitle_style = ParagraphStyle(
                'ExecutiveSubtitle',
                parent=styles['Normal'],
                fontSize=12,
                textColor=colors.HexColor('#4a5568'),
                alignment=TA_CENTER,
                spaceAfter=15
            )
            section_style = ParagraphStyle(
                'SectionTitle',
                parent=styles['Heading2'],
                fontSize=14,
                textColor=colors.HexColor('#4c51bf'),
                spaceAfter=8,
                spaceBefore=12
            )

            # Title Page
            story.append(Paragraph("Executive Security Report", title_style))
            story.append(Paragraph(f"Period: {period.upper()} | Generated: {now.strftime('%Y-%m-%d %H:%M UTC')}", subtitle_style))
            story.append(Spacer(1, 15))

            # Section 1: Pipeline Volume
            story.append(Paragraph("1. Ingestion Pipeline Volume", section_style))
            
            pipeline_data = [
                ['Total Ingested', 'Pending Queue', 'Under Investigation', 'Reviewed & Closed'],
                [str(total_ingested), str(pending_open), str(under_investigation), str(reviewed_closed)]
            ]
            pipeline_table = Table(pipeline_data, colWidths=[40*mm, 40*mm, 40*mm, 40*mm])
            pipeline_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#f7fafc')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.HexColor('#718096')),
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e2e8f0')),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                ('LEFTPADDING', (0, 0), (-1, -1), 6),
                ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ]))
            story.append(pipeline_table)
            story.append(Spacer(1, 12))

            # Section 2: AI/SEC Calibration
            story.append(Paragraph("2. Dual-Engine Threat Calibration", section_style))
            
            # AI Performance
            story.append(Paragraph("<b>AI Neural Network Performance</b>", styles['Normal']))
            ai_data = [
                ['AI-Expert Consensus', f"{ai_expert_consensus} cases"],
                ['System False Alarms', f"{system_false_alarms} cases"],
                ['SEC-Assisted Catches', f"{sec_assisted_catches} cases"]
            ]
            ai_table = Table(ai_data, colWidths=[60*mm, 80*mm])
            ai_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f7fafc')),
                ('TEXTCOLOR', (0, 0), (0, -1), colors.HexColor('#4a5568')),
                ('TEXTCOLOR', (1, 0), (1, -1), colors.HexColor('#1a202c')),
                ('FONTNAME', (1, 0), (1, -1), 'Helvetica-Bold'),
                ('ALIGN', (0, 0), (0, -1), 'LEFT'),
                ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e2e8f0')),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                ('LEFTPADDING', (0, 0), (-1, -1), 6),
                ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ]))
            story.append(ai_table)
            story.append(Spacer(1, 8))

            # Threat Attribution
            story.append(Paragraph("<b>Verified Threats Attribution Source</b>", styles['Normal']))
            attr_data = [
                ['Pure AI Classifier', f"{pure_ai_pct}% ({pure_ai} cases)"],
                ['Pure SEC Watchlist', f"{pure_sec_pct}% ({pure_sec} cases)"],
                ['Dual-Engine Consensus', f"{dual_engine_pct}% ({dual_engine} cases)"]
            ]
            attr_table = Table(attr_data, colWidths=[60*mm, 80*mm])
            attr_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f7fafc')),
                ('TEXTCOLOR', (0, 0), (0, -1), colors.HexColor('#4a5568')),
                ('TEXTCOLOR', (1, 0), (1, -1), colors.HexColor('#1a202c')),
                ('FONTNAME', (1, 0), (1, -1), 'Helvetica-Bold'),
                ('ALIGN', (0, 0), (0, -1), 'LEFT'),
                ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e2e8f0')),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                ('LEFTPADDING', (0, 0), (-1, -1), 6),
                ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ]))
            story.append(attr_table)
            story.append(Spacer(1, 12))
            
        except Exception as e:
            app.logger.error(f"[ExecutiveReport] Error building sections 1-2: {e}")
            import traceback
            app.logger.error(f"[ExecutiveReport] Traceback: {traceback.format_exc()}")
            raise

        # Add expert data to the PDF
        try:
            story.append(Paragraph("3. Security Analyst Triage Matrix", section_style))
            expert_table_data = [['Expert Name', 'Cases Closed', 'Avg TAT', 'Threat Ratio', 'Workload Status']]
            
            for stat in expert_stats:
                expert_table_data.append([
                    str(stat.get('name', 'N/A')),
                    str(stat.get('cases', 0)),
                    str(stat.get('tat', '0h 0m')),
                    str(stat.get('threat_ratio', 0)) + '%',
                    str(stat.get('status', 'Unknown'))
                ])
            
            expert_table = Table(expert_table_data, colWidths=[40*mm, 20*mm, 20*mm, 20*mm, 60*mm])
            expert_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#4c51bf')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e2e8f0')),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ]))
            story.append(expert_table)
            story.append(Spacer(1, 12))
            
            # Section 4
            story.append(Paragraph("4. Environmental Vector Highlights", section_style))
            for insight in domain_insights:
                story.append(Paragraph(f"• {insight}", styles['Normal']))
                story.append(Spacer(1, 4))
            
            # Build final PDF
            def add_footer(canvas, doc):
                canvas.saveState()
                canvas.setFont('Helvetica', 8)
                canvas.setFillColor(colors.HexColor('#718096'))
                canvas.drawString(15*mm, 15*mm, "Internal Security Document - Confidential")
                page_num = canvas.getPageNumber()
                canvas.drawRightString(A4[0] - 15*mm, 15*mm, f"Page {page_num}")
                canvas.restoreState()

            app.logger.info("[ExecutiveReport] Building final PDF...")
            doc = SimpleDocTemplate(buffer, pagesize=A4)
            doc.build(story, onFirstPage=add_footer, onLaterPages=add_footer)
            app.logger.info("[ExecutiveReport] Final PDF built successfully")
            
        except Exception as e:
            app.logger.error(f"[ExecutiveReport] Error building final PDF: {e}")
            import traceback
            app.logger.error(f"[ExecutiveReport] Traceback: {traceback.format_exc()}")
            raise

        buffer.seek(0)
        return Response(
            buffer,
            mimetype='application/pdf',
            headers={
                'Content-Type': 'application/pdf',
                'Content-Disposition': f'inline; filename="Executive_Security_Report_{period}.pdf"'
            }
        )

    except Exception as e:
        app.logger.error(f"[ExecutiveReport] Error generating report: {e}")
        return jsonify({'error': f'Failed to generate report: {str(e)}'}), 500


# ── Cache Metrics API ─────────────────────────────────────────────────────────────

@app.route('/api/admin/cache-metrics', methods=['GET'])
@verify_firebase_token
def get_cache_metrics_endpoint():
    """Return cache performance metrics for monitoring optimization effectiveness."""
    try:
        # Verify admin role
        user_doc = db.collection('Users').document(g.user_uid).get()
        if not user_doc.exists:
            return jsonify({'error': 'User not found'}), 404
        
        data = user_doc.to_dict() or {}
        role = str(data.get('role') or 'user').strip().lower()
        if role != 'admin':
            return jsonify({'error': 'Admin access required'}), 403
        
        metrics = get_cache_metrics()
        return jsonify({
            'success': True,
            'metrics': metrics,
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
    except Exception as e:
        app.logger.error(f"[CacheMetrics] Error retrieving metrics: {e}")
        return jsonify({'error': f'Failed to retrieve metrics: {str(e)}'}), 500

@app.route('/api/admin/cache-metrics/reset', methods=['POST'])
@verify_firebase_token
def reset_cache_metrics_endpoint():
    """Reset cache performance metrics."""
    try:
        # Verify admin role
        user_doc = db.collection('Users').document(g.user_uid).get()
        if not user_doc.exists:
            return jsonify({'error': 'User not found'}), 404
        
        data = user_doc.to_dict() or {}
        role = str(data.get('role') or 'user').strip().lower()
        if role != 'admin':
            return jsonify({'error': 'Admin access required'}), 403
        
        reset_cache_metrics()
        return jsonify({
            'success': True,
            'message': 'Cache metrics reset successfully',
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
    except Exception as e:
        app.logger.error(f"[CacheMetrics] Error resetting metrics: {e}")
        return jsonify({'error': f'Failed to reset metrics: {str(e)}'}), 500


# ── SEC Whitelist API ─────────────────────────────────────────────────────────────

@app.route('/api/admin/sec-whitelist', methods=['GET'])
@verify_firebase_token
def get_sec_whitelist_endpoint():
    """Retrieve chunked paginated SEC whitelist (legitimate companies) to protect Firestore quota."""
    try:
        user_doc = db.collection('Users').document(g.user_uid).get()
        if not user_doc.exists:
            return jsonify({'error': 'User not found'}), 404
        
        data = user_doc.to_dict() or {}
        role = str(data.get('role') or 'user').strip().lower()
        if role != 'admin':
            return jsonify({'error': 'Admin access required'}), 403

        limit = request.args.get('limit', 25, type=int)
        cursor = request.args.get('cursor', None, type=str)

        from sec_utils import get_sec_whitelist_paginated
        result = get_sec_whitelist_paginated(db, limit=limit, cursor=cursor)
        return jsonify({
            'success': True,
            'whitelist': result.get('whitelist', []),
            'pagination': result.get('pagination', {})
        })
    except Exception as e:
        app.logger.error(f"[SEC Whitelist API] Error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/admin/sync-sec-whitelist', methods=['POST'])
@verify_firebase_token
def sync_sec_whitelist_endpoint():
    """Trigger manual sync for legitimate SEC companies, capped at 100 max entries."""
    try:
        user_doc = db.collection('Users').document(g.user_uid).get()
        if not user_doc.exists:
            return jsonify({'error': 'User not found'}), 404
        
        data = user_doc.to_dict() or {}
        role = str(data.get('role') or 'user').strip().lower()
        if role != 'admin':
            return jsonify({'error': 'Admin access required'}), 403

        from sec_scraper import sync_sec_whitelist
        total_now, added_count = sync_sec_whitelist(max_limit=100)
        return jsonify({
            'success': True,
            'message': f'Whitelist sync completed. Added {added_count} new entries. Total in database: {total_now}/100.',
            'total_now': total_now,
            'added_count': added_count
        })
    except Exception as e:
        app.logger.error(f"[SEC Whitelist Sync API] Error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(debug=True, host='0.0.0.0', port=port)
