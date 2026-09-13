/**
 * background.js — Suriin AI Scanner (Service Worker)
 * ============================================================
 * Manifest V3 uses a Service Worker instead of a persistent
 * background page. This worker wakes up on events and goes
 * dormant again when idle — you cannot rely on global state
 * persisting between events.
 *
 * Responsibilities:
 *  1. Listen for messages from popup.js to START / STOP auto-scan
 *  2. On START: set a periodic alarm using chrome.alarms API
 *  3. On each alarm tick: get the active tab → message content.js
 *     to extract viewport text → POST to the Python API
 *  4. On risky result: fire a browser notification (badge + popup)
 *  5. Persist auto-scan state in chrome.storage.local (survives
 *     worker restarts because service workers can be killed at any time)
 *  6. SUBMIT_REPORT: receive report payloads from popup.js and POST
 *     to the Flask backend asynchronously
 *  7. CHECK_NOTIFICATIONS: poll the Flask backend for unread notifications
 *  8. Notification badge alarm: periodically check for unread reports
 * ============================================================
 */

'use strict';

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const ALARM_NAME = 'suriin_auto_scan';
const ALARM_NOTIF_CHECK = 'suriin_notif_check';
const ALARM_WATCHLIST_REFRESH = 'suriin_watchlist_refresh';
const SCAN_INTERVAL_MINUTES = 1;
const NOTIF_CHECK_INTERVAL_MINUTES = 1;
const WATCHLIST_REFRESH_INTERVAL_HOURS = 6;
const API_ENDPOINT = 'http://127.0.0.1:5000/api/scan-text';
const FLASK_API_URL = 'http://127.0.0.1:5000';
const STORAGE_KEY_AUTO_SCAN = 'suriin_auto_scan_enabled';
const STORAGE_KEY_WATCHLIST_CACHE = 'suriin_watchlist_cache';
const WATCHLIST_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

function sanitizeScanText(input) {
  if (typeof input !== 'string') return '';
  let text = input;
  text = text.replace(/^[\s\n\r\t\u00A0]+|[\s\n\r\t\u00A0]+$/g, '');
  text = text.replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

// ── WATCHLIST CACHE FUNCTIONS ─────────────────────────────────────────────────────

async function getCachedWatchlist() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY_WATCHLIST_CACHE]);
    const cacheData = result[STORAGE_KEY_WATCHLIST_CACHE];
    
    if (!cacheData || !cacheData.data || !cacheData.timestamp) {
      console.log('[SuriinAI BG] No watchlist cache found');
      return null;
    }
    
    // Check if cache is still valid
    const now = Date.now();
    if (now - cacheData.timestamp > WATCHLIST_CACHE_TTL) {
      console.log('[SuriinAI BG] Watchlist cache expired');
      await chrome.storage.local.remove([STORAGE_KEY_WATCHLIST_CACHE]);
      return null;
    }
    
    console.log('[SuriinAI BG] Using cached watchlist with', cacheData.data.length, 'items');
    return cacheData.data;
  } catch (error) {
    console.warn('[SuriinAI BG] Error reading watchlist cache:', error);
    return null;
  }
}

async function setCachedWatchlist(watchlistData) {
  try {
    const cacheData = {
      data: watchlistData,
      timestamp: Date.now(),
      version: '1.0'
    };
    
    await chrome.storage.local.set({ [STORAGE_KEY_WATCHLIST_CACHE]: cacheData });
    console.log('[SuriinAI BG] Cached watchlist with', watchlistData.length, 'items');
  } catch (error) {
    console.warn('[SuriinAI BG] Error caching watchlist:', error);
  }
}

async function fetchAndCacheWatchlist() {
  try {
    console.log('[SuriinAI BG] Fetching fresh watchlist from backend');
    
    // Get auth token
    const authResult = await chrome.storage.local.get(['suriin_auth_token']);
    const token = authResult.suriin_auth_token;
    
    if (!token) {
      console.warn('[SuriinAI BG] No auth token available for watchlist fetch');
      return null;
    }
    
    const response = await fetch(`${FLASK_API_URL}/api/admin/sec-watchlist?limit=1000`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.warn('[SuriinAI BG] Failed to fetch watchlist:', response.status);
      return null;
    }
    
    const data = await response.json();
    const fetchedWatchlist = data.watchlist || [];
    
    // Cache the watchlist
    await setCachedWatchlist(fetchedWatchlist);
    
    return fetchedWatchlist;
  } catch (error) {
    console.error('[SuriinAI BG] Error fetching watchlist:', error);
    return null;
  }
}

async function getWatchlist() {
  // Try cache first
  let watchlist = await getCachedWatchlist();
  
  if (!watchlist) {
    // Fetch from backend if cache miss
    watchlist = await fetchAndCacheWatchlist();
  }
  
  return watchlist;
}

