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

from flask import Flask, render_template, request, jsonify, g
from flask_cors import CORS, cross_origin
from flask_mail import Mail, Message
from dotenv import load_dotenv

# ── Load environment variables ─────────────────────────────────────────────────
load_dotenv()

# ── Firebase Admin SDK initialization ──────────────────────────────────────────
# NOTE: Place your serviceAccountKey.json in the project root.
# Download it from: Firebase Console → Project Settings → Service Accounts
#                   → Generate New Private Key
import firebase_admin
from firebase_admin import credentials, firestore, auth

SERVICE_ACCOUNT_PATH = os.getenv(
    'FIREBASE_SERVICE_ACCOUNT',
    os.path.join(os.path.dirname(__file__), 'serviceAccountKey.json')
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
            "\n[!] WARNING: serviceAccountKey.json not found!\n"
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
                'Firebase not initialized — serviceAccountKey.json is missing. '
                'Place it at: ' + SERVICE_ACCOUNT_PATH
            )
        _db = firestore.client()
    return _db

# ── Flask App ──────────────────────────────────────────────────────────────────
app = Flask(__name__)

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

# Get Firestore client after app initialization
db = get_db()

# ═══════════════════════════════════════════════════════════════════════════════
#  AI MODEL LOADING
# ═══════════════════════════════════════════════════════════════════════════════
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'optimized_xlmr_scam_model')
WEIGHTS_PATH = os.path.join(MODEL_PATH, 'quantized_weights.pt')

print("[SuriinAI] Loading XLM-RoBERTa scam detection model...")
tokenizer = None
model = None
_model_infer_lock = threading.Lock()

# ═══════════════════════════════════════════════════════════════════════════════
#  LOCAL WATCHLIST (SEC / DTI)
# ═══════════════════════════════════════════════════════════════════════════════

LOCAL_BLACKLIST = [
    "JRL Kwarta Trading",
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
    from transformers import AutoTokenizer, AutoModelForSequenceClassification

    try:
        # Load tokenizer
        tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)

        # Load empty base architecture
        model = AutoModelForSequenceClassification.from_pretrained(
            'xlm-roberta-base',
            num_labels=2
        )

        # Apply dynamic quantization
        model = torch.quantization.quantize_dynamic(
            model,
            {torch.nn.Linear},
            dtype=torch.qint8
        )

        # Load the quantized weights
        model.load_state_dict(
            torch.load(WEIGHTS_PATH, map_location='cpu')
        )

        model.eval()  # Set to evaluation mode
        print("[SuriinAI] ✓ Model loaded successfully")

    except Exception as e:
        print(f"[SuriinAI] ✗ Model loading failed: {e}")
        print(f"[SuriinAI]   Model path: {MODEL_PATH}")
        print(f"[SuriinAI]   Weights path: {WEIGHTS_PATH}")
        tokenizer = None
        model = None

except ImportError as e:
    print(f"[SuriinAI] ✗ AI dependencies not installed: {e}")
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
        
        # Log the scan request (no user tracking for public endpoint)
        app.logger.info(f'Scan request: {text[:50]}...')
        
        # ── Concurrent Dual-Layer Evaluation (Official watchlist + AI) ─────────
        if model is None or tokenizer is None:
            return jsonify({
                'error': 'AI model not available - server may still be loading',
                'success': False
            }), 503

        def evaluate_watchlist(text_value: str):
            text_lower = text_value.lower()
            matched_entity = None
            for entry in LOCAL_BLACKLIST:
                if entry.lower() in text_lower:
                    matched_entity = entry
                    break

            return {
                'status': 'MATCHED' if matched_entity else 'CLEAN',
                'matched_company': matched_entity,
                'detail': (
                    f"Matched SEC/DTI Enforcement Advisory: {matched_entity}"
                    if matched_entity
                    else 'No watchlist match found.'
                )
            }

        def evaluate_ai_scan(text_value: str):
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
                    probabilities = torch.softmax(logits, dim=1)
                    predicted_class = torch.argmax(probabilities, dim=1).item()
                    confidence_score = probabilities[0][predicted_class].item()
                    scam_prob = probabilities[0][1].item() if probabilities.shape[1] > 1 else 0.0

            is_scam = float(scam_prob) >= 0.55

            if (not is_scam) and (0.45 <= float(scam_prob) < 0.55) and _AI_FENCELINE_KEYWORDS_RE.search(text_value):
                is_scam = True
                predicted_class = 1
                confidence_score = float(scam_prob)

            raw_matches = _AI_FENCELINE_KEYWORDS_RE.findall(text_value)
            trigger_tokens = list(dict.fromkeys(t.lower() for t in raw_matches))

            return {
                'status': 'SUSPICIOUS' if is_scam else 'CLEAN',
                'ai_confidence': round(float(scam_prob), 4),
                'trigger_tokens': trigger_tokens,
                'detail': (
                    f"AI flagged this message as suspicious (Scam category matching: {int(confidence_score * 100)}%)."
                    if is_scam
                    else f"AI found no suspicious patterns (Safe category matching: {int(confidence_score * 100)}%)."
                )
            }

        with ThreadPoolExecutor(max_workers=2) as executor:
            watchlist_future = executor.submit(evaluate_watchlist, text)
            ai_future = executor.submit(evaluate_ai_scan, text)
            watchlist = watchlist_future.result()
            ai_scan = ai_future.result()

        if watchlist['status'] == 'MATCHED':
            overall_status = 'CRITICAL'
            overall_score = 100
        elif ai_scan['status'] == 'SUSPICIOUS':
            overall_status = 'WARNING'
            overall_score = 75
        else:
            overall_status = 'SAFE'
            overall_score = 0

        legacy_status = overall_status.lower()

        breakdown = {
            'message_tone': {
                'is_flagged': ai_scan['status'] == 'SUSPICIOUS',
                'severity': 'warning' if ai_scan['status'] == 'SUSPICIOUS' else 'safe',
                'display_text': ai_scan['detail']
            },
            'gov_records': {
                'is_flagged': watchlist['status'] == 'MATCHED',
                'severity': 'critical' if watchlist['status'] == 'MATCHED' else 'safe',
                'display_text': watchlist['detail']
            }
        }

        legacy_message = (
            f"CRITICAL: {watchlist['detail']}"
            if overall_status == 'CRITICAL'
            else (
                "WARNING: AI flagged this message as suspicious."
                if overall_status == 'WARNING'
                else "SAFE: No watchlist match and AI found no suspicious patterns."
            )
        )

        result = {
            # New dual-layer payload
            'overall_status': overall_status,
            'overall_score': overall_score,
            'watchlist': watchlist,
            'ai_scan': ai_scan,

            # Legacy/compat fields
            'status': legacy_status,
            'confidence': overall_score / 100,
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

        # ── If Reviewed: trigger notification + email ─────────────────────
        if new_status in ('Resolved', 'Reviewed'):
            _trigger_resolution_notifications(report_id, uid, expert_notes)

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

        # Query staff notifications for this role
        notif_ref = db.collection('staff_notifications')
        query = notif_ref.where('targetRole', '==', role) \
                         .order_by('created_at', direction='DESCENDING') \
                         .limit(limit)

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
        app.logger.error(f'[Staff Notifications] Error: {str(e)}')
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
#  ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(debug=True, host='0.0.0.0', port=port)
