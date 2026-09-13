"""
sec_utils.py — Utility functions for SEC Watchlist Cross-Referencing
"""
import os
import json
import time
import threading
import spacy
from thefuzz import process
from firebase_admin import firestore
from typing import List, Dict, Any

# Load spaCy model (en_core_web_sm)
try:
    nlp = spacy.load("en_core_web_sm")
except Exception:
    nlp = None  # Will raise in function if not loaded

# Global in-memory cache for the watchlist
# Cache schema: {"all": [...], "chunks": {cursor: [...], ...}, "metadata": {...}, "version": "..."}
_watchlist_cache = None
_watchlist_cache_lock = threading.Lock()
_last_cache_time = 0
_cache_version = "1.0"  # Cache versioning for schema changes
CACHE_EXPIRY_SECONDS = 21600  # Cache for 6 hours (SEC data changes infrequently)

# Entity extraction cache
_entity_cache = {}
_entity_cache_lock = threading.Lock()
_ENTITY_CACHE_TTL = 1800  # 30 minutes for entity extraction

# Cache performance metrics
_cache_metrics = {
    "hits": 0,
    "misses": 0,
    "entity_hits": 0,
    "entity_misses": 0,
    "last_reset": time.time()
}
_metrics_lock = threading.Lock()

# Pagination cache settings
DEFAULT_CHUNK_SIZE = 50  # Increased from 25 to reduce pagination requests
MAX_CACHED_CHUNKS = 10  # Limit memory usage

# Path for local fallback cache file
CACHE_FILE_PATH = os.path.join(os.path.dirname(__file__), 'sec_watchlist_cache.json')

# Hardcoded fallback list in case Firestore is unavailable and no local cache exists
HARDCODED_FALLBACK_WATCHLIST = [
    {"company_name": "PETROMOBIL", "sec_category": "Investment Scam/Illegal Trading", "source_url": "https://www.sec.gov.ph", "date_added": ""},
    {"company_name": "PETROMOBIL CORPORATION", "sec_category": "Investment Scam/Illegal Trading", "source_url": "https://www.sec.gov.ph", "date_added": ""},
    {"company_name": "JRL Kwarta Trading", "sec_category": "Investment Scam", "source_url": "https://www.sec.gov.ph", "date_added": ""},
    {"company_name": "Shawnsei Holdings", "sec_category": "Investment Scam", "source_url": "https://www.sec.gov.ph", "date_added": ""},
    {"company_name": "Peso Piggy", "sec_category": "Predatory/Illegal Lending", "source_url": "https://www.sec.gov.ph", "date_added": ""},
    {"company_name": "MocaMoca fake", "sec_category": "Predatory/Illegal Lending", "source_url": "https://www.sec.gov.ph", "date_added": ""},
    {"company_name": "Salamat Cash", "sec_category": "Predatory/Illegal Lending", "source_url": "https://www.sec.gov.ph", "date_added": ""},
    {"company_name": "Valley Loan", "sec_category": "Predatory/Illegal Lending", "source_url": "https://www.sec.gov.ph", "date_added": ""},
    {"company_name": "Fast Cash", "sec_category": "Predatory/Illegal Lending", "source_url": "https://www.sec.gov.ph", "date_added": ""},
]

def extract_org_entities(text: str) -> List[str]:
    """
    Extract organization names from text using spaCy NER with caching.
    Args:
        text (str): Input text (Taglish/Bislish/English)
    Returns:
        List[str]: List of organization names (ORG entities)
    """
    if not nlp:
        raise RuntimeError("spaCy model en_core_web_sm is not loaded. Run: python -m spacy download en_core_web_sm")
    
    # Check entity extraction cache first
    text_hash = hash(text.strip().lower())
    current_time = time.time()
    
    with _entity_cache_lock:
        if text_hash in _entity_cache:
            cached_result, timestamp = _entity_cache[text_hash]
            if current_time - timestamp < _ENTITY_CACHE_TTL:
                with _metrics_lock:
                    _cache_metrics["entity_hits"] += 1
                return cached_result
    
    # Perform entity extraction
    doc = nlp(text)
    orgs = [ent.text for ent in doc.ents if ent.label_ == "ORG"]
    
    # Cache the result
    with _entity_cache_lock:
        _entity_cache[text_hash] = (orgs, current_time)
        with _metrics_lock:
            _cache_metrics["entity_misses"] += 1
        
        # Clean up expired entries to prevent memory leaks
        expired_keys = []
        for key, (_, timestamp) in _entity_cache.items():
            if current_time - timestamp >= _ENTITY_CACHE_TTL:
                expired_keys.append(key)
        
        for key in expired_keys:
            del _entity_cache[key]
    
    return orgs