// Simple local fuzzy matching to reduce API calls
function localWatchlistCheck(text, watchlist) {
  if (!watchlist || !text || text.length < 3) return null;
  
  const lowerText = text.toLowerCase();
  const companies = [];
  
  // Extract potential company names (simple heuristic)
  const words = lowerText.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    // Check single words and combinations
    for (let j = 1; j <= Math.min(4, words.length - i); j++) {
      const phrase = words.slice(i, i + j).join(' ');
      if (phrase.length < 3) continue;
      
      // Check against watchlist
      for (const item of watchlist) {
        const companyName = (item.company_name || '').toLowerCase();
        if (companyName.includes(phrase) || phrase.includes(companyName)) {
          companies.push({
            company_name: item.company_name,
            sec_category: item.sec_category,
            confidence: Math.max(0.7, 1 - Math.abs(companyName.length - phrase.length) / Math.max(companyName.length, phrase.length)),
            source: 'local_cache'
          });
        }
      }
    }
  }
  
  if (companies.length > 0) {
    // Return highest confidence match
    companies.sort((a, b) => b.confidence - a.confidence);
    return companies[0];
  }
  
  return null;
}

// ── INSTALLATION HOOK ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('[SuriinAI BG] Extension installed for the first time.');
    await chrome.storage.local.set({ [STORAGE_KEY_AUTO_SCAN]: false });
    await chrome.storage.local.set({ 'isAuthenticated': false });
    chrome.tabs.create({ url: 'http://127.0.0.1:5000/' });
  }

  if (details.reason === 'update') {
    console.log('[SuriinAI BG] Extension updated to version', chrome.runtime.getManifest().version);
  }

  // Start notification polling alarm on install/update
  startNotificationPolling();
  
  // Start watchlist refresh alarm
  chrome.alarms.create(ALARM_WATCHLIST_REFRESH, {
    delayInMinutes: 5, // Start 5 minutes after install
    periodInMinutes: WATCHLIST_REFRESH_INTERVAL_HOURS * 60
  });
});

