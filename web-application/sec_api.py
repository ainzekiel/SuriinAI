"""
sec_api.py — SEC Watchlist extraction and matching logic for Flask integration
"""
from flask import Blueprint, request, jsonify
from firebase_admin import firestore
from sec_utils import extract_org_entities, check_watchlist

sec_api = Blueprint('sec_api', __name__)

def get_firestore():
    return firestore.client()

@sec_api.route('/api/scan', methods=['POST'])
def scan_sec_watchlist():
    """
    POST /api/scan
    JSON: { "text": "..." }
    Returns: { "extracted_entities": [...], "sec_watchlist_hits": [...] }
    """
    data = request.get_json(force=True)
    text = data.get('text', '')
    if not text:
        return jsonify({"error": "Missing 'text' field in JSON."}), 400
    try:
        orgs = extract_org_entities(text)
        db = get_firestore()
        hits = []
        for org in orgs:
            result = check_watchlist(org, db=db)
            if result.get('match'):
                result['original_entity'] = org
                hits.append(result)
        return jsonify({
            "extracted_entities": orgs,
            "sec_watchlist_hits": hits
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