def get_cached_watchlist(db) -> List[Dict[str, Any]]:
    """
    Retrieves the SEC watchlist from cache or Firestore (legacy function for compatibility).
    """
    cache_data = get_cached_watchlist_paginated(db, limit=None, cursor=None)
    return cache_data.get("all", [])

def get_cached_watchlist_paginated(db, limit: int = DEFAULT_CHUNK_SIZE, cursor: str = None) -> Dict[str, Any]:
    """
    Retrieves SEC watchlist with paginated caching support.
    
    Args:
        db: Firestore database instance
        limit: Number of items to return (None for all)
        cursor: Pagination cursor (None for first page)
    
    Returns:
        Dict with keys: "all", "chunks", "metadata", "watchlist", "pagination"
    """
    global _watchlist_cache, _last_cache_time
    now = time.time()

    # Initialize cache structure if needed
    if _watchlist_cache is None:
        _watchlist_cache = {
            "all": [],
            "chunks": {},
            "metadata": {
                "total_count": 0,
                "last_updated": 0,
                "cursors": []
            },
            "version": _cache_version
        }

    # Check if cache needs refresh
    cache_expired = (now - _last_cache_time) > CACHE_EXPIRY_SECONDS
    cache_empty = len(_watchlist_cache["all"]) == 0

    # Track cache metrics
    if not cache_expired and not cache_empty:
        with _metrics_lock:
            _cache_metrics["hits"] += 1
    else:
        with _metrics_lock:
            _cache_metrics["misses"] += 1

    if cache_expired or cache_empty:
        with _watchlist_cache_lock:
            # Double-check after acquiring lock
            if cache_expired or cache_empty or len(_watchlist_cache["all"]) == 0:
                try:
                    print(f"[sec_utils] Fetching fresh SEC watchlist from Firestore (expired={cache_expired}, empty={cache_empty})...")
                    watchlist_ref = db.collection("sec_watchlist")
                    
                    # Implement incremental updates - only fetch documents newer than last cache time
                    if not cache_empty and _watchlist_cache["metadata"]["last_updated"] > 0:
                        # Incremental update - only get newer documents
                        last_updated_timestamp = _watchlist_cache["metadata"]["last_updated"]
                        docs = list(watchlist_ref.where('date_cached', '>', last_updated_timestamp).stream())
                        print(f"[sec_utils] Incremental update: fetching {len(docs)} new documents")
                        
                        # Merge new documents with existing cache
                        existing_ids = {item.get("doc_id") for item in _watchlist_cache["all"]}
                        new_data = []
                        
                        for doc in docs:
                            meta = doc.to_dict()
                            company_name = meta.get("company_name", "").strip()
                            if company_name and doc.id not in existing_ids:
                                new_data.append({
                                    "company_name": company_name,
                                    "sec_category": meta.get("sec_category") or meta.get("category") or "SEC/DTI Watchlist Match",
                                    "source_url": meta.get("source_url") or "https://www.sec.gov.ph",
                                    "date_added": meta.get("date_added") or meta.get("date_cached") or "",
                                    "doc_id": doc.id
                                })
                        
                        if new_data:
                            _watchlist_cache["all"].extend(new_data)
                            _watchlist_cache["metadata"]["total_count"] += len(new_data)
                            print(f"[sec_utils] Added {len(new_data)} new items to cache")
                    else:
                        # Full cache population
                        docs = list(watchlist_ref.order_by('date_added', direction='DESCENDING').stream())
                        all_data = []
                        
                        for doc in docs:
                            meta = doc.to_dict()
                            company_name = meta.get("company_name", "").strip()
                            if company_name:
                                all_data.append({
                                    "company_name": company_name,
                                    "sec_category": meta.get("sec_category") or meta.get("category") or "SEC/DTI Watchlist Match",
                                    "source_url": meta.get("source_url") or "https://www.sec.gov.ph",
                                    "date_added": meta.get("date_added") or meta.get("date_cached") or "",
                                    "doc_id": doc.id
                                })
                        
                        _watchlist_cache["all"] = all_data
                        _watchlist_cache["metadata"]["total_count"] = len(all_data)
                        print(f"[sec_utils] Full cache populated with {len(all_data)} items")
                    
                    # Update cache metadata
                    _watchlist_cache["metadata"]["last_updated"] = now
                    _watchlist_cache["version"] = _cache_version
                    _last_cache_time = now
                    
                    # Pre-cache chunks for efficiency
                    _precache_chunks(_watchlist_cache["all"])
                    
                    print(f"[sec_utils] Cache updated successfully. Total items: {_watchlist_cache['metadata']['total_count']}")
                    
                    # Save cache to local file for offline fallback
                    try:
                        with open(CACHE_FILE_PATH, 'w', encoding='utf-8') as f:
                            json.dump(_watchlist_cache, f, indent=2)
                    except Exception as cache_err:
                        print(f"[sec_utils] Warning: Failed to write cache file: {cache_err}")
                            
                except Exception as e:
                    print(f"[sec_utils] Error fetching watchlist from Firestore: {e}")
                    
                    # Fallback to local cache file
                    if len(_watchlist_cache["all"]) == 0:
                        _load_cache_from_file()
                    
                    # Final fallback to hardcoded list
                    if len(_watchlist_cache["all"]) == 0:
                        _watchlist_cache["all"] = HARDCODED_FALLBACK_WATCHLIST
                        _watchlist_cache["metadata"]["total_count"] = len(HARDCODED_FALLBACK_WATCHLIST)
                        print(f"[sec_utils] Using hardcoded fallback watchlist ({len(HARDCODED_FALLBACK_WATCHLIST)} items).")
                    
                    _last_cache_time = now

    # Return paginated results
    return _get_paginated_results(_watchlist_cache, limit, cursor)