// ── MESSAGE LISTENER ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {

      case 'START_AUTO_SCAN':
        await startAutoScan();
        sendResponse({ success: true, autoScanActive: true });
        break;

      case 'STOP_AUTO_SCAN':
        await stopAutoScan();
        sendResponse({ success: true, autoScanActive: false });
        break;

      case 'GET_STATUS': {
        const stored = await chrome.storage.local.get(STORAGE_KEY_AUTO_SCAN);
        sendResponse({ autoScanActive: !!stored[STORAGE_KEY_AUTO_SCAN] });
        break;
      }

      // ── SUBMIT_REPORT: Receive report from popup, POST to Flask ──────────
      // Respond immediately so the popup message port doesn't time out on
      // pages with strict CSPs (e.g. YouTube) while the fetch is in-flight.
      // The actual submission runs async in the background; the result is
      // stored in chrome.storage.local for the popup to read on next open.
      case 'SUBMIT_REPORT':
        sendResponse({ success: true, pending: true });
        chrome.storage.local.remove('suriin_last_submit_result');
        submitReportToBackend(message.data)
          .then((result) => {
            chrome.storage.local.set({ suriin_last_submit_result: { ...result, pending: false } });
          })
          .catch((err) => {
            console.error('[SuriinAI BG] Report submission failed:', err);
            chrome.storage.local.set({
              suriin_last_submit_result: { success: false, pending: false, error: err.message }
            });
          });
        break;

      // ── SUBMIT_BULK_REPORT: Multiple flagged messages → POST to /api/push-reports ──
      case 'SUBMIT_BULK_REPORT':
        sendResponse({ success: true, pending: true });
        chrome.storage.local.remove('suriin_last_submit_result');
        submitBulkReportToBackend(message.data)
          .then((result) => {
            chrome.storage.local.set({ suriin_last_submit_result: { ...result, pending: false } });
          })
          .catch((err) => {
            console.error('[SuriinAI BG] Bulk report submission failed:', err);
            chrome.storage.local.set({
              suriin_last_submit_result: { success: false, pending: false, error: err.message }
            });
          });
        break;

      // ── CHECK_NOTIFICATIONS: Query Flask for unread notifications ────────
      case 'CHECK_NOTIFICATIONS':
        try {
          const result = await checkNotifications();
          sendResponse(result);
        } catch (err) {
          console.error('[SuriinAI BG] Notification check failed:', err);
          sendResponse({ success: false, error: err.message, unreadCount: 0, notifications: [] });
        }
        break;

      // ── MARK_NOTIFICATION_READ: Set isRead=true on a single notification ──
      case 'MARK_NOTIFICATION_READ':
        try {
          await markNotificationRead(message.notificationId);
          // Immediately refresh badge count
          await pollNotificationBadge();
          sendResponse({ success: true });
        } catch (err) {
          console.error('[SuriinAI BG] Mark notification read failed:', err);
          sendResponse({ success: false, error: err.message });
        }
        break;

      // ── MARK_ALL_NOTIFICATIONS_READ: Set isRead=true on multiple notifications ─
      case 'MARK_ALL_NOTIFICATIONS_READ':
        try {
          const ids = Array.isArray(message.notificationIds) ? message.notificationIds : [];
          await Promise.all(ids.map(id => markNotificationRead(id)));
          // Immediately refresh badge count
          await pollNotificationBadge();
          sendResponse({ success: true });
        } catch (err) {
          console.error('[SuriinAI BG] Mark all notifications read failed:', err);
          sendResponse({ success: false, error: err.message });
        }
        break;

      // ── STORE_AUTH_CREDENTIALS: Save user token/UID/role from content script ──
      case 'STORE_AUTH_CREDENTIALS':
        try {
          const dataToStore = {
            'suriin_user_uid': message.uid || '',
            'suriin_user_email': message.email || '',
            'suriin_id_token': message.idToken || ''
          };
          // Also store role if provided
          if (message.role) {
            dataToStore['suriin_user_role'] = message.role;
          }
          await chrome.storage.local.set(dataToStore);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;

      // ── MOCK_SCAN: Call real API for auto-scan content script ─────
      case 'MOCK_SCAN':
        (async () => {
          try {
            const scanResult = await callScanAPI(message.text || '');
            sendResponse({ success: true, ...scanResult });
          } catch (err) {
            console.error('[SuriinAI BG] Real API failed:', err.message);
            sendResponse({ success: false, error: err.message });
          }
        })();
        break;

      // ── AUTO_MODE_ACTION: Handle action buttons from auto-mode popup ───────
      case 'AUTO_MODE_ACTION':
        try {
          const { action, scanResult } = message;

          // Store the action and scan result for the popup to retrieve
          await chrome.storage.local.set({
            'suriin_auto_mode_action': action,
            'suriin_auto_mode_scan_result': scanResult,
            'suriin_auto_mode_timestamp': Date.now()
          });

          // Open the popup (it will detect the action and show appropriate form)
          chrome.action.openPopup();

          sendResponse({ success: true, action });
        } catch (err) {
          console.error('[SuriinAI BG] Auto-mode action failed:', err);
          sendResponse({ success: false, error: err.message });
        }
        break;

      // ── GET_USER_ROLE: Fetch user role from Firestore ────────────────────
      case 'GET_USER_ROLE':
        try {
          const role = await getUserRoleFromFirestore();
          sendResponse({ success: true, role });
        } catch (err) {
          console.error('[SuriinAI BG] Failed to get user role:', err);
          sendResponse({ success: false, error: err.message, role: 'user' });
        }
        break;

      // ── EXPERT_CONFIRM_SCAM: Expert confirms scam with instant validation ──
      case 'EXPERT_CONFIRM_SCAM':
        sendResponse({ success: true, pending: true });
        chrome.storage.local.remove('suriin_last_submit_result');
        submitExpertConfirmedReport(message.data)
          .then((result) => {
            chrome.storage.local.set({ suriin_last_submit_result: { ...result, pending: false } });
          })
          .catch((err) => {
            console.error('[SuriinAI BG] Expert confirmation failed:', err);
            chrome.storage.local.set({
              suriin_last_submit_result: { success: false, pending: false, error: err.message }
            });
          });
        break;

      // ── EXPERT_VERIFY_SAFE: Expert marks content as Verified Safe ──────────
      case 'EXPERT_VERIFY_SAFE':
        try {
          const result = await submitExpertVerifiedSafeReport(message.data);
          sendResponse(result);
        } catch (err) {
          console.error('[SuriinAI BG] Expert verify safe failed:', err);
          sendResponse({ success: false, error: err.message });
        }
        break;

      // ── EXPERT_INVESTIGATE: Expert starts investigation ────────────────────
      case 'EXPERT_INVESTIGATE':
        sendResponse({ success: true, pending: true });
        chrome.storage.local.remove('suriin_last_submit_result');
        submitExpertInvestigation(message.data)
          .then((result) => {
            chrome.storage.local.set({ suriin_last_submit_result: { ...result, pending: false } });
          })
          .catch((err) => {
            console.error('[SuriinAI BG] Expert investigation start failed:', err);
            chrome.storage.local.set({
              suriin_last_submit_result: { success: false, pending: false, error: err.message }
            });
          });
        break;

      default:
        sendResponse({ success: false, error: `Unknown action: ${message.action}` });
      }
    } catch (err) {
      console.error('[SuriinAI BG] Message handler failed:', err);
      sendResponse({ success: false, error: err?.message || String(err) });
    }
  })();

  return true;
});

// ── ALARM LISTENER ────────────────────────────────────────────────────────────

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
      console.log('[SuriinAI BG] Auto-scan alarm fired at', new Date().toLocaleTimeString());
      const stored = await chrome.storage.local.get(STORAGE_KEY_AUTO_SCAN);
      if (!stored[STORAGE_KEY_AUTO_SCAN]) {
        await clearAlarm();
        return;
      }
      await runAutoScanOnActiveTab();
    }

    // ── Notification polling alarm ──
    if (alarm.name === ALARM_NOTIF_CHECK) {
      console.log('[SuriinAI BG] Notification check alarm fired.');
      await pollNotificationBadge();
    }

    // ── Watchlist refresh alarm ──
    if (alarm.name === ALARM_WATCHLIST_REFRESH) {
      console.log('[SuriinAI BG] Watchlist refresh alarm fired.');
      await fetchAndCacheWatchlist();
    }
  });
}