def _precache_chunks(all_data: List[Dict[str, Any]]) -> None:
    """Pre-cache commonly accessed chunks for better performance."""
    _watchlist_cache["chunks"] = {}
    
    # Cache first few chunks
    for i in range(0, min(len(all_data), DEFAULT_CHUNK_SIZE * MAX_CACHED_CHUNKS), DEFAULT_CHUNK_SIZE):
        chunk = all_data[i:i + DEFAULT_CHUNK_SIZE]
        cursor_key = f"offset_{i}"
        _watchlist_cache["chunks"][cursor_key] = chunk
        
        # Store cursor metadata
        if i == 0:
            _watchlist_cache["metadata"]["cursors"] = [{"offset": i, "doc_id": chunk[0].get("doc_id")}]
        else:
            _watchlist_cache["metadata"]["cursors"].append({"offset": i, "doc_id": chunk[0].get("doc_id")})

def _get_paginated_results(cache_data: Dict[str, Any], limit: int = None, cursor: str = None) -> Dict[str, Any]:
    """Get paginated results from cached data."""
    all_data = cache_data["all"]
    
    if limit is None:
        # Return all data (legacy mode)
        return {
            "all": all_data,
            "chunks": cache_data["chunks"],
            "metadata": cache_data["metadata"],
            "watchlist": all_data,
            "pagination": {
                "hasMore": False,
                "nextCursor": None,
                "totalCount": len(all_data),
                "pageSize": len(all_data)
            }
        }
    
    # Handle cursor-based pagination
    start_index = 0
    if cursor:
        # Find cursor position
        for cursor_info in cache_data["metadata"]["cursors"]:
            if cursor_info.get("doc_id") == cursor:
                start_index = cursor_info.get("offset", 0)
                break
    
    # Get paginated data
    end_index = start_index + limit
    paginated_data = all_data[start_index:end_index]
    
    # Generate next cursor
    next_cursor = None
    has_more = end_index < len(all_data)
    if has_more and end_index < len(all_data):
        next_cursor = all_data[end_index].get("doc_id")
    
    return {
        "all": all_data,
        "chunks": cache_data["chunks"], 
        "metadata": cache_data["metadata"],
        "watchlist": paginated_data,
        "pagination": {
            "hasMore": has_more,
            "nextCursor": next_cursor,
            "totalCount": len(all_data),
            "pageSize": len(paginated_data)
        }
    }