// ── AUTO-SCAN CONTROL ─────────────────────────────────────────────────────────

async function startAutoScan() {
  console.log('[SuriinAI BG] Starting auto-scan...');
  await chrome.storage.local.set({ [STORAGE_KEY_AUTO_SCAN]: true });
  await clearAlarm();
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes:  0.1,
    periodInMinutes: SCAN_INTERVAL_MINUTES
  });
  setBadge('ON', '#6C63FF');
}

async function stopAutoScan() {
  console.log('[SuriinAI BG] Stopping auto-scan.');
  await chrome.storage.local.set({ [STORAGE_KEY_AUTO_SCAN]: false });
  await clearAlarm();
  setBadge('', '#6C63FF');
}

async function clearAlarm() {
  return chrome.alarms.clear(ALARM_NAME);
}

// ── NOTIFICATION POLLING ──────────────────────────────────────────────────────

/** Starts the periodic notification check alarm */
function startNotificationPolling() {
  chrome.alarms.create(ALARM_NOTIF_CHECK, {
    delayInMinutes:  1,
    periodInMinutes: NOTIF_CHECK_INTERVAL_MINUTES
  });
  console.log('[SuriinAI BG] Notification polling alarm started.');
}

/** Called by alarm — checks for unread notifications and updates badge */
async function pollNotificationBadge() {
  try {
    const result = await checkNotifications();
    if (result.success && result.unreadCount > 0) {
      // Only set badge if auto-scan isn't showing its own badge
      const stored = await chrome.storage.local.get(STORAGE_KEY_AUTO_SCAN);
      if (!stored[STORAGE_KEY_AUTO_SCAN]) {
        setBadge(String(result.unreadCount), '#EF4444');
      }
    }
  } catch (err) {
    // Silently fail — backend might be down
    console.log('[SuriinAI BG] Notification poll skipped:', err.message);
  }
}

// ── REPORT SUBMISSION ─────────────────────────────────────────────────────────

/**
 * Submits multiple per-message scam reports to the Flask /api/push-reports endpoint.
 * Each item in data.items becomes its own Firestore report document; they share
 * the same source identifier, url, and user context.
 * @param {Object} data - Bulk report data from popup.js handleReportSubmit
 * @returns {Promise<{success: boolean, reportIds?: string[], error?: string}>}
 */
async function submitBulkReportToBackend(data) {
  const stored = await chrome.storage.local.get([
    'suriin_user_uid', 'suriin_user_email', 'suriin_id_token'
  ]);

  if (!stored.suriin_user_uid) {
    throw new Error(
      'Not authenticated — user_id missing. ' +
      'Please open the Suriin AI web app and sign in first.'
    );
  }

  let items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    throw new Error('No report items provided.');
  }

  // Client-side dedup: drop duplicate evidence texts before sending
  const _bgSeenTexts = new Set();
  items = items.filter((item) => {
    const k = String(item.text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!k || _bgSeenTexts.has(k)) return false;
    _bgSeenTexts.add(k);
    return true;
  });
  if (!items.length) {
    throw new Error('All report items were duplicates — nothing to submit.');
  }

  const _ts = String(data.threatSeverity || data.priority || 'Normal');
  const payload = {
    shared: {
      url:               data.url || '',
      ai_verdict:        String(data.aiVerdict || data.reportType || 'WARNING').toUpperCase(),
      threat_severity:   _ts === 'High' || _ts === 'HIGH' ? 'HIGH' : 'MEDIUM',
      user_context:      data.userContext || '',
      source_identifier: (data.sourceIdentifier && String(data.sourceIdentifier).trim()) || 'Unknown suspect',
      user_id:           stored.suriin_user_uid,
      user_email:        stored.suriin_user_email || ''
    },
    items: items.map((item) => ({
      text:             String(item.text || '').substring(0, 5000),
      risk_score:       Number(item.riskScore) || 0,
      ai_status:        String(item.aiStatus || ''),
      ai_confidence:    Number(item.aiConfidence) || 0,
      matched_company:  item.matchedCompany || null,
      trigger_tokens:   Array.isArray(item.triggerTokens) ? item.triggerTokens : []
    }))
  };

  console.log('[SuriinAI BG] Sending bulk payload:', JSON.stringify({
    ...payload,
    items: payload.items.map((i) => ({
      ...i,
      text: (i.text || '').substring(0, 60) + (i.text?.length > 60 ? '…' : '')
    }))
  }));

  const headers = { 'Content-Type': 'application/json' };
  if (stored.suriin_id_token) {
    headers['Authorization'] = `Bearer ${stored.suriin_id_token}`;
  }

  let response;
  try {
    response = await fetch(`${FLASK_API_URL}/api/push-reports`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
  } catch (fetchErr) {
    const msg = fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError'
      ? 'Connection timed out. Make sure the Suriin AI web app is open and running.'
      : `Network error: ${fetchErr.message}`;
    throw new Error(msg);
  }

  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }

  console.log('[SuriinAI BG] Bulk report submitted:', result.report_ids);
  return { success: true, reportIds: result.report_ids };
}

/**
 * Submits a scam report to the Flask backend.
 * @param {Object} data - Report data from popup.js
 * @returns {Promise<{success: boolean, reportId?: string, error?: string}>}
 */
async function submitReportToBackend(data) {
  // Get stored auth credentials
  const stored = await chrome.storage.local.get([
    'suriin_user_uid', 'suriin_user_email', 'suriin_id_token'
  ]);

  // Guard: require a real user_id — never silently submit as anonymous
  if (!stored.suriin_user_uid) {
    throw new Error(
      'Not authenticated — user_id missing. ' +
      'Please open the Suriin AI web app and sign in first.'
    );
  }

  const payload = {
    evidence:          (data.evidence || data.text || '').substring(0, 5000),
    url:               data.url || '',
    risk_score:        data.riskScore || 0,
    ai_verdict:        String(data.aiVerdict || data.reportType || 'WARNING').toUpperCase(),
    threat_severity:   String(data.threatSeverity || data.priority || 'Normal') === 'High' ? 'HIGH' : 'MEDIUM',
    ai_confidence:     Number(data.aiConfidence) || 0,
    matched_company:   data.matchedCompany || null,
    trigger_tokens:    Array.isArray(data.triggerTokens) ? data.triggerTokens : [],
    user_context:      data.userContext || '',
    source_identifier: (data.sourceIdentifier && String(data.sourceIdentifier).trim()) || 'Unknown suspect',
    user_id:           stored.suriin_user_uid,
    user_email:        stored.suriin_user_email || ''
  };

  // Debug: log the outgoing payload (truncate text to keep logs readable)
  console.log('[SuriinAI BG] Sending payload:', JSON.stringify({
    ...payload,
    text: (payload.text || '').substring(0, 60) + (payload.text?.length > 60 ? '…' : '')
  }));

  const headers = { 'Content-Type': 'application/json' };

  // Add auth token if available
  if (stored.suriin_id_token) {
    headers['Authorization'] = `Bearer ${stored.suriin_id_token}`;
  }

  let response;
  try {
    response = await fetch(`${FLASK_API_URL}/api/push-report`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
  } catch (fetchErr) {
    const msg = fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError'
      ? 'Connection timed out. Make sure the Suriin AI web app is open and running.'
      : `Network error: ${fetchErr.message}`;
    throw new Error(msg);
  }

  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }

  console.log('[SuriinAI BG] Report submitted successfully:', result.report_id);
  return { success: true, reportId: result.report_id };
}

// ── NOTIFICATION CHECK ────────────────────────────────────────────────────────

/**
 * Queries the Flask backend for unread notifications for the current user.
 * @returns {Promise<{success: boolean, unreadCount: number, notifications: Array}>}
 */