def _load_cache_from_file() -> None:
    """Load cache data from local file with version compatibility check."""
    if os.path.exists(CACHE_FILE_PATH):
        try:
            with open(CACHE_FILE_PATH, 'r', encoding='utf-8') as f:
                file_cache = json.load(f)
            
            # Handle both old and new cache formats
            if isinstance(file_cache, list):
                # Old format: simple list
                _watchlist_cache["all"] = file_cache
                _watchlist_cache["metadata"]["total_count"] = len(file_cache)
                _watchlist_cache["version"] = "legacy"
                _precache_chunks(file_cache)
            elif isinstance(file_cache, dict):
                # New format: structured cache - check version compatibility
                cache_version = file_cache.get("version", "legacy")
                if cache_version == _cache_version or cache_version == "legacy":
                    _watchlist_cache.update(file_cache)
                    # Ensure metadata structure exists
                    if "metadata" not in _watchlist_cache:
                        _watchlist_cache["metadata"] = {
                            "total_count": len(_watchlist_cache.get("all", [])),
                            "last_updated": time.time(),
                            "cursors": []
                        }
                    _precache_chunks(_watchlist_cache["all"])
                else:
                    print(f"[sec_utils] Cache version mismatch (file: {cache_version}, current: {_cache_version}), will refresh from Firestore")
                    return
            
            print(f"[sec_utils] Loaded {len(_watchlist_cache['all'])} items from local cache file (version: {_watchlist_cache.get('version', 'unknown')}).")
            
        except Exception as file_err:
            print(f"[sec_utils] Error reading cache file: {file_err}")

def get_cache_metrics() -> Dict[str, Any]:
    """
    Returns cache performance metrics for monitoring.
    """
    with _metrics_lock:
        metrics = _cache_metrics.copy()
    
    # Calculate hit ratios
    total_requests = metrics["hits"] + metrics["misses"]
    entity_total = metrics["entity_hits"] + metrics["entity_misses"]
    
    metrics["watchlist_hit_ratio"] = metrics["hits"] / max(total_requests, 1)
    metrics["entity_hit_ratio"] = metrics["entity_hits"] / max(entity_total, 1)
    metrics["total_requests"] = total_requests
    metrics["entity_total_requests"] = entity_total
    
    return metrics

def reset_cache_metrics() -> None:
    """Reset cache performance metrics."""
    with _metrics_lock:
        _cache_metrics = {
            "hits": 0,
            "misses": 0,
            "entity_hits": 0,
            "entity_misses": 0,
            "last_reset": time.time()
        }

def check_watchlist(extracted_name: str, db=None, threshold: int = 85, is_sentence: bool = False) -> Dict[str, Any]:
    """
    Fuzzy-match a single extracted org name against sec_watchlist cache.
    Args:
        extracted_name (str): Organization name to check
        db: Firestore client (optional)
        threshold (int): Minimum match score for hit
        is_sentence (bool): If True, checks for exact substring containment of watchlist names inside the sentence instead of fuzzy matching the whole sentence.
    Returns:
        dict: {match, matched_name, confidence, sec_category, source_url, ...} or {match: False}
    """
    if not extracted_name:
        return {"match": False}
        
    extracted_name_clean = extracted_name.strip().lower()
    # Prevent matching on extremely short/generic query strings or common alert terms
    if len(extracted_name_clean) < 4:
        return {"match": False}
    if extracted_name_clean in [
        "scam", "warning", "advisory", "mag-ingat", "mag-ingat sa scam!",
        "company", "group", "investment", "legit", "online", "member",
        "members", "trading", "capital", "wealth", "future", "success"
    ]:
        return {"match": False}

    if db is None:
        db = firestore.client()
    try:
        choices = get_cached_watchlist(db)
        if not choices:
            return {"match": False}
        
        # Build mapping of lowercase name -> original meta item
        names_map = {}
        for item in choices:
            name = item.get("company_name", "")
            if name:
                name_clean = name.strip()
                name_lower = name_clean.lower()
                # Skip invalid/non-company names like advisory alerts or extremely short entries
                if len(name_lower) < 4:
                    continue
                if name_lower in ["mag-ingat sa scam!", "mag-ingat", "public advisory", "sec advisory", "dti advisory", "enforcement advisory"]:
                    continue
                if "mag-ingat sa scam" in name_lower or "mag-ingat sa mga" in name_lower:
                    continue
                names_map[name_lower] = item
                
        names_list = list(names_map.keys())
        if not names_list:
            return {"match": False}
            
        if is_sentence:
            # Prevent false-positive sentence-wide partial matching.
            # Check if any watchlist item exists as a distinct word-boundary-aligned
            # substring inside extracted_name. Require minimum 6 chars for substring
            # matches to avoid triggering on common Tagalog/English words.
            import re as _re
            best_match = None
            best_len = 0
            search_str = extracted_name.lower()
            for name_lower, item in names_map.items():
                # Ignore generic short names or alerts to prevent false triggers
                # Single common words under 6 chars can easily be normal conversation
                if len(name_lower) < 6:
                    continue
                # Word-boundary-aware substring check:
                # The watchlist name must appear as a complete phrase, not as part
                # of a larger unrelated word. e.g. "madre" in "comadre" should not match.
                pattern = r'(?:^|[\s,;:!?.\-/\'"(])' + _re.escape(name_lower) + r'(?:[\s,;:!?.\-/\'")]|$)'
                if _re.search(pattern, search_str):
                    if len(name_lower) > best_len:
                        best_match = item
                        best_len = len(name_lower)
            if best_match:
                return {
                    "match": True,
                    "matched_name": best_match.get("company_name", ""),
                    "confidence": 100,
                    "sec_category": best_match.get("sec_category", "SEC/DTI Watchlist Match"),
                    "source_url": best_match.get("source_url", "https://www.sec.gov.ph"),
                    "date_added": best_match.get("date_added", ""),
                }
            return {"match": False}

        match = process.extractOne(extracted_name_clean, names_list, score_cutoff=threshold)
        if match:
            matched_key, confidence = match[0], match[1]
            meta = names_map[matched_key]
            return {
                "match": True,
                "matched_name": meta.get("company_name", ""),
                "confidence": confidence,
                "sec_category": meta.get("sec_category", "SEC/DTI Watchlist Match"),
                "source_url": meta.get("source_url", "https://www.sec.gov.ph"),
                "date_added": meta.get("date_added", ""),
            }
        return {"match": False}
    except Exception as e:
        return {"match": False, "error": str(e)}


def check_whitelist(extracted_name: str, db=None, threshold: int = 85, is_sentence: bool = False) -> Dict[str, Any]:
    """
    Fuzzy-match a single extracted org name against sec_whitelist cache (legitimate SEC registered companies).
    Returns: dict {match, matched_name, confidence, sec_registration_no, sec_category, status, source_url, ...}
    """
    if not extracted_name:
        return {"match": False}
        
    extracted_name_clean = extracted_name.strip().lower()
    if len(extracted_name_clean) < 3:
        return {"match": False}

    if db is None:
        try:
            db = firestore.client()
        except Exception:
            db = None
            
    try:
        whitelist_res = get_sec_whitelist_paginated(db, limit=100, cursor=None) if db else {"whitelist": []}
        choices = whitelist_res.get("whitelist", [])
        
        # Fallback dataset if DB stream is empty
        if not choices:
            from sec_scraper import LEGIT_SEC_ENTITIES
            choices = [{
                "company_name": item["name"],
                "sec_registration_no": item.get("reg_no", "CS-REGISTERED"),
                "category": item.get("category", "SEC Registered Entity"),
                "status": item.get("status", "REGISTERED"),
                "source_url": "https://www.sec.gov.ph"
            } for item in LEGIT_SEC_ENTITIES]
            
        names_map = {}
        for item in choices:
            name = item.get("company_name", "")
            if name:
                name_clean = name.strip()
                name_lower = name_clean.lower()
                if len(name_lower) >= 3:
                    names_map[name_lower] = item
                    
        names_list = list(names_map.keys())
        if not names_list:
            return {"match": False}
            
        if is_sentence:
            import re as _re
            best_match = None
            best_len = 0
            search_str = extracted_name.lower()
            for name_lower, item in names_map.items():
                if len(name_lower) < 4:
                    continue
                pattern = r'(?:^|[\s,;:!?.\-/\'"(])' + _re.escape(name_lower) + r'(?:[\s,;:!?.\-/\'")]|$)'
                if _re.search(pattern, search_str):
                    if len(name_lower) > best_len:
                        best_match = item
                        best_len = len(name_lower)
            if best_match:
                return {
                    "match": True,
                    "matched_name": best_match.get("company_name", ""),
                    "confidence": 100,
                    "sec_registration_no": best_match.get("sec_registration_no", "CS-REGISTERED"),
                    "sec_category": best_match.get("category", "SEC Whitelist Match"),
                    "status": best_match.get("status", "REGISTERED"),
                    "source_url": best_match.get("source_url", "https://www.sec.gov.ph"),
                }
            return {"match": False}

        match = process.extractOne(extracted_name_clean, names_list, score_cutoff=threshold)
        if match:
            matched_key, confidence = match[0], match[1]
            meta = names_map[matched_key]
            return {
                "match": True,
                "matched_name": meta.get("company_name", ""),
                "confidence": confidence,
                "sec_registration_no": meta.get("sec_registration_no", "CS-REGISTERED"),
                "sec_category": meta.get("category", "SEC Whitelist Match"),
                "status": meta.get("status", "REGISTERED"),
                "source_url": meta.get("source_url", "https://www.sec.gov.ph"),
            }
        return {"match": False}
    except Exception as e:
        return {"match": False, "error": str(e)}