async function checkNotifications() {
  const stored = await chrome.storage.local.get([
    'suriin_user_uid', 'suriin_id_token', 'suriin_user_role'
  ]);

  if (!stored.suriin_user_uid) {
    return { success: true, unreadCount: 0, notifications: [] };
  }

  const headers = {};
  if (stored.suriin_id_token) {
    headers['Authorization'] = `Bearer ${stored.suriin_id_token}`;
  }

  let url;
  const role = (stored.suriin_user_role || '').toLowerCase();
  
  if (role === 'expert' || role === 'admin') {
    // Query staff notifications for experts/admins
    url = `${FLASK_API_URL}/api/staff-notifications?role=${role}`;
  } else {
    // Query user notifications for regular users
    url = `${FLASK_API_URL}/api/user-notifications?uid=${stored.suriin_user_uid}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    success: true,
    unreadCount: data.unread_count || 0,
    notifications: data.notifications || []
  };
}

// ── MARK NOTIFICATION READ ────────────────────────────────────────────────────

const FIRESTORE_PROJECT_ID = 'suriinai';

/**
 * Marks a single Firestore Notification document as read via REST API.
 * Uses the stored id_token for authentication.
 * @param {string} notificationId - Firestore document ID
 */
async function markNotificationRead(notificationId) {
  if (!notificationId) return;

  const stored = await chrome.storage.local.get(['suriin_id_token', 'suriin_user_role']);
  const token = stored.suriin_id_token || '';
  const role = (stored.suriin_user_role || '').toLowerCase();

  // Determine collection based on role
  let collection;
  if (role === 'expert' || role === 'admin') {
    collection = 'staff_notifications';
  } else {
    collection = 'user_notifications';
  }

  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${collection}/${notificationId}?updateMask.fieldPaths=isRead`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      fields: {
        isRead: { booleanValue: true }
      }
    }),
    signal: AbortSignal.timeout(5000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore PATCH ${res.status}: ${text}`);
  }
}

// ── SCAN RUNNER ───────────────────────────────────────────────────────────────

async function runAutoScanOnActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) return;
    if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about:')) return;

    // Delegate scanning to the content script — it will extract text chunks,
    // send MOCK_SCAN messages back, and handle inline DOM highlighting itself.
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'SCAN_PAGE_AUTO' });
    } catch (msgError) {
      console.log('[SuriinAI BG] Content script not ready on tab:', tab.id);
    }

  } catch (err) {
    console.error('[SuriinAI BG] Auto-scan error:', err);
  }
}

// ── API CALL ─────────────────────────────────────────────────────────────────

async function callScanAPI(text) {
  try {
    const sanitizedText = sanitizeScanText(text);
    
    // Try local watchlist check first to reduce API calls
    const cachedWatchlist = await getWatchlist();
    if (cachedWatchlist && cachedWatchlist.length > 0) {
      const localMatch = localWatchlistCheck(sanitizedText, cachedWatchlist);
      if (localMatch && localMatch.confidence > 0.8) {
        console.log('[SuriinAI BG] Local watchlist match found, skipping API call');
        return {
          overall_status: 'RISKY',
          risk_status: 'RISKY',
          status: 'RISKY',
          matches: [localMatch],
          source: 'local_cache',
          timestamp: new Date().toISOString()
        };
      }
    }
    
    // Proceed with API call if no high-confidence local match
    const headers = { 'Content-Type': 'application/json' };
    const payload = { text: sanitizedText };

    // Conditionally attach auth credentials if available
    try {
      const stored = await chrome.storage.local.get(['suriin_id_token', 'suriin_user_uid']);
      if (stored.suriin_id_token) {
        headers['Authorization'] = `Bearer ${stored.suriin_id_token}`;
      }
      if (stored.suriin_user_uid) {
        payload.user_id = stored.suriin_user_uid;
      }
    } catch { /* proceed without token — guest mode */ }

    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();

    const overallRaw = (data.overall_status ?? data.risk_status ?? data.status ?? '').toString().trim();
    const overallUpper = overallRaw.toUpperCase();
    let status = (data.status ?? '').toString().trim().toLowerCase();
    if (!status) {
      if (overallUpper === 'CRITICAL') status = 'critical';
      else if (overallUpper === 'WARNING') status = 'warning';
      else if (overallUpper === 'SAFE') status = 'safe';
      else status = 'warning';
    }

    let scorePct = null;
    if (typeof data.overall_score === 'number') scorePct = data.overall_score;
    else if (typeof data.score === 'number') scorePct = data.score;
    else if (typeof data.overall_score === 'string' && data.overall_score.trim() !== '') scorePct = Number(data.overall_score);
    else if (typeof data.score === 'string' && data.score.trim() !== '') scorePct = Number(data.score);
    if (!Number.isFinite(scorePct)) scorePct = status === 'critical' ? 100 : (status === 'warning' ? 75 : 0);
    scorePct = Math.max(0, Math.min(100, Math.round(scorePct)));

    const responseWatchlist = data.watchlist && typeof data.watchlist === 'object' ? data.watchlist : null;
    const responseWhitelist = data.whitelist && typeof data.whitelist === 'object' ? data.whitelist : null;
    const ai_scan = data.ai_scan && typeof data.ai_scan === 'object' ? data.ai_scan : null;

    const message = data.message ?? (
      status === 'critical'
        ? 'CRITICAL: Matched an official SEC/DTI watchlist item.'
        : (status === 'warning'
          ? 'WARNING: AI flagged this message as suspicious.'
          : (responseWhitelist?.status === 'MATCHED'
            ? `VERIFIED: ${responseWhitelist.detail}`
            : 'SAFE: No watchlist match and AI found no suspicious patterns.'))
    );

    return {
      status,
      confidence: scorePct / 100,
      score: scorePct,
      scorePct,
      overall_status: overallUpper || (status === 'critical' ? 'CRITICAL' : (status === 'warning' ? 'WARNING' : 'SAFE')),
      overall_score: scorePct,
      watchlist: responseWatchlist,
      whitelist: responseWhitelist,
      ai_scan,
      sec_watchlist_hits: Array.isArray(data.sec_watchlist_hits) ? data.sec_watchlist_hits : [],
      sec_whitelist_hits: Array.isArray(data.sec_whitelist_hits) ? data.sec_whitelist_hits : [],
      matched_company: responseWatchlist?.matched_company || responseWhitelist?.matched_company || null,
      trigger_tokens:  Array.isArray(ai_scan?.trigger_tokens) ? ai_scan.trigger_tokens : [],
      ai_confidence:   typeof ai_scan?.ai_confidence === 'number' ? ai_scan.ai_confidence : 0,
      message,
      breakdown: data.breakdown || {
        message_tone: {
          is_flagged: String(ai_scan?.status || '').toUpperCase() === 'SUSPICIOUS',
          severity: String(ai_scan?.status || '').toUpperCase() === 'SUSPICIOUS' ? 'warning' : 'safe',
          display_text: ai_scan?.detail || 'No suspicious patterns detected.'
        },
        gov_records: {
          is_flagged: String(responseWatchlist?.status || '').toUpperCase() === 'MATCHED',
          severity: String(responseWatchlist?.status || '').toUpperCase() === 'MATCHED' ? 'critical' : 'safe',
          display_text: responseWatchlist?.detail || 'No watchlist match found.'
        },
        whitelist_records: {
          is_flagged: String(responseWhitelist?.status || '').toUpperCase() === 'MATCHED',
          severity: String(responseWhitelist?.status || '').toUpperCase() === 'MATCHED' ? 'legit' : 'safe',
          display_text: responseWhitelist?.detail || 'No whitelist match found.'
        }
      }
    };
  } catch (err) {
    console.error('[SuriinAI BG] API call failed:', err);
    throw new Error('Server offline or unreachable');
  }
}

// ── RESULT HANDLING ───────────────────────────────────────────────────────────

function handleAutoScanResult(result, tab) {
  switch (result.status) {
    case 'safe':
      setBadge('✓', '#22C55E');
      break;
    case 'warning':
      setBadge('!', '#FBBF24');
      showNotification('Suriin AI — Review Needed', result.message, 'warning');
      break;
    case 'critical':
      setBadge('!!', '#EF4444');
      showNotification('🚨 Suriin AI — CRITICAL RISK DETECTED', result.message, 'critical');
      break;
  }
}

// ── NOTIFICATION ──────────────────────────────────────────────────────────────

function showNotification(title, message, type) {
  if (!chrome.notifications) return;

  const notificationId = `suriin_${type}_${Date.now()}`;
  chrome.notifications.create(notificationId, {
    type:     'basic',
    iconUrl:  'icons/icon48.png',
    title,
    message,
    priority: type === 'critical' ? 2 : 1
  });
}

// ── BADGE HELPERS ─────────────────────────────────────────────────────────────

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ── EXPERT-SPECIFIC FUNCTIONS ─────────────────────────────────────────────────

/**
 * Fetches the user's role from Firestore via the Flask backend.
 * @returns {Promise<string>} User role ('user', 'expert', or 'admin')
 */
async function getUserRoleFromFirestore() {
  const stored = await chrome.storage.local.get([
    'suriin_user_uid', 'suriin_id_token'
  ]);

  if (!stored.suriin_user_uid) {
    throw new Error('No user UID available');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (stored.suriin_id_token) {
    headers['Authorization'] = `Bearer ${stored.suriin_id_token}`;
  }

  const response = await fetch(`${FLASK_API_URL}/api/user-role?uid=${stored.suriin_user_uid}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.role || 'user';
}

/**
 * Submits an expert-confirmed scam report.
 * Status: 'Reviewed', expert_verdict: 'Confirmed Threat'
 * @param {Object} data - Report data from popup.js
 * @returns {Promise<{success: boolean, reportId?: string, error?: string}>}
 */
async function submitExpertConfirmedReport(data) {
  const stored = await chrome.storage.local.get([
    'suriin_user_uid', 'suriin_user_email', 'suriin_id_token'
  ]);

  if (!stored.suriin_user_uid) {
    throw new Error('Not authenticated — user_id missing');
  }

  const now = new Date().toISOString();

  const payload = {
    text:         data.text || '',
    url:          data.url || '',
    risk_score:   data.riskScore || 0,
    heuristics:   data.riskMessage || '',
    user_context: 'Internal Expert Discovery',
    source_identifier: (data.sourceIdentifier && String(data.sourceIdentifier).trim()) || 'Unknown suspect',
    user_id:      stored.suriin_user_uid,
    user_email:   stored.suriin_user_email || '',
    // Expert-specific fields
    status:       'Reviewed',
    expert_verdict: 'Confirmed Threat',
    reviewed_by:  stored.suriin_user_uid,
    reviewed_at:  now,
    resolved_at:  now,
    reviewedBy:   stored.suriin_user_uid,
    reviewedByEmail: stored.suriin_user_email || '',
    reviewedAt:   now,
    resolvedAt:   now,
    remediation_template: data.remediationTemplate || '',
    remediation_plan:     data.remediationPlan || '',
    expert_notes:         data.expertNotes || '',
    ai_confidence:        Number(data.aiConfidence) || 0,
    trigger_tokens:       Array.isArray(data.triggerTokens) ? data.triggerTokens : [],
    matched_company:      data.matchedCompany || null
  };

  console.log('[SuriinAI BG] Sending expert confirmed payload:', JSON.stringify({
    ...payload,
    text: (payload.text || '').substring(0, 60) + (payload.text?.length > 60 ? '…' : '')
  }));

  const headers = { 'Content-Type': 'application/json' };
  if (stored.suriin_id_token) {
    headers['Authorization'] = `Bearer ${stored.suriin_id_token}`;
  }

  const response = await fetch(`${FLASK_API_URL}/api/push-report`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });

  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }

  console.log('[SuriinAI BG] Expert confirmed report submitted:', result.report_id);
  return { success: true, reportId: result.report_id };
}