_whitelist_cache = None
_last_whitelist_cache_time = 0
_whitelist_cache_lock = threading.Lock()

def get_sec_whitelist_paginated(db, limit: int = 25, cursor: str = None) -> Dict[str, Any]:
    """
    Retrieves SEC whitelist (legitimate registered companies) with paginated caching support.
    Reads only portions of the collection to protect Firestore usage quota.
    """
    global _whitelist_cache, _last_whitelist_cache_time
    now = time.time()

    if _whitelist_cache is None or (now - _last_whitelist_cache_time) > CACHE_EXPIRY_SECONDS or len(_whitelist_cache.get("all", [])) == 0:
        with _whitelist_cache_lock:
            try:
                ref = db.collection("sec_whitelist").limit(100)
                docs = list(ref.stream())
                whitelist_data = []
                for doc in docs:
                    meta = doc.to_dict() or {}
                    company_name = meta.get("company_name", "").strip()
                    if company_name:
                        whitelist_data.append({
                            "doc_id": doc.id,
                            "company_name": company_name,
                            "sec_registration_no": meta.get("sec_registration_no") or meta.get("reg_no") or "CS-REGISTERED",
                            "category": meta.get("category") or "Legitimate SEC Registered Entity",
                            "status": meta.get("status") or "REGISTERED",
                            "source_url": meta.get("source_url") or "https://www.sec.gov.ph",
                            "date_cached": str(meta.get("date_cached") or meta.get("date_added") or "")
                        })
                _whitelist_cache = {
                    "all": whitelist_data,
                    "metadata": {"total_count": len(whitelist_data), "last_updated": now}
                }
                _last_whitelist_cache_time = now
            except Exception as e:
                print(f"[sec_utils] Error fetching whitelist from Firestore: {e}")
                if _whitelist_cache is None:
                    _whitelist_cache = {"all": [], "metadata": {"total_count": 0, "last_updated": now}}

    all_items = _whitelist_cache.get("all", []) if _whitelist_cache else []
    total_count = len(all_items)
    
    start_index = 0
    if cursor and cursor.isdigit():
        start_index = int(cursor)
        
    limit_val = limit if limit and limit > 0 else 25
    end_index = min(start_index + limit_val, total_count)
    paginated_items = all_items[start_index:end_index]
    
    has_more = end_index < total_count
    next_cursor = str(end_index) if has_more else None
    
    return {
        "whitelist": paginated_items,
        "pagination": {
            "hasMore": has_more,
            "nextCursor": next_cursor,
            "totalCount": total_count,
            "pageSize": len(paginated_items)
        }
    }