/**
 * Submits an expert verified-safe report.
 * Status: 'Reviewed', expert_verdict: 'Verified Safe'
 * @param {Object} data - Report data from popup.js
 * @returns {Promise<{success: boolean, reportId?: string, error?: string}>}
 */
async function submitExpertVerifiedSafeReport(data) {
  const stored = await chrome.storage.local.get([
    'suriin_user_uid', 'suriin_user_email', 'suriin_id_token'
  ]);

  if (!stored.suriin_user_uid) {
    throw new Error('Not authenticated — user_id missing');
  }

  const now = new Date().toISOString();

  const payload = {
    text:         data.text || '',
    url:          data.url || '',
    risk_score:   data.riskScore || 0,
    heuristics:   data.riskMessage || '',
    user_context: 'Internal Expert Discovery',
    source_identifier: (data.sourceIdentifier && String(data.sourceIdentifier).trim()) || 'Unknown suspect',
    user_id:      stored.suriin_user_uid,
    user_email:   stored.suriin_user_email || '',
    status:       'Reviewed',
    expert_verdict: 'Verified Safe',
    reviewed_by:  stored.suriin_user_uid,
    reviewed_at:  now,
    resolved_at:  now,
    reviewedBy:   stored.suriin_user_uid,
    reviewedByEmail: stored.suriin_user_email || '',
    reviewedAt:   now,
    resolvedAt:   now,
    safety_justification_template: data.safetyTemplate || '',
    safety_justification:          data.safetyNotes || '',
    expert_notes:         data.expertNotes || '',
    ai_confidence:        Number(data.aiConfidence) || 0,
    trigger_tokens:       Array.isArray(data.triggerTokens) ? data.triggerTokens : [],
    matched_company:      data.matchedCompany || null
  };

  console.log('[SuriinAI BG] Sending expert verified-safe payload:', JSON.stringify({
    ...payload,
    text: (payload.text || '').substring(0, 60) + (payload.text?.length > 60 ? '\u2026' : '')
  }));

  const headers = { 'Content-Type': 'application/json' };
  if (stored.suriin_id_token) {
    headers['Authorization'] = `Bearer ${stored.suriin_id_token}`;
  }

  const response = await fetch(`${FLASK_API_URL}/api/push-report`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });

  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }

  console.log('[SuriinAI BG] Expert verified-safe report submitted:', result.report_id);
  return { success: true, reportId: result.report_id };
}

/**
 * Submits an expert investigation request.
 * Status: 'Investigating', assigned to current expert.
 * @param {Object} data - Report data from popup.js
 * @returns {Promise<{success: boolean, reportId?: string, error?: string}>}
 */
async function submitExpertInvestigation(data) {
  const stored = await chrome.storage.local.get([
    'suriin_user_uid', 'suriin_user_email', 'suriin_id_token'
  ]);

  if (!stored.suriin_user_uid) {
    throw new Error('Not authenticated — user_id missing');
  }

  const now = new Date().toISOString();

  const payload = {
    text:         data.text || '',
    url:          data.url || '',
    risk_score:   data.riskScore || 0,
    heuristics:   data.riskMessage || '',
    user_context: 'Internal Expert Discovery',
    source_identifier: (data.sourceIdentifier && String(data.sourceIdentifier).trim()) || 'Unknown suspect',
    user_id:      stored.suriin_user_uid,
    user_email:   stored.suriin_user_email || '',
    // Expert investigation fields
    status:         'Under Investigation',
    assigned_to:    stored.suriin_user_uid,
    assigned_email: stored.suriin_user_email || '',
    claimed_at:     now,
    expert_notes:   (data.investigationNotes || data.expert_notes || data.expertNotes || '').trim(),
    ai_confidence:  Number(data.aiConfidence) || 0,
    trigger_tokens: Array.isArray(data.triggerTokens) ? data.triggerTokens : [],
    matched_company: data.matchedCompany || null
  };

  console.log('[SuriinAI BG] Sending expert investigation payload:', JSON.stringify({
    ...payload,
    text: (payload.text || '').substring(0, 60) + (payload.text?.length > 60 ? '…' : '')
  }));

  const headers = { 'Content-Type': 'application/json' };
  if (stored.suriin_id_token) {
    headers['Authorization'] = `Bearer ${stored.suriin_id_token}`;
  }

  const response = await fetch(`${FLASK_API_URL}/api/push-report`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });

  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }

  console.log('[SuriinAI BG] Expert investigation submitted:', result.report_id);
  return { success: true, reportId: result.report_id };
}
