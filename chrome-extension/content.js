/**
 * content.js — Suriin AI Scanner
 * ============================================================
 * This script runs in the context of every web page (injected
 * by the manifest's content_scripts declaration at document_idle).
 *
 * Responsibilities:
 *  1. Listen for messages from popup.js or background.js
 *  2. Extract text from the page based on the requested mode:
 *       - 'highlight' → window.getSelection().toString()
 *       - 'manual'    → document.body.innerText
 *       - 'auto'      → visible viewport text (for background scanning)
 *  3. Return the extracted text back to the caller via sendResponse
 *  4. Optionally highlight flagged text in the DOM (future feature stub)
 *
 * NOTE: chrome.scripting.executeScript() in popup.js can also inject
 * a one-shot function directly, bypassing this file for simple extractions.
 * This file handles the persistent message-listener pathway, which is
 * used by background.js for automatic monitoring.
 * ============================================================
 */

'use strict';

// Module-level variable to store role captured from auth events
// This allows sharing role info between monitorWebAppAuth and GET_WEBAPP_AUTH_STATE handler
let __suriinCapturedRole = null;

// ── MODULE-LEVEL EVENT LISTENERS ───────────────────────────────────────────
// Set up listeners immediately to catch events that fire during page load
// These run before initContentScript() to ensure we don't miss early events
(function setupEarlyEventListeners() {
  // Listen for suriin:auth-ready event — capture role immediately
  window.addEventListener('suriin:auth-ready', (e) => {
    const { role } = e.detail || {};
    if (role) {
      __suriinCapturedRole = role;
      console.log(`[SuriinAI Content] ✓ [EARLY] Captured role from auth-ready: ${role}`);
      // Immediately update storage so it's available for popup.js
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ suriin_user_role: role });
      }
    }
  });

  // Listen for suriin:role-changed event
  window.addEventListener('suriin:role-changed', (e) => {
    const { role } = e.detail || {};
    if (role) {
      __suriinCapturedRole = role;
      console.log(`[SuriinAI Content] ✓ [EARLY] Captured role from role-changed: ${role}`);
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ suriin_user_role: role });
      }
    }
  });

  // Listen for suriin:credentials-ready event
  window.addEventListener('suriin:credentials-ready', (e) => {
    const { uid, email, idToken, role } = e.detail || {};
    if (role) {
      __suriinCapturedRole = role;
      console.log(`[SuriinAI Content] ✓ [EARLY] Captured role from credentials-ready: ${role}`);
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ suriin_user_role: role });
      }
    }
    if (uid && idToken && typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage(
        { action: 'STORE_AUTH_CREDENTIALS', uid, email: email || '', idToken, role },
        () => {}
      );
    }
  });
})();

// ── GUARD: Prevent duplicate listener registrations ────────────────────────
// If the content script is injected multiple times (e.g. hot reload during
// development), avoid stacking multiple message listeners.
if (!window.__suriinAILoaded) {
  window.__suriinAILoaded = true;
  initContentScript();
}

/**
 * Sets up the runtime message listener.
 * Messages arrive from popup.js or background.js via chrome.tabs.sendMessage().
 * Also monitors the web app's authentication status and syncs with chrome.storage.
 */
function initContentScript() {
  console.log('[SuriinAI] Content script initialized on:', window.location.href);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === 'START_AUTO_SCAN' || message?.action === 'STOP_AUTO_SCAN') {
      _clearSuriinScanUi({ clearQueue: true });
    }

    // Synchronous handling - sendResponse must be called immediately on every path
    try {
      switch (message.action) {
        case 'EXTRACT_TEXT': {
          const text = extractText(message.mode || 'highlight');
          sendResponse({
            success: true,
            text,
            charCount: text.length,
            wordCount: text.trim().split(/\s+/).filter(Boolean).length,
            sourceUrl: window.location.href,
            pageTitle: document.title
          });
          break;
        }

        case 'PING': {
          sendResponse({ success: true, ready: true });
          break;
        }

        case 'GET_WEBAPP_AUTH_STATE': {
          const isAuth = computeWebAppAuthState();
          let uid = '';
          let role = 'user';
          try {
            uid = sessionStorage.getItem('suriin_cached_uid') || '';
            role = sessionStorage.getItem('suriin_cached_role') || 'user';
            if (!role || role === 'user') {
              if (uid) {
                const profileRaw = sessionStorage.getItem(`suriin_profile_${uid}`);
                if (profileRaw) {
                  const parsed = JSON.parse(profileRaw);
                  if (parsed && parsed.role) role = parsed.role;
                }
              }
            }
          } catch (e) {}
          if (__suriinCapturedRole) {
            role = __suriinCapturedRole;
          }
          sendResponse({
            success: true,
            isAuthenticated: isAuth,
            uid,
            role,
            currentPage: window.location.pathname
          });
          break;
        }

        case 'SCAN_PAGE_AUTO': {
          try {
            startAutoScanObserver();
            sendResponse({
              success: true,
              message: 'Auto-scan observer started.',
              active: _autoScanObserverActive
            });
          } catch (e) {
            sendResponse({ success: false, error: e?.message || 'Failed to start auto-scan' });
          }
          break;
        }

        case 'SCAN_CURRENT_CHAT': {
          const onlyVisible = message.opts?.onlyVisible !== false;
          const threads = getActiveChatThreads({ onlyVisible });
          resetSuriinScanState(threads);
          // Two-phase pattern: acknowledge immediately, store results via chrome.storage
          const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

          // Start scan asynchronously (fire and forget)
          _runChatScanAsync(scanId, message).catch(err => {
            console.error('[SuriinAI] SCAN_CURRENT_CHAT async error:', err);
            chrome.storage.local.set({
              [`suriin_scan_result_${scanId}`]: {
                success: false,
                error: err?.message || String(err),
                timestamp: Date.now()
              }
            });
          });

          // Return scanId immediately - popup will poll for results
          sendResponse({
            success: true,
            scanId,
            status: 'started',
            message: 'Chat scan started. Use scanId to poll for results.'
          });
          break;
        }

        case 'GET_SCAN_RESULT': {
          // Poll for scan results by scanId
          const scanId = message.scanId;
          if (!scanId) {
            sendResponse({ success: false, error: 'No scanId provided' });
            break;
          }

          chrome.storage.local.get([`suriin_scan_result_${scanId}`], (result) => {
            const data = result[`suriin_scan_result_${scanId}`];
            if (data) {
              sendResponse(data);
            } else {
              sendResponse({ success: false, status: 'pending', message: 'Scan still in progress' });
            }
          });
          return true; // Async: need to wait for storage.get
        }

        case 'APPLY_CHAT_HIGHLIGHTS': {
          try {
            applyChatHighlightMarks(message.marks);
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: e?.message || String(e) });
          }
          break;
        }

        case 'HIGHLIGHT_RISK': {
          try {
            if (message.results && Array.isArray(message.results)) {
              message.results.forEach(r => {
                if (r.status !== 'safe') {
                  highlightAndInjectUI(r.matchedText, r);
                }
              });
            }
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: e?.message || String(e) });
          }
          break;
        }

        case 'CLEAR_SCAN_UI': {
          try {
            _clearSuriinScanUi({ clearQueue: true });
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: e?.message || String(e) });
          }
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown action: ${message.action}` });
      }
    } catch (e) {
      console.error('[SuriinAI] Message handler error:', e);
      sendResponse({ success: false, error: e?.message || String(e) });
    }

    // Return undefined for synchronous handling (only GET_SCAN_RESULT returns true)
  });

  // ── Monitor Web App Authentication ──────────────────────────────────────────
  // If this content script is running on the web app (127.0.0.1:5000 or localhost),
  // monitor the auth state and sync to chrome.storage
  const isWebApp = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') &&
    (window.location.port === '5000' || window.location.port === '5500' || window.location.port === '');
  console.log('[SuriinAI Content] Page detected:', {
    hostname: window.location.hostname,
    port: window.location.port,
    isWebApp: isWebApp,
    url: window.location.href
  });
  if (isWebApp) {
    monitorWebAppAuth();
  }

  if (!_activeChatListenersAttached && (_isFacebookHost() || _isMessengerHost())) {
    _activeChatListenersAttached = true;
    const handler = (e) => {
      const t = e.target;
      if (!t || !(t instanceof Element)) return;
      _updateActiveChatThreadFromTarget(t);
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('focusin', handler, true);
  }
}

function extractCurrentChatSnapshot(opts = {}) {
  const onlyVisible = opts.onlyVisible !== false;

  // Primary selectors for chat text as requested
  const primarySelectors = [
    'div[dir="auto"]',
    '.x1gslo9b',
    'div[data-testid="message-text"]'
  ];

  const parts = [];
  const seenTexts = new Set();

  for (const sel of primarySelectors) {
    try {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        // Skip if not visible (when onlyVisible is true)
        if (onlyVisible && !_isElementVisible(node)) continue;

        const text = (node.textContent || '').trim();

        // Skip empty or too short
        if (!text || text.length < 2) continue;

        // Filter out metadata safely - skip but don't break loop
        if (_isMetadataOrAttachmentText(text)) continue;

        // Deduplicate
        if (seenTexts.has(text)) continue;
        seenTexts.add(text);

        parts.push(text);
        // NOTE: DO NOT skip nodes with data-suriin-checked; only use that for overlays, not extraction.

      }
    } catch (e) {
      console.warn('[SuriinAI] extractCurrentChatSnapshot selector error:', sel, e);
      continue; // Don't break loop on error
    }
  }

  return parts.join('\n').replace(/\s+/g, ' ').trim();
}

const _SURIIN_CHAT_THREAD_SELECTORS = [
  '[role="log"]',
  '[role="main"] [role="log"]',
  '[role="main"] [role="grid"]',
  '[data-scope="messages_table"]',
  '[aria-label*="messages" i]',
  '[aria-label*="message" i]',
  '[data-pagelet^="ChatTab"]',
];

const _SURIIN_CHAT_BUBBLE_SELECTORS = [
  // Standard ARIA roles
  '[role="message"]',
  '[role="row"]',
  '[role="listitem"]',
  // Facebook/Messenger test IDs
  '[data-testid="message-text"]',
  '[data-testid="message-container"]',
  '[data-testid="message-group"]',
  '[data-scope="messages" i]',
  '[data-scope="message" i]',
  // Facebook obfuscated classes (common patterns)
  '.x1gslo9b',  // Message bubble wrapper
  '.x78zum5.x1cy8zhl',  // Flex layout message
  '.x1n2onr6.x1vjfegm',  // Another common message container
  // NOTE: Generic selectors like [class*="message" i], .message-container,
  // .chat-message were REMOVED — they match wrapper containers that hold
  // ALL messages, causing _dedupeByContainment to collapse everything into
  // a single element ("1 messages scanned").
  // Messenger specific
  '[data-suriin-messenger-thread-root] [role="row"]',
  // Fallback: any div with message-like children
  '[data-pagelet="ChatTab"] [role="row"]',
];

const _SURIIN_CHAT_TEXT_ZONE_SELECTORS = [
  '[dir="auto"]',
  'span[dir="auto"]',
  // Facebook message text specific
  '[data-testid="message-text"]',
  '[data-ad-preview="message"]',
  '[data-ad-comet-preview="message"]',
  // Messenger specific text containers
  '.x1iyjqo2',  // Common text wrapper class
  '.x193iq5w',  // Another text container
  // Generic
  '.message-text',
  '.message-content',
  '[class*="text" i][class*="message" i]',
];

var _activeSuriinInlineClose = null;
var _suriinOutsideCloseAttached = false;
var _activeChatThreadRoot = null;
var _lastOpenedFacebookChatboxRoot = null;
var _activeChatListenersAttached = false;
var _manualScanActive = false;

function _isMessengerHost() {
  const host = window.location.hostname;
  const path = window.location.pathname;
  return host === 'messenger.com' || host === 'www.messenger.com'
    || path.startsWith('/messages') || path.startsWith('/m/messages');
}

function _isFacebookHost() {
  const host = window.location.hostname;
  return host === 'facebook.com' || host === 'www.facebook.com' || host.endsWith('.facebook.com');
}

function _isRejectedChatChrome(el) {
  if (!el || !(el instanceof Element)) return true;
  if (el.closest('nav, header, footer, [role="navigation"], [role="banner"], [data-pagelet^="Stories"], [aria-label*="stories" i]')) return true;
  if (_isMessengerHost()) {
    const searchOrLists = el.closest('[aria-label*="Search Messenger" i], [role="listbox"], [role="tablist"]');
    if (searchOrLists) return true;
    const chatsPanel = el.closest('[aria-label*="Chats" i]');
    if (chatsPanel) {
      try {
        const r = chatsPanel.getBoundingClientRect();
        if (r.width < window.innerWidth * 0.45) return true;
      } catch { }
    }
  }
  try { if (el.matches('[data-pagelet="FeedUnit"], [role="feed"], [role="article"]')) return true; } catch { }
  return false;
}

function _hasChatInput(el) {
  try {
    return !!el.querySelector('[contenteditable="true"], [role="textbox"], textarea');
  } catch { }
  return false;
}

function _isMetadataOrAttachmentText(text) {
  const t = sanitizeScanText(text || '');
  if (!t || t.length < 5) return true;
  // Pure timestamp / day labels
  if (/^(sent\s+)?(\d{1,2}:\d{2}\s?(am|pm)?|\d+\s?[smhdw]\s*ago|mon|tue|wed|thu|fri|sat|sun|today|yesterday)$/i.test(t)) return true;
  // Short action labels and status chips
  if (/^(reply|send|like|share|comment|seen|delivered|read|active now|typing)$/i.test(t)) return true;
  // Facebook meta phrases like "You replied to …" / "… replied to you"
  if (/\byou replied to\b/i.test(t) || /\breplied to you\b/i.test(t)) return true;
  if (/\byou reacted to\b/i.test(t) || /\breacted to your message\b/i.test(t)) return true;
  // Bare attachment/file-name style text
  if (/^[\w\s().-]+\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|png|jpe?g|gif|webp|mp4|mov|mp3|wav)$/i.test(t)) return true;
  // Facebook file/document sharing bubble phrases
  if (/^(sent a file|sent an image|sent a photo|sent a video|sent a document|sent a voice message|sent an audio|sent a sticker|shared a link|sent a gif)$/i.test(t)) return true;
  if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|png|jpe?g|gif|webp|mp4|mov|mp3|wav)(\s|$)/i.test(t) && t.length < 200) {
    // If the text is mostly a filename with extension and very little else, skip it
    const withoutFilename = t.replace(/[\w\s().-]+\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|png|jpe?g|gif|webp|mp4|mov|mp3|wav)/gi, '').trim();
    if (withoutFilename.length < 10) return true;
  }
  return false;
}

function _isFacebookChatboxSurface(el) {
  if (!_isFacebookHost() || !el || !(el instanceof Element)) return false;
  if (_isRejectedChatChrome(el)) return false;
  if (!_isElementVisible(el)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 180 || r.height < 220) return false;
  if (r.left < window.innerWidth * 0.25 && !el.closest('[data-pagelet^="ChatTab"]')) return false;
  if (!_hasChatInput(el)) return false;
  let messageLikeZones = 0;
  try {
    el.querySelectorAll('[dir="auto"]').forEach((z) => {
      if (messageLikeZones >= 2) return;
      if (isInsideEditableContext(z)) return;
      if (_isRejectedChatChrome(z)) return;
      const text = z.textContent || '';
      if (_isMetadataOrAttachmentText(text)) return;
      messageLikeZones++;
    });
  } catch { }
  if (messageLikeZones < 1) return false;
  const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
  return /message|chat|reply|sent|like|gif|Aa/i.test(label);
}

function _getActiveFacebookChatboxRoots(opts = {}) {
  if (!_isFacebookHost()) return [];
  const onlyVisible = opts.onlyVisible !== false;
  const roots = [];
  const seen = new Set();
  try {
    document.querySelectorAll('[data-pagelet^="ChatTab"], [data-suriin-fb-chatbox-root="1"], [aria-label*="chat" i], [aria-label*="message" i], div').forEach((el) => {
      if (seen.has(el) || !_isFacebookChatboxSurface(el)) return;
      if (onlyVisible && !_isElementVisible(el)) return;
      const tighter = Array.from(el.querySelectorAll('div')).find((child) => _isFacebookChatboxSurface(child));
      const root = tighter || el;
      if (seen.has(root)) return;
      root.setAttribute('data-suriin-fb-chatbox-root', '1');
      seen.add(root);
      roots.push(root);
    });
  } catch { }
  const filtered = roots.filter((el) => !roots.some((other) => other !== el && el.contains(other)));
  // Track the rightmost root as a fallback for when no explicit interaction has been recorded.
  // On Facebook, chatboxes stack right-to-left, so rightmost == most recently opened.
  if (filtered.length) {
    const byRight = filtered.slice().sort(
      (a, b) => (b.getBoundingClientRect().right || 0) - (a.getBoundingClientRect().right || 0)
    );
    _lastOpenedFacebookChatboxRoot = byRight[0];
  }
  return filtered;
}

function _updateActiveChatThreadFromTarget(target) {
  if (!target || !(target instanceof Element)) return;
  let candidate = null;
  if (_isFacebookHost() && !_isMessengerHost()) {
    candidate = _getContainingFacebookChatboxRoot(target);
  } else if (_isMessengerHost()) {
    candidate = target.closest('[data-suriin-messenger-thread-root="1"]') || null;
    if (!candidate) {
      const main = document.querySelector('[role="main"]');
      if (main && (main === target || main.contains(target))) {
        candidate = main;
      }
    }
  }
  if (!candidate) return;
  // Skip the expensive _isChatSurface re-scan; the marker/main check above is sufficient.
  if (!_isElementVisible(candidate)) return;
  _activeChatThreadRoot = candidate;
}

function _getContainingFacebookChatboxRoot(el) {
  if (!_isFacebookHost() || !el || !(el instanceof Element)) return null;
  // Trust the stable marker without re-running _isFacebookChatboxSurface (avoids race conditions).
  const markedRoot = el.closest('[data-suriin-fb-chatbox-root="1"]');
  if (markedRoot && markedRoot.isConnected) return markedRoot;
  // Accept [data-pagelet^="ChatTab"] as a reliable built-in signal.
  const pagelet = el.closest('[data-pagelet^="ChatTab"]');
  if (pagelet && _isElementVisible(pagelet)) return pagelet;
  const roots = _getActiveFacebookChatboxRoots({ onlyVisible: true });
  return roots.find((root) => root === el || root.contains(el)) || null;
}

function _shouldRestrictToFacebookChatbox() {
  return _isFacebookHost() && _getActiveFacebookChatboxRoots({ onlyVisible: true }).length > 0;
}

function _isInsideActiveFacebookChatbox(el) {
  if (!_isFacebookHost()) return true;
  // Fast path: skip the expensive DOM re-scan if an ancestor is already a confirmed chatbox root.
  if (el instanceof Element) {
    if (el.closest('[data-suriin-fb-chatbox-root="1"]')) return true;
    if (el.closest('[data-pagelet^="ChatTab"]')) return true;
  }
  if (!_shouldRestrictToFacebookChatbox()) return false;
  return !!_getContainingFacebookChatboxRoot(el);
}

function _getMessengerComposerRoot() {
  if (!_isMessengerHost()) return null;
  const inputs = Array.from(document.querySelectorAll('[role="textbox"], [contenteditable="true"], textarea'));
  const visibleInputs = inputs.filter((el) => _isElementVisible(el) && !el.closest('nav, [role="navigation"], [aria-label*="Chats" i]'));
  if (!visibleInputs.length) return null;
  const input = visibleInputs[visibleInputs.length - 1];
  return input.closest('[role="main"]') || document.querySelector('[role="main"]') || null;
}

function _isMessengerMainMessageSurface(el) {
  if (!_isMessengerHost() || !el || !(el instanceof Element)) return false;
  if (_isRejectedChatChrome(el)) return false;
  if (!_isElementVisible(el)) return false;
  const main = document.querySelector('[role="main"]');
  if (main && !main.contains(el) && el !== main) return false;
  // Note: composer root is intentionally NOT required to contain/be-contained-by el.
  // The message list area and the composer are typically siblings under [role="main"],
  // so a strict ancestor/descendant check would incorrectly reject the message area.
  const r = el.getBoundingClientRect();
  if (r.width < 240 || r.height < 180) return false;
  if (r.right < window.innerWidth * 0.35) return false;
  try {
    const zones = Array.from(el.querySelectorAll('[dir="auto"]')).filter((z) => {
      if (isInsideEditableContext(z)) return false;
      if (_isRejectedChatChrome(z)) return false;
      if (_isMetadataOrAttachmentText(z.textContent || '')) return false;
      const zr = z.getBoundingClientRect();
      if (zr.top < r.top - 2 || zr.bottom > r.bottom + 2) return false;
      return true;
    });
    return zones.length > 0;
  } catch { }
  return false;
}

function _isChatSurface(el) {
  if (!el || !(el instanceof Element)) return false;
  if (_isMessengerHost()) return _isMessengerMainMessageSurface(el) || !!el.closest('[data-suriin-messenger-thread-root="1"]');
  try {
    if (_isFacebookHost()) return _isInsideActiveFacebookChatbox(el);
    if (el.closest('[data-pagelet^="ChatTab"]')) return true;
    if (_isFacebookChatboxSurface(el) || !!el.closest('[data-suriin-fb-chatbox-root="1"]')) return true;
    const dialog = el.closest('[role="dialog"]');
    if (!dialog) return false;
    const hasText = !!dialog.querySelector('[dir="auto"]');
    const hasInput = !!dialog.querySelector('[contenteditable="true"], [role="textbox"], textarea');
    const label = `${dialog.getAttribute('aria-label') || ''} ${dialog.textContent || ''}`;
    return hasText && (hasInput || /message|chat|reply/i.test(label));
  } catch { }
  return false;
}

function _isChatTextZone(z) {
  if (!z || !(z instanceof Element)) return false;
  if (_isFacebookHost() || _isMessengerHost()) {
    // Bubbles are already scoped to the thread root — skip the heavy
    // _isChatSurface size-check which incorrectly rejects small message rows.
    if (isInsideEditableContext(z)) return false;
    if (_isRejectedChatChrome(z) || z.closest('a[download]')) return false;
    const text = sanitizeScanText(z.textContent || '');
    if (_isMetadataOrAttachmentText(text)) return false;
    return true;
  }
  if (!_isChatSurface(z)) return false;
  if (isInsideEditableContext(z)) return false;
  if (_isRejectedChatChrome(z) || z.closest('a[download]')) return false;
  const text = sanitizeScanText(z.textContent || '');
  if (_isMetadataOrAttachmentText(text)) return false;
  return true;
}

function _getActiveChatSurfaceRoots(opts = {}) {
  const onlyVisible = opts.onlyVisible !== false;
  const roots = [];
  const seen = new Set();
  if (_isFacebookHost() && !_isMessengerHost()) {
    const fbChatRoots = _getActiveFacebookChatboxRoots({ onlyVisible });
    if (fbChatRoots.length) return fbChatRoots;
  }
  const selectors = _isMessengerHost()
    ? ['[role="main"] [role="grid"]', '[role="main"] [role="log"]']
    : ['[data-pagelet^="ChatTab"]', '[role="dialog"]', '[aria-label*="chat" i]', '[aria-label*="message" i]'];
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        if (seen.has(el) || !_isChatSurface(el)) return;
        if (onlyVisible && !_isElementVisible(el)) return;
        if (_isMessengerHost()) el.setAttribute('data-suriin-messenger-thread-root', '1');
        seen.add(el);
        roots.push(el);
      });
    } catch { }
  }
  if (_isMessengerHost()) {
    try {
      const candidates = Array.from(document.querySelectorAll('[role="main"] [role="grid"], [role="main"] [role="log"], [role="main"] [aria-label*="message" i], [role="main"] div'));
      for (const el of candidates) {
        if (seen.has(el) || !_isMessengerMainMessageSurface(el)) continue;
        if (onlyVisible && !_isElementVisible(el)) continue;
        const tighter = Array.from(el.querySelectorAll('div, [role="grid"], [role="log"]')).find((child) => _isMessengerMainMessageSurface(child));
        const root = tighter || el;
        if (seen.has(root)) continue;
        root.setAttribute('data-suriin-messenger-thread-root', '1');
        seen.add(root);
        roots.push(root);
        break;
      }
    } catch { }
  }
  return roots.filter((el) => !roots.some((other) => other !== el && el.contains(other)));
}

function _attachInlineOutsideCloseListener() {
  if (_suriinOutsideCloseAttached) return;
  _suriinOutsideCloseAttached = true;
  document.addEventListener('pointerdown', (e) => {
    const target = e.target;
    if (!target || !(target instanceof Element)) return;
    if (target.closest('[data-suriin-overlay="bubble-modal"], [data-suriin-overlay="modal"], [data-suriin-bubble-icon="1"], [data-suriin-overlay="icon"]')) return;
    if (typeof _activeSuriinInlineClose === 'function') {
      const close = _activeSuriinInlineClose;
      _activeSuriinInlineClose = null;
      close();
    }
  }, true);
}

function _closeActiveSuriinInlineModal() {
  if (typeof _activeSuriinInlineClose === 'function') {
    const close = _activeSuriinInlineClose;
    _activeSuriinInlineClose = null;
    try { close(); } catch { }
  }
  try {
    document.querySelectorAll('[data-suriin-overlay="bubble-modal"], [data-suriin-overlay="modal"]').forEach((el) => {
      el.style.setProperty('display', 'none', 'important');
    });
  } catch { }
  try {
    for (const [, co] of _containerOverlays) {
      co.modalOpen = false;
      co.hasShownOnce = false;
      // Reset overlay visibility for next scan
      if (co.overlayEl) {
        co.overlayEl.style.removeProperty('display');
        co.overlayEl.style.removeProperty('visibility');
      }
    }
  } catch { }
}


function resetSuriinScanState(targetThreads = null) {
  const scopeEls = Array.isArray(targetThreads) ? targetThreads : [document];

  // Remove overlays, icons, highlights within scoped elements
  try {
    scopeEls.forEach(scope => {
      scope.querySelectorAll('[data-suriin-overlay="bubble-modal"], [data-suriin-overlay="modal"], [data-suriin-bubble-icon="1"], [data-suriin-overlay="icon"]').forEach(el => el.remove());
      scope.querySelectorAll('[data-suriin-risk], [data-suriin-underlined], [data-suriin-checked], [data-suriin-scan-hash], [data-suriin-bubble-id], [data-suriin-bubble-key]').forEach(el => {
        el.removeAttribute('data-suriin-risk');
        el.removeAttribute('data-suriin-underlined');
        el.removeAttribute('data-suriin-checked');
        el.removeAttribute('data-suriin-scan-hash');
        el.removeAttribute('data-suriin-bubble-id');
        el.removeAttribute('data-suriin-bubble-key');
        el.style.removeProperty('text-decoration-line');
        el.style.removeProperty('text-decoration-color');
        el.style.removeProperty('text-decoration-thickness');
        el.style.removeProperty('text-underline-offset');
      });
      // Reset chat thread scan markers so bubbles can be re-scanned
      scope.querySelectorAll('.suriin-scanned').forEach(el => el.classList.remove('suriin-scanned'));
    });
  } catch {}

  // Reset overlay state
  try {
    for (const [key, co] of _containerOverlays) {
      const shouldClear = !targetThreads || targetThreads.some(t => t.contains(co.iframe || co.modalWrapper || co.overlayEl || co.iconHost));
      if (shouldClear) {
        co.modalOpen = false;
        co.hasShownOnce = false;
        if (co.overlayEl) {
          co.overlayEl.style.removeProperty('display');
          co.overlayEl.style.removeProperty('visibility');
        }
        _containerOverlays.delete(key);
      }
    }
  } catch {}
  try { _suriinChatScanQueue && (_suriinChatScanQueue.length = 0); } catch {}
  // Clear the scan result cache so re-scans always re-query the API.
  // Without this, 2nd manual scan reuses stale cached results (potentially
  // with mismatched cache keys if the threadEl changed) and shows SAFE.
  try { _suriinChatScanCache.clear(); } catch {}
}

function _clearSuriinScanUi(opts = {}) {
  resetSuriinScanState();
}


function _isElementVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 2 || r.height <= 2) return false;
  if (r.bottom < 0 || r.right < 0) return false;
  if (r.top > window.innerHeight || r.left > window.innerWidth) return false;
  const st = window.getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
  return true;
}

function _isLikelyChatThread(el) {
  if (!el || !(el instanceof Element)) return false;
  if (_isMessengerHost() && !el.closest('[role="main"]')) return false;
  if (el.closest('nav, header, footer')) return false;
  if (el.closest('[role="navigation"]')) return false;
  if (el.closest('[aria-label*="chats" i], [aria-label*="conversations" i], [aria-label*="navigation" i]')) return false;
  try { if (el.matches('[data-pagelet="FeedUnit"], [role="feed"]')) return false; } catch { }
  try {
    const zones = el.querySelectorAll('[dir="auto"]');
    for (const z of zones) {
      if (z.closest('[role="article"]')) continue;
      if (!isInsideEditableContext(z) && (z.textContent || '').trim().length > 4) return true;
    }
  } catch { }
  return false;
}

function getActiveChatThreads(opts = {}) {
  const onlyVisible = opts.onlyVisible !== false;
  const allThreads = opts.allThreads === true;

  // ── Facebook: Return ONE or ALL chatbox roots ─────────────────────────
  if (_isFacebookHost() && !_isMessengerHost()) {
    if (!allThreads) {
      // Priority 1 — explicit click/focus tracking (most reliable)
      if (_activeChatThreadRoot && _activeChatThreadRoot.isConnected) {
        if (!onlyVisible || _isElementVisible(_activeChatThreadRoot)) {
          console.log('[SuriinAI] getActiveChatThreads(FB): active root');
          return [_activeChatThreadRoot];
        }
      }
      // Priority 2 — most recently opened chatbox tracked by _getActiveFacebookChatboxRoots
      if (_lastOpenedFacebookChatboxRoot && _lastOpenedFacebookChatboxRoot.isConnected) {
        if (!onlyVisible || _isElementVisible(_lastOpenedFacebookChatboxRoot)) {
          _activeChatThreadRoot = _lastOpenedFacebookChatboxRoot;
          console.log('[SuriinAI] getActiveChatThreads(FB): last-opened root');
          return [_activeChatThreadRoot];
        }
      }
      // Priority 3 — re-discover; pick rightmost (most recently opened)
      const fbRoots = _getActiveFacebookChatboxRoots({ onlyVisible });
      if (fbRoots.length) {
        const byRight = fbRoots.slice().sort(
          (a, b) => (b.getBoundingClientRect().right || 0) - (a.getBoundingClientRect().right || 0)
        );
        _activeChatThreadRoot = byRight[0];
        console.log('[SuriinAI] getActiveChatThreads(FB): rightmost of', fbRoots.length, 'root(s)');
        return [_activeChatThreadRoot];
      }
      return [];
    } else {
      // Return ALL visible Facebook chatbox roots for background auto-monitoring
      return _getActiveFacebookChatboxRoots({ onlyVisible });
    }
  }

  // ── Non-Facebook (Messenger, Twitter, Instagram, etc.) ────────────────────────
  if (_activeChatThreadRoot && _activeChatThreadRoot.isConnected && _isChatSurface(_activeChatThreadRoot)) {
    if (!onlyVisible || _isElementVisible(_activeChatThreadRoot)) {
      return [_activeChatThreadRoot];
    }
  }
  const roots = _getActiveChatSurfaceRoots({ onlyVisible });
  const seen = new Set();
  roots.forEach((r) => seen.add(r));

  for (const sel of _SURIIN_CHAT_THREAD_SELECTORS) {
    let els = [];
    try {
      els = Array.from(document.querySelectorAll(sel));
    } catch {
      els = [];
    }
    for (const el of els) {
      if (!el || seen.has(el)) continue;
      if (!_isLikelyChatThread(el) || !_isChatSurface(el)) continue;
      if (onlyVisible && !_isElementVisible(el)) continue;
      seen.add(el);
      roots.push(el);
    }
  }

  if (roots.length === 0) {
    console.log('[SuriinAI] getActiveChatThreads: no threads via selectors, trying bottom-up discovery');
    const surfaceRoots = _getActiveChatSurfaceRoots({ onlyVisible });
    const allBubbles = surfaceRoots.flatMap((root) => _findBubblesBottomUp(root, { onlyVisible, limit: 200 }));
    if (allBubbles.length > 0) {
      const threadMap = new Map();
      for (const b of allBubbles) {
        let ancestor = b.parentElement;
        let threadKey = null;
        while (ancestor && ancestor !== document.body) {
          try {
            const ov = window.getComputedStyle(ancestor).overflowY;
            if (ov === 'auto' || ov === 'scroll') { threadKey = ancestor; break; }
          } catch { }
          ancestor = ancestor.parentElement;
        }
        if (!threadKey) continue;
        if (!threadMap.has(threadKey)) threadMap.set(threadKey, []);
        threadMap.get(threadKey).push(b);
      }
      for (const [threadEl, bubbles] of threadMap.entries()) {
        if (bubbles.length >= 2 && !seen.has(threadEl)) {
          if (threadEl.closest('nav, header, footer, [role="navigation"]') || !_isChatSurface(threadEl)) continue;
          try {
            const r = threadEl.getBoundingClientRect();
            if (r.width < 50 || r.height < 50) continue;
          } catch { }
          seen.add(threadEl);
          roots.push(threadEl);
          console.log('[SuriinAI] getActiveChatThreads: promoted via bottom-up:', threadEl.tagName, 'bubbles:', bubbles.length);
        }
      }
    }
    // If still zero roots, clear stale state
    if (roots.length === 0) {
      _activeChatThreadRoot = null;
      _lastOpenedFacebookChatboxRoot = null;
    }
  }

  console.log('[SuriinAI] getActiveChatThreads: found', roots.length, 'thread(s)');
  return roots;
}

function _dedupeByContainment(elements) {
  // Keep INNERMOST elements — when a parent and child both match,
  // prefer the child (individual message bubble) over the parent
  // (container holding multiple messages). This prevents wrapper
  // containers from collapsing all messages into 1 scan result.
  const out = [];
  for (const el of elements) {
    if (!el || !(el instanceof Element)) continue;
    // Check if this element CONTAINS any other element in the list.
    // If so, skip it (prefer the contained children).
    let containsOther = false;
    for (const other of elements) {
      if (other === el) continue;
      if (other && el.contains && el.contains(other)) {
        containsOther = true;
        break;
      }
    }
    if (!containsOther) out.push(el);
  }
  return out;
}

function getChatBubblesInThread(threadEl, opts = {}) {
  if (!threadEl || !threadEl.querySelectorAll) return [];
  const onlyVisible = opts.onlyVisible !== false;
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 120;

  const nodes = [];
  for (const sel of _SURIIN_CHAT_BUBBLE_SELECTORS) {
    try {
      nodes.push(...Array.from(threadEl.querySelectorAll(sel)));
    } catch { }
  }

  const filtered = [];
  for (const el of nodes) {
    if (!el || !(el instanceof Element)) continue;
    if (isInsideEditableContext(el)) continue;
    if (el.closest('[role="navigation"], [role="banner"]')) continue;
    if (onlyVisible && !_isElementVisible(el)) continue;
    const text = extractChatBubbleText(el);
    if (!text || text.length < 5) continue;
    filtered.push(el);
    if (filtered.length >= limit) break;
  }

  const deduped = _dedupeByContainment(filtered);
  if (deduped.length === 0) {
    console.log('[SuriinAI] getChatBubblesInThread: role selectors found 0, trying bottom-up');
    const bu = _findBubblesBottomUp(threadEl, opts);
    console.log('[SuriinAI] getChatBubblesInThread: bottom-up found', bu.length);
    return _dedupeByContainment(bu).slice(0, limit);
  }
  return deduped;
}

function extractChatBubbleText(bubbleEl) {
  if (!bubbleEl) return '';

  try {
    if (isInsideEditableContext(bubbleEl)) return '';
    if (!_isFacebookHost() && !_isMessengerHost() && !_isChatSurface(bubbleEl)) return '';

    const pieces = [];
    const _seenNodes = new WeakSet();

    // Primary selectors: div[dir="auto"] and .x1gslo9b (as requested)
    const primarySelectors = [
      'div[dir="auto"]',
      '.x1gslo9b',
      '[data-testid="message-text"]'
    ];

    for (const sel of primarySelectors) {
      try {
        const nodes = bubbleEl.querySelectorAll(sel);
        for (const z of nodes) {
          if (_seenNodes.has(z)) continue;
          _seenNodes.add(z);

          // Validate it's a chat text zone
          if (!_isChatTextZone(z)) continue;

          const t = (z.textContent || '').trim();
          if (!t || t.length < 2) continue;

          // Clean metadata filtering - skip if metadata but continue loop
          if (_isMetadataOrAttachmentText(t)) continue;

          pieces.push(t);
        }
      } catch (e) {
        console.warn('[SuriinAI] Selector error:', sel, e);
        continue; // Don't break loop on error
      }
    }

    // Fallback: use innerText if no pieces found
    const raw = pieces.length
      ? pieces.join(' ')
      : ((bubbleEl.innerText || bubbleEl.textContent || '').trim());

    return sanitizeScanText(raw);
  } catch (e) {
    console.error('[SuriinAI] extractChatBubbleText failed:', e);
    return ''; // Return empty on catastrophic failure
  }
}

function _findBubblesBottomUp(containerEl, opts = {}) {
  if (!containerEl || !containerEl.querySelectorAll) return [];
  // Check if containerEl or any ancestor is a chat surface
  let _containerInChat = _isChatSurface(containerEl);
  if (!_containerInChat) {
    let _anc = containerEl.parentElement;
    for (let _d = 0; _d < 10 && _anc && _anc !== document.body; _d++, _anc = _anc.parentElement) {
      if (_isChatSurface(_anc)) { _containerInChat = true; break; }
    }
  }
  if (!_containerInChat) return [];

  const onlyVisible = opts.onlyVisible !== false;
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 120;
  const textZones = [];

  // Try multiple text zone selectors
  for (const sel of _SURIIN_CHAT_TEXT_ZONE_SELECTORS) {
    try {
      containerEl.querySelectorAll(sel).forEach((z) => {
        // Skip if already collected
        if (textZones.some(existing => existing === z)) return;

        const text = (z.textContent || '').trim();
        if (!text || text.length < 5) return;

        // Skip metadata safely without breaking loop
        if (_isMetadataOrAttachmentText(text)) return;

        if (!_isChatTextZone(z)) return;
        if (onlyVisible && !_isElementVisible(z)) return;

        textZones.push(z);
      });
    } catch (e) {
      console.warn('[SuriinAI] _findBubblesBottomUp selector error:', sel, e);
      // Continue to next selector - don't break loop
    }
  }

  if (!textZones.length) return [];

  const bubbles = [];
  const seen = new WeakSet();

  for (const zone of textZones) {
    let candidate = zone;
    for (let i = 0; i < 5; i++) {
      const parent = candidate.parentElement;
      if (!parent || parent === containerEl) break;
      try { if (parent.closest('[contenteditable], [role="textbox"], textarea, input')) break; } catch { break; }
      try {
        // Use expanded selectors for counting
        let dirCount = 0;
        for (const sel of _SURIIN_CHAT_TEXT_ZONE_SELECTORS) {
          try {
            dirCount += parent.querySelectorAll(sel).length;
          } catch { }
        }
        if (dirCount <= 2) { candidate = parent; } else { break; }
      } catch { break; }
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isInsideEditableContext(candidate)) continue;

    const text = extractChatBubbleText(candidate);
    if (!text || text.length < 5) continue;
    bubbles.push(candidate);
    if (bubbles.length >= limit) break;
  }

  return bubbles;
}

// ── ASYNC SCAN HELPER ─────────────────────────────────────────────────────────

/**
 * Async scan helper for two-phase messaging pattern.
 * Runs scan in background and stores results via chrome.storage.
 */
async function _runChatScanAsync(scanId, message) {
  const opts = message.opts || {};
  const result = await scanCurrentChatAndHighlight(opts);

  // Store result for popup to retrieve
  await chrome.storage.local.set({
    [`suriin_scan_result_${scanId}`]: {
      ...result,
      success: true,
      scanId,
      timestamp: Date.now()
    }
  });

  // Also notify popup/background that scan is complete
  try {
    chrome.runtime.sendMessage({
      action: 'SCAN_COMPLETE',
      scanId,
      result
    });
  } catch (e) {
    // Extension may not be listening, ignore error
  }
}

/**
 * Computes a stable boolean auth state from the current page DOM.
 * Always returns true/false (never null/undefined).
 *
 * @returns {boolean}
 */
function computeWebAppAuthState() {
  const path = window.location.pathname || '';
  const dashboardWrapper = document.getElementById('dashboard-wrapper');
  const loginWrapper = document.getElementById('login-wrapper');

  // Strongest signal: dashboard wrapper is visible.
  if (dashboardWrapper) {
    return dashboardWrapper.style.display !== 'none';
  }

  // If we're on known dashboard routes, treat as authenticated.
  if (path.includes('user-dashboard') || path.includes('admin-dashboard') || path.includes('expert-dashboard') || path.includes('expert-resolved')) {
    return true;
  }

  // On login page, visible login wrapper means unauthenticated.
  if (loginWrapper) {
    return loginWrapper.style.display === 'none';
  }

  // Conservative fallback for auth-neutral pages.
  return false;
}

// ── TEXT EXTRACTION ───────────────────────────────────────────────────────────

/**
 * Extracts text from the page based on the scanning mode.
 *
 * @param {'highlight' | 'manual' | 'auto'} mode
 * @returns {string} The extracted text (trimmed)
 */
function extractText(mode) {
  switch (mode) {

    // ── Highlight Mode ────────────────────────────────────────────────────────
    // Returns only the text the user has manually selected (click-dragged).
    case 'highlight': {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return '';
      }
      // Normalize for API: replace all \r or \n with space, then trim
      return selection.toString().replace(/[\r\n]+/g, ' ').trim();
    }

    // ── Manual Page Scan ──────────────────────────────────────────────────────
    // Returns the full innerText of the body.
    // innerText respects CSS visibility (unlike textContent), so hidden
    // elements won't pollute the scan.
    case 'manual': {
      return extractCurrentChatSnapshot({ onlyVisible: true });
    }

    // ── Auto / Viewport Scan ──────────────────────────────────────────────────
    // For automatic background monitoring, we extract only the visible viewport
    // portion to keep payloads small and analysis fast.
    // Technique: collect text from elements within the current viewport rect.
    case 'auto': {
      return extractCurrentChatSnapshot({ onlyVisible: true });
    }

    default:
      console.warn('[SuriinAI] Unknown extraction mode:', mode);
      return '';
  }
}

// ── VIEWPORT TEXT EXTRACTION ──────────────────────────────────────────────────

/**
 * Extracts visible text only from elements currently within the viewport.
 * Delegates to extractTextByConfig (with filterViewport=true) so the active
 * domain config governs which selectors / walker strategy is used.
 *
 * @returns {string}
 */
function extractViewportText() {
  return extractCurrentChatSnapshot({ onlyVisible: true });
}

// ── WEB APP AUTHENTICATION MONITORING ──────────────────────────────────────────

/**
 * Monitors the web app's authentication state and syncs it to chrome.storage.
 * This enables the extension popup to know when the user is authenticated
 * without having direct access to Firebase auth state.
 *
 * Approach:
 *  - Periodically check for a marker on the page (dashboard wrapper visible = authenticated)
 *  - When auth state changes, update chrome.storage.local.isAuthenticated
 *  - This triggers the storage listener in popup.js and updates the UI
 */
function monitorWebAppAuth() {
  let lastAuthState = null;
  let lastRole = null;
  let checkCount = 0;

  function checkAuthState() {
    checkCount++;
    const dashboardWrapper = document.getElementById('dashboard-wrapper');
    const loginWrapper = document.getElementById('login-wrapper');
    const isCurrentlyAuthenticated = computeWebAppAuthState();

    // Get current role from highest priority source
    // Priority: 1) __suriinCapturedRole (captured from auth events)
    //            2) sessionStorage (fallback)
    //            3) default 'user'
    let currentRole = __suriinCapturedRole || 'user';
    try {
      const storedRole = sessionStorage.getItem('suriin_cached_role');
      if (storedRole && !__suriinCapturedRole) {
        currentRole = storedRole;
      } else if (!__suriinCapturedRole) {
        const cachedUid = sessionStorage.getItem('suriin_cached_uid') || '';
        if (cachedUid) {
          const profileRaw = sessionStorage.getItem(`suriin_profile_${cachedUid}`);
          if (profileRaw) {
            const parsed = JSON.parse(profileRaw);
            if (parsed && parsed.role) currentRole = parsed.role;
          }
        }
      }
    } catch (e) {}

    // Log every 10 checks to avoid spam, plus on state change
    if (checkCount % 10 === 1 || lastAuthState !== isCurrentlyAuthenticated || lastRole !== currentRole) {
      console.log(`[SuriinAI Content] Auth check #${checkCount}:`, {
        dashboardWrapperExists: !!dashboardWrapper,
        dashboardWrapperDisplay: dashboardWrapper?.style.display,
        loginWrapperDisplay: loginWrapper?.style.display,
        isAuthenticated: isCurrentlyAuthenticated,
        role: currentRole,
        currentPage: window.location.pathname
      });
    }

    // If auth state changed, update chrome.storage
    if (lastAuthState !== isCurrentlyAuthenticated) {
      lastAuthState = isCurrentlyAuthenticated;

      console.log(`[SuriinAI Content] ✓ Auth state CHANGED to: ${isCurrentlyAuthenticated}`);
      chrome.storage.local.set(
        { isAuthenticated: isCurrentlyAuthenticated },
        () => {
          console.log(`[SuriinAI Content] ✓ Updated chrome.storage.local.isAuthenticated = ${isCurrentlyAuthenticated}`);
        }
      );

      // When authenticated, extract and store user credentials for background script
      if (isCurrentlyAuthenticated) {
        // Credentials are forwarded via suriin:credentials-ready (from auth.js)
      }
    }

    // If role changed, update chrome.storage
    if (isCurrentlyAuthenticated && lastRole !== currentRole) {
      lastRole = currentRole;
      console.log(`[SuriinAI Content] ✓ Role CHANGED to: ${currentRole}`);
      chrome.storage.local.set(
        { suriin_user_role: currentRole },
        () => {
          console.log(`[SuriinAI Content] ✓ Updated chrome.storage.local.suriin_user_role = ${currentRole}`);
        }
      );
    }
  }

  console.log('[SuriinAI Content] ✓ Starting auth monitoring on:', window.location.href);

  // Initial check
  checkAuthState();

  // Check every 1 second for faster detection (was 2 seconds)
  const monitorInterval = setInterval(checkAuthState, 1000);

  // Listen for suriin:auth-ready event — update auth state and capture role
  window.addEventListener('suriin:auth-ready', (e) => {
    const { role } = e.detail || {};
    if (role) {
      __suriinCapturedRole = role;
      console.log(`[SuriinAI Content] ✓ Detected suriin:auth-ready event with role: ${role}`);
      // Immediately update storage so popup.js sees the correct role
      chrome.storage.local.set({ suriin_user_role: role });
    } else {
      console.log('[SuriinAI Content] ✓ Detected suriin:auth-ready event (no role in detail)');
    }
    checkAuthState();
  });

  // Listen for suriin:role-changed event — web app dispatches this when user switches accounts
  window.addEventListener('suriin:role-changed', (e) => {
    const { role } = e.detail || {};
    if (!role) return;
    console.log(`[SuriinAI Content] ✓ Detected suriin:role-changed event: ${role}`);
    // Update captured role for immediate access
    __suriinCapturedRole = role;
    // Immediately update storage to trigger extension popup update
    chrome.storage.local.set({ suriin_user_role: role }, () => {
      console.log(`[SuriinAI Content] ✓ Updated role to ${role} from suriin:role-changed event`);
    });
  });

  // Listen for suriin:credentials-ready event — auth.js dispatches this with
  // uid/email/idToken/role already resolved, so we forward directly to background.js.
  window.addEventListener('suriin:credentials-ready', (e) => {
    const { uid, email, idToken, role } = e.detail || {};
    if (!uid) return;
    // Capture role from credentials event
    if (role) {
      __suriinCapturedRole = role;
      console.log(`[SuriinAI Content] ✓ Received suriin:credentials-ready with role: ${role}, forwarding to background. uid:`, uid);
    } else {
      console.log('[SuriinAI Content] ✓ Received suriin:credentials-ready, forwarding to background. uid:', uid);
    }
    chrome.runtime.sendMessage(
      { action: 'STORE_AUTH_CREDENTIALS', uid, email, idToken, role },
      (response) => {
        if (chrome.runtime.lastError) return; // extension context may be gone
        if (response?.success) {
          console.log('[SuriinAI Content] ✓ Credentials stored in background successfully');
        }
      }
    );
  });
}

/**
 * Extracts Firebase user credentials from the web app page and sends them
 * to the background script for storage. This enables the extension to make
 * authenticated API calls to the Flask backend.
 *
 * Uses a page-level script injection to access window.__suriinAuth which is
 * set by auth.js on the web app.
 */
function extractAndStoreAuthCredentials() {
  // Inject a script into the page context to read auth state and role
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      try {
        var auth = window.__suriinAuth;
        var role = window.__suriinUserRole || 'user';
        // Also try to get role from sessionStorage
        try {
          var storedRole = sessionStorage.getItem('suriin_cached_role');
          if (storedRole) role = storedRole;
        } catch (e) {}

        if (auth && auth.user) {
          // Get ID token and post it to the content script via a custom event
          auth.user.getIdToken().then(function(token) {
            window.dispatchEvent(new CustomEvent('suriin:auth-credentials', {
              detail: {
                uid: auth.user.uid || '',
                email: auth.user.email || '',
                idToken: token || '',
                role: role
              }
            }));
          }).catch(function() {
            // Fallback: send without token
            window.dispatchEvent(new CustomEvent('suriin:auth-credentials', {
              detail: {
                uid: auth.user.uid || '',
                email: auth.user.email || '',
                idToken: '',
                role: role
              }
            }));
          });
        }
      } catch (e) {
        console.warn('[SuriinAI] Could not extract auth credentials:', e);
      }
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();

  // Listen for the credentials event from the injected script
  window.addEventListener('suriin:auth-credentials', function handler(e) {
    window.removeEventListener('suriin:auth-credentials', handler);
    const { uid, email, idToken, role } = e.detail || {};
    if (uid) {
      // Store role in captured variable and extension storage for fast access
      if (role) {
        __suriinCapturedRole = role;
        chrome.storage.local.set({ suriin_user_role: role });
      }
      // Pass role to background script for persistent storage
      chrome.runtime.sendMessage({
        action: 'STORE_AUTH_CREDENTIALS',
        uid,
        email,
        idToken,
        role
      }, (response) => {
        if (response?.success) {
          console.log('[SuriinAI Content] ✓ Auth credentials and role stored in background script');
        }
      });
    }
  }, { once: true });
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-SCAN DOM INJECTION (Grammarly-Style Inline Highlights)
//  Supports SPAs via MutationObserver + debounce for performance.
// ══════════════════════════════════════════════════════════════════════════════

/** Cache scan results by text key → { success, status, score, breakdown }.
 *  On first encounter we call MOCK_SCAN; on repeats we skip the API call but
 *  still re-run highlightAndInjectUI so newly-rendered duplicate DOM nodes
 *  (e.g. a second "test-scam" comment) get their own overlay. */
const _scanResultCache = new Map();

// ── SLIDING CONTEXT BUFFER (Thread Isolation) ─────────────────────────────────
// Stores the last 5 scanned message strings per unique thread/post context key.
// Allows MOCK_SCAN to receive concatenated message history so cross-message
// patterns (e.g. "test" in one message, "scam" in the next) are detectable.

/** Map<contextKey: string, messages: string[]> — max 5 entries per key. */
const _contextBuffers = new Map();

/**
 * Derives a stable actor ID from a DOM element by traversing up to the nearest
 * comment/message wrapper and extracting the author's name or a structural fingerprint.
 *
 * For Facebook comments: walks up to [aria-label="Comment"] and reads the first
 * strong/a element (author name link).
 * For Messenger: uses row-reverse layout (sent by self) vs normal (received).
 * Fallback: hashes the parent chain tag sequence for a stable structural ID.
 *
 * @param {Element} el
 * @returns {string} A short stable actor identifier string
 */
function _getActorId(el) {
  if (!el) return 'Unknown';

  // ── Messenger: self vs other by flex-direction ────────────────────────────
  const rowEl = el.closest('[role="row"]');
  if (rowEl) {
    const st = window.getComputedStyle(rowEl);
    const dir = st.flexDirection || rowEl.style.flexDirection || '';
    // Messenger renders sent messages with row-reverse
    return dir.includes('reverse') ? 'Self' : 'Other';
  }

  // ── Facebook comment: extract author name from the DIRECT comment wrapper only.
  // IMPORTANT: do NOT use querySelector('[aria-label="Comment"]') on the article —
  // it would return the FIRST comment's author for ALL elements in the article,
  // causing every actor to get the same ID.
  const commentEl = el.closest('[aria-label="Comment"]');
  if (commentEl) {
    // Try multiple selectors for the author name — Facebook changes its DOM structure
    // frequently, so we cast a wide net:
    //   1. a[role=link] containing strong or span (most common)
    //   2. a > strong directly (older layout)
    //   3. data-hovercard span (legacy)
    const authorEl = commentEl.querySelector(
      'a[role="link"] strong, a[role="link"] > span, a > strong, a[href*="profile"] strong, [data-hovercard] span'
    );
    if (authorEl) {
      const name = authorEl.textContent?.trim();
      // Sanity-check: name must be a plausible person name (non-empty, < 50 chars)
      if (name && name.length > 0 && name.length < 50) {
        return 'Actor_' + name.replace(/\s+/g, '_').substring(0, 30);
      }
    }
    // More reliable fallback: use the profile link href as the actor fingerprint.
    // Walk all links in the comment and pick the first one that looks like a profile URL.
    const links = commentEl.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      // Skip: empty, hash-only, comment-specific query params, redirect wrappers
      if (!href || href.startsWith('#') ||
          href.includes('comment_id') || href.includes('/l.php') ||
          href.includes('?__cft') || href.includes('/__cancel')) continue;
      // Extract the first meaningful path segment (profile username or numeric ID)
      const seg = href.replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean)[0] || '';
      if (seg.length > 2) return 'Actor_' + _fnv1a(seg);
    }
  }

  // ── Generic: structural fingerprint (tag chain of 4 ancestors) ────────────
  let chain = '';
  let cur = el;
  for (let i = 0; i < 4 && cur && cur !== document.body; i++, cur = cur.parentElement) {
    chain += (cur.tagName || '') + (cur.getAttribute('role') || '') + '_';
  }
  return 'Struct_' + _fnv1a(chain);
}

/**
 * Derives a stable thread-isolation key from a DOM element using bottom-up traversal.
 * Now appends an actor ID so each author's messages use a separate context buffer.
 * Priority: floating chat dialog > feed article > fallback pathname.
 * @param {Element} el
 * @returns {string}
 */
function _getContextKey(el) {
  if (!el) return `Generic_${location.pathname}`;

  // Resolve actor before building thread key
  const actorId = _getActorId(el);

  // ── Priority 1: genuine chat dialogs (Messenger chatbox, chat tab, etc.) ───────
  // IMPORTANT: [role="dialog"] catches BOTH Messenger chatboxes AND Facebook post
  // modals. Post modals must NOT be treated as chats — they contain [role="article"]
  // children (each comment is an article), so every comment in the modal would get
  // the same FloatingChat key and share one buffer (cross-actor contamination).
  // Fix: only use a dialog as a chat context if it does NOT contain any articles.
  const _dialogEl = el.closest('[role="dialog"]');
  const _isPostModal = _dialogEl && !!_dialogEl.querySelector('[role="article"]');
  const chatEl = el.closest('[data-pagelet^="ChatTab"], .user-profile-chat-wrapper') ||
                 (_dialogEl && !_isPostModal ? _dialogEl : null);
  if (chatEl) {
    const name =
      chatEl.querySelector('[role="heading"]')?.textContent?.trim() ||
      chatEl.getAttribute('aria-label') ||
      chatEl.getAttribute('title') ||
      chatEl.id ||
      'unknown';
    return `FloatingChat_${name.replace(/\s+/g, '_').substring(0, 40)}_${actorId}`;
  }

  // ── Priority 2: feed post / article ────────────────────────────────────────
  const postEl = el.closest('[role="article"], .commentable_item');
  if (postEl) {
    const containers = Array.from(document.querySelectorAll('[role="article"], .commentable_item'));
    const idx = containers.indexOf(postEl);
    const id = postEl.dataset.ft || postEl.id || String(idx);
    return `FB_Post_${id.substring(0, 40)}_${actorId}`;
  }

  // ── Fallback: page path ─────────────────────────────────────────────────────
  return `Generic_${location.pathname}_${actorId}`;
}

/**
 * Pushes a new text entry into the sliding context buffer for a given key.
 * Evicts the oldest entry when the buffer exceeds 5 items.
 * @param {string} contextKey
 * @param {string} text
 * @returns {string[]} The current buffer array after the push.
 */
function _pushToContextBuffer(contextKey, text) {
  if (!_contextBuffers.has(contextKey)) {
    _contextBuffers.set(contextKey, []);
  }
  const buf = _contextBuffers.get(contextKey);
  buf.push(text);
  if (buf.length > 5) buf.shift();
  return buf;
}

/**
 * FNV-1a 32-bit hash — fast, collision-resistant string key for cache lookups.
 * Replaces substring(0,80) prefix keys that collide on similarly-prefixed comments.
 * @param {string} str
 * @returns {string} hex string like "2b3f8a1c"
 */
function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function sanitizeScanText(input) {
  if (typeof input !== 'string') return '';
  let text = input;
  text = text.replace(/^[\s\n\r\t\u00A0]+|[\s\n\r\t\u00A0]+$/g, '');
  text = text.replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

const _suriinChatScanCache = new Map();
const _suriinChatScanQueue = [];
let _suriinChatQueueRunning = false;
const _suriinChatSessions = new Map();
const _suriinBubbleUi = new Map();
const _SURIIN_CHAT_QUEUE_MAX = 160;
let _suriinChatQueueStopToken = 0;

function _makeChatThreadKey(threadEl) {
  if (!threadEl) return `thread_${_fnv1a(location.pathname)}`;
  const label = (
    threadEl.getAttribute('aria-label') ||
    threadEl.getAttribute('data-pagelet') ||
    threadEl.id ||
    ''
  );
  if (label) return `thread_${_fnv1a(label)}`;
  // For FB/Messenger pages, React re-renders can change element identity (breaking the
  // chain-based hash). Use the URL pathname as a stable thread key instead.
  if (_isFacebookHost() || _isMessengerHost()) {
    return `thread_${_fnv1a(location.pathname)}`;
  }
  let chain = '';
  let cur = threadEl;
  for (let i = 0; i < 4 && cur && cur !== document.body; i++, cur = cur.parentElement) {
    chain += (cur.tagName || '') + (cur.getAttribute('role') || '') + (cur.id || '') + '_';
  }
  return `thread_${_fnv1a(chain)}`;
}

function _makeChatCacheKey(threadEl, bubbleText) {
  const tKey = _makeChatThreadKey(threadEl);
  const textHash = _fnv1a(String(bubbleText || ''));
  return `${location.hostname}|chat|${tKey}|${textHash}`;
}

function _ensureBubbleId(bubbleEl) {
  if (!bubbleEl || !(bubbleEl instanceof Element)) return '';
  if (bubbleEl.dataset.suriinBubbleId) return bubbleEl.dataset.suriinBubbleId;
  const id = `sb_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  bubbleEl.dataset.suriinBubbleId = id;
  return id;
}

function _getThreadForBubble(bubbleEl) {
  if (!bubbleEl || !(bubbleEl instanceof Element)) return null;
  // For Facebook/Messenger: individual message rows are always small (fail _isChatSurface),
  // so bypass that check and walk up to find the chatbox root directly.
  if (_isFacebookHost() || _isMessengerHost()) {
    // 1. Check for an explicit chatbox root marker first (fastest path)
    const markedRoot = bubbleEl.closest('[data-suriin-fb-chatbox-root="1"], [data-suriin-messenger-thread-root="1"]');
    if (markedRoot) return markedRoot;
    // 2. Walk up through THREAD selectors
    for (const sel of _SURIIN_CHAT_THREAD_SELECTORS) {
      try {
        const t = bubbleEl.closest(sel);
        if (t) return t;
      } catch { }
    }
    // 3. Walk up to first scrollable ancestor that looks like a chatbox container
    //    (reject news feed, main page scroller, sidebar)
    let ancestor = bubbleEl.parentElement;
    while (ancestor && ancestor !== document.body) {
      try {
        // Reject elements that are clearly NOT chatbox containers
        if (ancestor.matches('[role="feed"], [data-pagelet="FeedUnit"], [role="navigation"], nav, header, footer')) break;
        if (ancestor.matches('[aria-label*="stories" i], [data-pagelet^="Stories"]')) break;
        const ov = window.getComputedStyle(ancestor).overflowY;
        if (ov === 'auto' || ov === 'scroll') {
          // On Facebook, reject the main page scroll container (very wide)
          const r = ancestor.getBoundingClientRect();
          if (r.width > window.innerWidth * 0.75 && !ancestor.closest('[data-pagelet^="ChatTab"]')) break;
          return ancestor;
        }
      } catch { }
      ancestor = ancestor.parentElement;
    }
    return null;
  }
  // Non-Facebook: require the bubble to be inside a chat surface
  if (!_isChatSurface(bubbleEl)) return null;
  for (const sel of _SURIIN_CHAT_THREAD_SELECTORS) {
    try {
      const t = bubbleEl.closest(sel);
      if (t) return t;
    } catch { }
  }
  let ancestor = bubbleEl.parentElement;
  while (ancestor && ancestor !== document.body) {
    try {
      const ov = window.getComputedStyle(ancestor).overflowY;
      if ((ov === 'auto' || ov === 'scroll') && _isChatSurface(ancestor)) return ancestor;
    } catch { }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function _callBackgroundScan(text, _retry = 1) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ action: 'MOCK_SCAN', text }, (resp) => {
        if (chrome.runtime.lastError) {
          // Chrome SW may be suspended between scans — retry once after a short delay.
          if (_retry > 0) {
            setTimeout(() => _callBackgroundScan(text, 0).then(resolve, reject), 700);
          } else {
            reject(new Error(chrome.runtime.lastError.message));
          }
          return;
        }
        resolve(resp);
      });
    } catch (e) {
      if (_retry > 0) {
        setTimeout(() => _callBackgroundScan(text, 0).then(resolve, reject), 700);
      } else {
        reject(e);
      }
    }
  });
}

function _ensureSession(sessionId) {
  if (!sessionId) return null;
  if (_suriinChatSessions.has(sessionId)) return _suriinChatSessions.get(sessionId);
  let _resolve;
  const promise = new Promise((res) => { _resolve = res; });
  const s = {
    sessionId,
    pending: 0,
    totalBubblesScanned: 0,
    threatCount: 0,
    warningCount: 0,
    criticalCount: 0,
    marks: [],
    results: [],
    flaggedResults: [],
    worstResult: null,
    flaggedTexts: [],
    resolve: _resolve,
    promise
  };
  _suriinChatSessions.set(sessionId, s);
  return s;
}

function _finishSessionIfDone(sessionId) {
  const s = sessionId ? _suriinChatSessions.get(sessionId) : null;
  if (!s) return;
  if (s.pending > 0) return;

  let overallStatus = 'SAFE';
  let overallScore = 0;
  if (s.criticalCount > 0) {
    overallStatus = 'CRITICAL';
    overallScore = 100;
  } else if (s.warningCount > 0) {
    overallStatus = 'WARNING';
    overallScore = 75;
  }

  const threadBreakdown = _buildThreadBreakdown(s.flaggedResults || []);

  // Aggregate all sec_watchlist_hits from flagged results
  const allSecHits = [];
  for (const r of (s.flaggedResults || [])) {
    if (r.sec_watchlist_hits && r.sec_watchlist_hits.length > 0) {
      allSecHits.push(...r.sec_watchlist_hits);
    }
  }

  s.resolve({
    overallStatus,
    overallScore,
    totalBubblesScanned: s.totalBubblesScanned,
    threatCount: s.threatCount,
    warningCount: s.warningCount,
    criticalCount: s.criticalCount,
    marks: s.marks,
    results: s.results || [],
    flaggedResults: s.flaggedResults || [],
    threadBreakdown,
    worstResult: s.worstResult || null,
    worstResultSecHits: allSecHits,
    flaggedTexts: s.flaggedTexts || []
  });
  _suriinChatSessions.delete(sessionId);
}

function _makeSessionResultEntry(result, bubbleText, bubbleId, cacheKey) {
  const status = String(result?.status || result?.overall_status || result?.risk_status || 'safe').toLowerCase();
  const score = Number(result?.overall_score ?? result?.score ?? (status === 'critical' ? 100 : (status === 'warning' ? 75 : 0)));
  return {
    bubbleId,
    bubbleKey: cacheKey,
    text: bubbleText,
    status,
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    ai_scan: result?.ai_scan || null,
    watchlist: result?.watchlist || null,
    sec_watchlist_hits: result?.sec_watchlist_hits || []
  };
}

function _recordSessionScanResult(session, result, bubbleText, bubbleId, cacheKey) {
  if (!session || !result?.success) return;
  const entry = _makeSessionResultEntry(result, bubbleText, bubbleId, cacheKey);
  session.results.push(entry);
  if (entry.status === 'safe') return;
  session.threatCount++;
  if (entry.status === 'critical') session.criticalCount++;
  else session.warningCount++;
  session.marks.push({ bubbleId, bubbleKey: cacheKey, status: entry.status });
  const sev = entry.status === 'critical' ? 2 : 1;
  const prevSev = session.worstResult ? (session.worstResult.status === 'critical' ? 2 : 1) : 0;
  const prevScore = Number(session.worstResult?.scorePct ?? session.worstResult?.overall_score ?? session.worstResult?.score ?? 0);
  if (sev > prevSev || (sev === prevSev && entry.score >= prevScore)) session.worstResult = result;
  session.flaggedTexts.push(bubbleText);
  session.flaggedResults.push(entry);
}

function _buildThreadBreakdown(flaggedResults) {
  const trimSnippet = (t) => {
    const s = sanitizeScanText(t || '');
    return s.length > 90 ? `${s.slice(0, 87).trim()}…` : s;
  };
  // Aggregate by unique text so each message appears exactly once.
  const byKey = new Map();
  for (const r of flaggedResults) {
    const snippet = trimSnippet(r.text);
    if (!snippet) continue;
    const key = _fnv1a(snippet);
    const entry = byKey.get(key) || { snippet, labels: new Set() };
    const isSec = String(r?.watchlist?.status || '').toUpperCase() === 'MATCHED' || r.status === 'critical';
    const isAi = String(r?.ai_scan?.status || '').toUpperCase() === 'SUSPICIOUS' || r.status === 'warning';
    if (isSec) {
      const company = r.watchlist?.matched_company || null;
      entry.labels.add(company ? `SEC: ${company}` : 'SEC Match');
    }
    if (isAi) entry.labels.add('AI Flagged');
    if (!isSec && !isAi) entry.labels.add('Suspicious');
    byKey.set(key, entry);
  }
  const rows = Array.from(byKey.values()).map(({ snippet, labels }) => ({
    label: Array.from(labels).map((l) => `[${l}]`).join(' '),
    snippets: [snippet]
  }));
  if (!rows.length && flaggedResults.length) {
    rows.push({ label: '[Suspicious]', snippets: [] });
  }
  return rows;
}

// Content filter patterns to exclude (timestamps, dates, system labels, file extensions)
const _SKIP_PATTERNS = [
  // Timestamps: 7:14 PM, 2:30 AM, 14:30, etc.
  /^\d{1,2}:\d{2}\s*(AM|PM|am|pm)?$/,
  // Dates: May 14, 2026 or May 14 or 14 May
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(,\s*\d{4})?$/i,
  /^\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(\s+\d{4})?$/i,
  // System actions
  /forwarded an image/i,
  /sent a photo/i,
  /sent a video/i,
  /sent a file/i,
  /sent a document/i,
  /sent a voice message/i,
  /sent an audio/i,
  /sent a sticker/i,
  /shared a link/i,
  /sent a gif/i,
  // Bare attachment names (any file extension at end of string)
  /\.(pdf|jpg|jpeg|png|gif|doc|docx|xls|xlsx|ppt|pptx|mp4|mp3|mov|zip|rar|txt|csv|svg|webp|heic)$/i,
  // Facebook attachment bubble text (e.g. "document.pdf 2.3 MB")
  /^[\w\s().\-]+\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|png|jpe?g|gif|webp|mp4|mov|mp3|wav)(\s+\d+(\.\d+)?\s*(kb|mb|gb))?$/i,
  // Laughter / reactions (HAHAHA, lol, lmao, hehe, etc.)
  /^[ha]{4,}$/i,
  /^(ha)+h?$/i,
  /^(he)+h?$/i,
  /^(hi)+h?$/i,
  /^l+o+l+$/i,
  /^l+m+a+o+$/i,
  /^r+o+f+l+$/i,
  // Pure emoji strings (Unicode emoji ranges)
  /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\s]+$/u,
  // Single-word replies that are clearly not scam
  /^(ok|okay|oo|sige|ge|yes|no|yas|yep|nope|yup|nah|true|nice|wow|grabe|talaga|hala|amen|congrats|thanks|salamat|ty|hoy|uy|ui|awit|sheesh|bruh|lods|pre|mare|pare|tol|bro|sis|lol|omg|wtf)$/i,
];

// Minimum text length to send to AI scanner — short messages are almost never scam
const _MIN_SCAN_TEXT_LENGTH = 15;

function shouldSkipText(text) {
  if (!text || text.length < 5) return true;
  const trimmed = text.trim();
  // Skip very short text — not enough content for meaningful scam detection
  if (trimmed.length < _MIN_SCAN_TEXT_LENGTH) return true;
  for (const pattern of _SKIP_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  // Skip if text looks like a pure file name (no sentence-like words)
  if (_isMetadataOrAttachmentText(trimmed)) return true;
  // Skip text that is just repeated characters (e.g. "AAAAAA", "?????")
  if (/^(.)(\1|\s){3,}$/.test(trimmed)) return true;
  // Skip text that looks like a username or email address only
  if (/^[\w.@+-]+$/i.test(trimmed) && trimmed.length < 50) return true;
  return false;
}

function enqueueChatBubbleScan(bubbleEl, opts = {}) {
  const threadEl = opts.threadEl || _getThreadForBubble(bubbleEl);
  if (!threadEl) return { skipped: true, reason: 'no_thread' };

  // Prevent duplicate scanning of same bubble
  if (bubbleEl.classList.contains('suriin-scanned')) {
    return { skipped: true, reason: 'already_scanned' };
  }
  bubbleEl.classList.add('suriin-scanned');

  const bubbleText = extractChatBubbleText(bubbleEl);
  if (!bubbleText || bubbleText.length < 5) {
    return { skipped: true, reason: 'no_text' };
  }
  if (shouldSkipText(bubbleText)) {
    return { skipped: true, reason: 'filtered', text: bubbleText.substring(0, 50) };
  }

  const bubbleId = _ensureBubbleId(bubbleEl);
  const cacheKey = _makeChatCacheKey(threadEl, bubbleText);
  bubbleEl.dataset.suriinBubbleKey = cacheKey;

  const sessionId = opts.sessionId || null;
  const s = _ensureSession(sessionId);
  if (s) s.pending++;

  while (_suriinChatScanQueue.length >= _SURIIN_CHAT_QUEUE_MAX) {
    const dropped = _suriinChatScanQueue.shift();
    if (dropped?.sessionId) {
      const ds = _suriinChatSessions.get(dropped.sessionId);
      if (ds) {
        ds.pending = Math.max(0, ds.pending - 1);
        _finishSessionIfDone(dropped.sessionId);
      }
    }
  }

  _suriinChatScanQueue.push({ cacheKey, bubbleId, bubbleEl, threadEl, bubbleText, sessionId });
  void _runChatScanQueue();
  return { success: true, cacheKey, bubbleId };
}

async function _runChatScanQueue() {
  if (_suriinChatQueueRunning) return;
  _suriinChatQueueRunning = true;
  const runToken = _suriinChatQueueStopToken;
  try {
    while (_suriinChatScanQueue.length > 0) {
      if (runToken !== _suriinChatQueueStopToken) break;
      const item = _suriinChatScanQueue.shift();
      if (!item) continue;

      const { cacheKey, bubbleId, bubbleText, sessionId } = item;
      let bubbleEl = item.bubbleEl;
      const session = sessionId ? _suriinChatSessions.get(sessionId) : null;
      if (session) session.totalBubblesScanned++;

      if (!bubbleEl || !(bubbleEl instanceof Element) || !bubbleEl.isConnected) {
        // Element may have been replaced by a React re-render — attempt to recover
        // by finding a freshly rendered element with the same text content.
        let recoveredEl = null;
        if (bubbleText && bubbleText.length > 5) {
          try {
            for (const sel of _SURIIN_CHAT_BUBBLE_SELECTORS) {
              const match = Array.from(document.querySelectorAll(sel))
                .find(el => el.isConnected && extractChatBubbleText(el) === bubbleText);
              if (match) { recoveredEl = match; break; }
            }
          } catch { }
        }
        if (!recoveredEl) {
          if (session) session.pending--;
          _finishSessionIfDone(sessionId);
          continue;
        }
        bubbleEl = recoveredEl;
      }

      const prevHash = bubbleEl.dataset.suriinScanHash || '';
      const nextHash = _fnv1a(bubbleText);
      const hasCached = _suriinChatScanCache.has(cacheKey);
      if (hasCached && prevHash === nextHash) {
        const cached = _suriinChatScanCache.get(cacheKey);
        if (cached?.success && cached.status !== 'safe') {
          applyBubbleRiskUI(bubbleEl, cached, bubbleText);
        }
        _recordSessionScanResult(session, cached, bubbleText, bubbleId, cacheKey);
        if (session) session.pending--;
        _finishSessionIfDone(sessionId);
        continue;
      }

      bubbleEl.dataset.suriinScanHash = nextHash;

      let result = null;
      try {
        result = hasCached ? _suriinChatScanCache.get(cacheKey) : null;
        if (!result) {
          result = await _callBackgroundScan(bubbleText);
          if (result && typeof result === 'object') {
            _suriinChatScanCache.set(cacheKey, result);
          }
          await new Promise((r) => setTimeout(r, 220));
        }
      } catch (e) {
        if (session) session.pending--;
        _finishSessionIfDone(sessionId);
        continue;
      }

      if (result?.success && result.status !== 'safe') {
        applyBubbleRiskUI(bubbleEl, result, bubbleText);
      }
      _recordSessionScanResult(session, result, bubbleText, bubbleId, cacheKey);

      if (session) session.pending--;
      _finishSessionIfDone(sessionId);
    }
  } finally {
    _suriinChatQueueRunning = false;
  }
}

function applyBubbleRiskUI(bubbleEl, scanResult, bubbleText) {
  if (!bubbleEl || !(bubbleEl instanceof Element)) return;
  // For FB/Messenger, individual message rows fail the size-check in _isChatSurface,
  // so bypass it — bubbles are already scoped to their thread root by getChatBubblesInThread.
  // For other hosts, walk up ancestors to find a chat surface (the bubble itself may be too small).
  if (!_isFacebookHost() && !_isMessengerHost()) {
    let inChatSurface = _isChatSurface(bubbleEl);
    if (!inChatSurface) {
      let ancestor = bubbleEl.parentElement;
      for (let i = 0; i < 10 && ancestor && ancestor !== document.body; i++, ancestor = ancestor.parentElement) {
        if (_isChatSurface(ancestor)) { inChatSurface = true; break; }
      }
    }
    if (!inChatSurface) return;
  }
  const status = String(scanResult?.threat_level || scanResult?.status || 'safe').toLowerCase();
  let label = status.toUpperCase();
  let color = 'green';
  if (status === 'critical') {
    color = 'red';
  } else if (status === 'warning') {
    color = 'orange';
  }
  // Example: update label and icon color for modal UI
  if (bubbleEl && bubbleEl.querySelector('[data-suriin-overlay="bubble-modal"] .modal-label')) {
    const labelEl = bubbleEl.querySelector('[data-suriin-overlay="bubble-modal"] .modal-label');
    labelEl.textContent = label;
    labelEl.style.color = color;
  }
  if (status !== 'warning' && status !== 'critical') return;

  const isCritical = status === 'critical';
  const underlineColor = isCritical ? 'rgba(239,68,68,0.9)' : 'rgba(251,191,36,0.9)';

  if (!bubbleEl.dataset.suriinPrevPosition) {
    bubbleEl.dataset.suriinPrevPosition = bubbleEl.style.position || '';
  }
  bubbleEl.setAttribute('data-suriin-risk', status);
  try {
    const textZones = Array.from(bubbleEl.querySelectorAll('[dir="auto"]'));
    const targets = textZones.length > 0 ? textZones : [bubbleEl];
    for (const tz of targets) {
      if (isInsideEditableContext(tz) || (tz !== bubbleEl && !_isChatTextZone(tz))) continue;
      tz.dataset.suriinUnderlined = '1';
      tz.style.setProperty('text-decoration-line', 'underline', 'important');
      tz.style.setProperty('text-decoration-color', underlineColor, 'important');
      tz.style.setProperty('text-decoration-thickness', '2px', 'important');
      tz.style.setProperty('text-underline-offset', '3px', 'important');
    }
  } catch { }

  const st = window.getComputedStyle(bubbleEl);
  if (st.position === 'static') {
    bubbleEl.style.setProperty('position', 'relative', 'important');
  }

  const existingIcons = Array.from(bubbleEl.querySelectorAll('[data-suriin-bubble-icon="1"]'));
  let icon = existingIcons[0] || null;
  existingIcons.slice(1).forEach((dupe) => {
    try { dupe.remove(); } catch { }
  });
  if (!icon) {
    icon = document.createElement('button');
    icon.type = 'button';
    icon.setAttribute('data-suriin-bubble-icon', '1');
    icon.style.cssText = `
      position: absolute !important;
      top: 6px !important;
      right: 6px !important;
      width: 26px !important;
      height: 26px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      border-radius: 999px !important;
      border: 1.5px solid ${color} !important;
      background: rgba(15, 14, 23, 0.92) !important;
      cursor: pointer !important;
      padding: 0 !important;
      margin: 0 !important;
      z-index: 2147483646 !important;
      box-shadow: 0 2px 8px rgba(0,0,0,0.45) !important;
    `;
    bubbleEl.appendChild(icon);
  }

  const _rKey = _makeReportedKey(bubbleEl, bubbleText || '');
  if (_inlineSuccessByReportedKey.has(_rKey)) {
    _applyGreenShield({ iconHost: icon });
  } else {
    icon.innerHTML = isCritical
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="#FBBF24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    icon.style.setProperty('border-color', color, 'important');
    icon.style.setProperty('box-shadow', '0 2px 8px rgba(0,0,0,0.45)', 'important');
  }

  if (!_suriinBubbleUi.has(bubbleEl)) {
    _suriinBubbleUi.set(bubbleEl, { icon, modalContainer: null, ensureLoaded: null, scanResult: null, bubbleText: null });
  }
  const state = _suriinBubbleUi.get(bubbleEl);
  state.scanResult = scanResult;
  state.bubbleText = bubbleText;

  if (!icon._suriinClickAttached) {
    icon._suriinClickAttached = true;
    icon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const s = _suriinBubbleUi.get(bubbleEl);
      if (!s) return;
      openBubbleModal(bubbleEl, s.scanResult, s.bubbleText, icon);
    }, true);
  }
}

function openBubbleModal(bubbleEl, scanResult, bubbleText, anchorEl = null) {
  if (!bubbleEl || !(bubbleEl instanceof Element)) return;
  const st = _suriinBubbleUi.get(bubbleEl) || null;
  if (!st) return;

  if (!st.modalContainer || !st.ensureLoaded || !st.modalContainer.isConnected) {
    const modalContainer = document.createElement('div');
    modalContainer.setAttribute('data-suriin-overlay', 'bubble-modal');
    modalContainer.style.cssText = `
      position: fixed !important;
      top: 0px !important;
      left: 0px !important;
      z-index: 2147483647 !important;
      display: none !important;
      pointer-events: auto !important;
    `;

    const close = () => {
      modalContainer.style.setProperty('display', 'none', 'important');
      if (_activeSuriinInlineClose === close) _activeSuriinInlineClose = null;
    };

    const { modal, ensureLoaded, iframe: _bmIframe } = createSuriinPopupIframeModal(scanResult, bubbleText, close);
    modalContainer.appendChild(modal);
    document.body.appendChild(modalContainer);
    st.modalContainer = modalContainer;
    st.ensureLoaded = ensureLoaded;
    st.iframe = _bmIframe;
    st.close = close;
  }

  _attachInlineOutsideCloseListener();
  if (typeof _activeSuriinInlineClose === 'function' && _activeSuriinInlineClose !== st.close) {
    _activeSuriinInlineClose();
  }

  const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect() : bubbleEl.getBoundingClientRect();
  const padding = 12;
  const modalW = 290;
  const modalH = 300;
  const chatRoot = bubbleEl.closest('[data-suriin-fb-chatbox-root="1"], [data-pagelet^="ChatTab"], [role="dialog"]');
  const chatRect = chatRoot?.getBoundingClientRect?.() || null;
  // On Messenger the bubble is a full-width row — use the icon rect as the
  // overlap source so the small icon (not the whole row) drives collision checks.
  const sourceRect = (_isMessengerHost() && anchorEl)
    ? anchorEl.getBoundingClientRect()
    : bubbleEl.getBoundingClientRect();
  const overlapsSource = (c) => !(
    c.left + modalW < sourceRect.left ||
    c.left > sourceRect.right ||
    c.top + modalH < sourceRect.top ||
    c.top > sourceRect.bottom
  );
  const candidates = [
    { left: r.left - modalW - padding, top: r.top - 12 },
    { left: r.right + padding, top: r.top - 12 },
    { left: r.left - (modalW / 2) + (r.width / 2), top: r.top - modalH - padding },
    { left: r.left - (modalW / 2) + (r.width / 2), top: r.bottom + padding }
  ];
  if (_isMessengerHost()) {
    // Position just left of the Messenger chat panel (row left ≈ panel boundary)
    // so the modal is near the message row without covering it.
    const _rowLeft = bubbleEl.getBoundingClientRect().left;
    candidates.unshift({ left: Math.max(padding, _rowLeft - modalW - padding), top: Math.max(padding, r.top - 12) });
  } else if (chatRect && chatRect.width < modalW + 80) {
    candidates.unshift({ left: chatRect.left - modalW - padding, top: r.top - 12 });
  }
  let picked = candidates.find((c) => (
    c.left >= padding &&
    c.top >= padding &&
    c.left + modalW + padding <= window.innerWidth &&
    c.top + modalH + padding <= window.innerHeight &&
    !overlapsSource(c)
  )) || candidates[0];
  let left = Math.max(padding, Math.min(picked.left, window.innerWidth - modalW - padding));
  let top = Math.max(padding, Math.min(picked.top, window.innerHeight - modalH - padding));

  st.modalContainer.style.setProperty('left', `${Math.floor(left)}px`, 'important');
  st.modalContainer.style.setProperty('top', `${Math.floor(top)}px`, 'important');
  st.modalContainer.style.setProperty('display', 'block', 'important');
  _activeSuriinInlineClose = () => {
    st.modalContainer?.style.setProperty('display', 'none', 'important');
    if (_activeSuriinInlineClose) _activeSuriinInlineClose = null;
  };
  try {
    const ctxId = _makeInlineContextId(bubbleEl, 'bubble', bubbleText);
    const _rKey = _makeReportedKey(bubbleEl, bubbleText || '');
    // Register the bubble-modal iframe for SURIIN_INLINE_RESIZE + SUCCESS handling.
    // iconHost lets the SUCCESS handler swap the icon to a green shield (A4).
    // reportedKey lets the SUCCESS handler persist the state (A4).
    if (st.iframe) {
      _inlineContextToCo.set(ctxId, {
        iframe: st.iframe,
        modalWrapper: st.iframe.parentElement,
        modalOpen: true,
        iconHost: st.icon || null,
        reportedKey: _rKey,
        positionModal: () => {
          const h = parseInt(st.iframe.style.height, 10) || 300;
          const topNow = parseInt(st.modalContainer.style.top, 10) || 0;
          const maxTop = (window.innerHeight || 700) - h - 12;
          if (topNow > maxTop) {
            st.modalContainer.style.setProperty('top', `${Math.max(12, maxTop)}px`, 'important');
          }
        }
      });
    }
    // A5: if text was already reported, open directly to the success view
    const _prevSuccess = _inlineSuccessByReportedKey.get(_rKey) || null;
    st.ensureLoaded({ inlineContextId: ctxId, ...(_prevSuccess ? { inlineSuccessType: _prevSuccess } : {}) });
  } catch {
    st.ensureLoaded();
  }
}

function applyChatHighlightMarks(marks) {
  if (!Array.isArray(marks) || marks.length === 0) return;
  const esc = (s) => {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    } catch { }
    return String(s).replace(/"/g, '\\"');
  };
  for (const m of marks) {
    const bubbleId = m?.bubbleId;
    const bubbleKey = m?.bubbleKey;
    const status = String(m?.status || '').toLowerCase();
    if ((!bubbleId && !bubbleKey) || (status !== 'warning' && status !== 'critical')) continue;
    let el = null;
    if (bubbleId) {
      el = document.querySelector(`[data-suriin-bubble-id="${esc(bubbleId)}"]`);
    }
    if (!el && bubbleKey) {
      el = document.querySelector(`[data-suriin-bubble-key="${esc(bubbleKey)}"]`);
    }
    if (!el) continue;
    const cached = bubbleKey ? _suriinChatScanCache.get(bubbleKey) : null;
    applyBubbleRiskUI(el, cached || { status }, extractChatBubbleText(el));
  }
}

async function scanCurrentChatAndHighlight(opts = {}) {
  _manualScanActive = true;
  const onlyVisible = opts.onlyVisible !== false;
  const threads = getActiveChatThreads({ onlyVisible });
  resetSuriinScanState(threads);

  await new Promise(r => setTimeout(r, 80));

  const limitPerThread = Number.isFinite(opts.limitPerThread) ? Math.max(1, Math.floor(opts.limitPerThread)) : 60;

  try {

    if (!threads.length) {
      _manualScanActive = false;
      return {
        overallStatus: 'SAFE',
        overallScore: 0,
        totalBubblesScanned: 0,
        threatCount: 0,
        warningCount: 0,
        criticalCount: 0,
        marks: []
      };
    }

    const sessionId = `manual_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const session = _ensureSession(sessionId);

    for (const threadEl of threads) {
      try {
        const bubbles = getChatBubblesInThread(threadEl, { onlyVisible, limit: limitPerThread });
        for (const bubbleEl of bubbles) {
          try {
            enqueueChatBubbleScan(bubbleEl, { threadEl, sessionId });
          } catch (e) {
            console.warn('[SuriinAI] Failed to enqueue bubble:', e);
            // Continue with next bubble
          }
        }
      } catch (e) {
        console.warn('[SuriinAI] Failed to process thread:', e);
        // Continue with next thread
      }
    }

    if (session.pending === 0) {
      _finishSessionIfDone(sessionId);
    }

    return await session.promise;
  } catch (e) {
    console.error('[SuriinAI] scanCurrentChatAndHighlight error:', e);
    _manualScanActive = false;
    return {
      overallStatus: 'ERROR',
      overallScore: 0,
      totalBubblesScanned: 0,
      threatCount: 0,
      warningCount: 0,
      criticalCount: 0,
      marks: [],
      error: e?.message || String(e)
    };
  } finally {
    _manualScanActive = false;
  }
}

/**
 * Placeholder keywords to highlight inside flagged text.
 * Using exact short tokens instead of sentence prefixes ensures matching
 * even when React splits the text across multiple span elements.
 */
const PLACEHOLDER_KEYWORDS = ['test-scam'];

/** WeakSet of DOM TextNode references we have already highlighted.
 *  Prevents double-overlaying the same physical node while allowing
 *  multiple nodes with identical text to each get their own overlay. */
const _highlightedTextNodes = new WeakSet();

// ── PROGRESSIVE DISCLOSURE (hover-reveal icon) ────────────────────────────────
/** Maps the parentElement of each highlighted text node → its iconHost element.
 *  WeakMap keys are GC'd automatically when React removes the parent node. */
const _textParentToIconHost = new WeakMap();

/** The currently visible (hovered) icon, or null. */
let _hoveredIconHost = null;

/** Pending hide timer — cleared when cursor re-enters a highlight or icon. */
let _hideTimeout = null;

/** Guard to register global delegation listeners only once. */
let _globalHoverListenersAttached = false;

/**
 * Shows an iconHost by fading it in and enabling pointer events.
 * Hides any previously hovered icon first.
 * @param {HTMLElement} iconHost
 */
function _showHoverIcon(iconHost) {
  clearTimeout(_hideTimeout);
  if (_hoveredIconHost === iconHost) return;
  if (_hoveredIconHost) _hideHoverIcon();
  _hoveredIconHost = iconHost;
  iconHost.style.setProperty('opacity', '1', 'important');
  iconHost.style.setProperty('pointer-events', 'auto', 'important');
}

/** Hides the currently hovered icon (fade out, disable pointer events). */
function _hideHoverIcon() {
  if (!_hoveredIconHost) return;
  _hoveredIconHost.style.setProperty('opacity', '0', 'important');
  _hoveredIconHost.style.setProperty('pointer-events', 'none', 'important');
  _hoveredIconHost = null;
}

/**
 * Registers ONE set of mouseover/mouseout listeners on document.body (capture phase).
 * Uses event delegation — never attaches directly to React text nodes.
 * Idempotent: guarded by _globalHoverListenersAttached.
 */
function _attachGlobalHoverListeners() {
  if (_globalHoverListenersAttached) return;
  _globalHoverListenersAttached = true;

  document.body.addEventListener('mouseover', (e) => {
    // Direct hover over the icon itself
    const iconEl = e.target.closest?.('[data-suriin-overlay="icon"]');
    if (iconEl) { _showHoverIcon(iconEl); return; }

    // Walk up (≤10 levels) to find the parentElement of a highlighted text node
    let el = e.target;
    for (let d = 0; d < 10 && el && el !== document.body; d++, el = el.parentElement) {
      if (_textParentToIconHost.has(el)) {
        _showHoverIcon(_textParentToIconHost.get(el));
        return;
      }
    }
  }, true);

  document.body.addEventListener('mouseout', (e) => {
    if (!_hoveredIconHost) return;
    const rel = e.relatedTarget;
    if (rel) {
      // Cancel pending hide if cursor moves directly to the icon or another highlight
      if (rel.closest?.('[data-suriin-overlay="icon"]')) { clearTimeout(_hideTimeout); return; }
      let el = rel;
      for (let d = 0; d < 10 && el && el !== document.body; d++, el = el.parentElement) {
        if (_textParentToIconHost.has(el)) { clearTimeout(_hideTimeout); return; }
      }
    }
    // Delay hide — gives the cursor 900ms to travel from text to icon
    _hideTimeout = setTimeout(_hideHoverIcon, 900);
  }, true);
}

/** WeakSet of container/zone Elements already processed by flattened extraction.
 *  Prevents re-extracting the same container on every mutation batch while still
 *  allowing new containers (e.g. new comments, new chat rows) to be processed.
 *  Reassigned to a fresh WeakSet on SPA route change so a full re-scan is possible. */
let _processedContainers = new WeakSet();

/** MutationObserver instance (created once, reused) */
let _autoScanObserver = null;

/** IntersectionObserver — fires scan when a container scrolls into view */
let _intersectionObserver = null;

/** requestIdleCallback handle for the periodic deep-scan loop */
let _idleScanHandle = null;

/** Debounce timer ID */
let _debounceScanTimer = null;

/** Throttle state for the MutationObserver (200ms window) */
let _throttleActive = false;
let _throttleTrailingTimer = null;

/** Whether auto-scan observer is currently active */
let _autoScanObserverActive = false;

/** Whether the SPA route listener has been registered (guard against double-registration) */
let _spaListenerActive = false;

/** Structural selectors that signal content-bearing mutations worth processing.
 *  Mutations whose added nodes don't match any of these are dropped early. */
const RELEVANT_SELECTORS = [
  '[role="article"]',
  '[role="row"]',
  '[role="gridcell"]',
  '[role="listitem"]',
  '[aria-label="Comment"]',
  '[data-pagelet^="FeedUnit"]',
  '[dir="auto"]',
];

/** MutationObserver watching the FB/Messenger header for notification layout shifts */
let _headerMutObs = null;

/** Debounce timer for header-triggered overlay revalidation (max once per 500ms) */
let _headerRevalidateTimer = null;

/**
 * Returns the X offset (px) to add to cRect.right when positioning the icon.
 * Messenger chat bubbles have extra right-side padding that would push the icon
 * inside the bubble chrome, so we pull it back by 10px on messenger.com.
 * @returns {number}
 */
function _iconXOffset() {
  return 2;
}

// ══════════════════════════════════════════════════════════════════════════════
//  DOMAIN CONFIGURATION MAP
//  Maps hostnames to platform-specific extraction strategies.
//  Facebook & X/Twitter use container-based deep TreeWalkers.
//  Instagram uses querySelectorAll with leaf selectors.
//  Unknown domains fall back to __generic__ with a standalone-text guard.
// ══════════════════════════════════════════════════════════════════════════════

// ── X / Twitter container selectors ─────────────────────────────────────────
const _twitterContainers = [
  'article[data-testid="tweet"]',  // timeline tweet cards + reply cards + detail
  '[data-testid="cellInnerDiv"]',  // inner timeline cell wrapper
  '[data-testid="messageEntry"]',  // DM received/sent bubble
  '[data-testid="conversation"]',  // DM conversation thread fallback
];

// ── Facebook container selectors ────────────────────────────────────────────
// FB obfuscates classes, but these structural/role-based selectors are stable.
// Used by the "flattened extract" path — we find these containers, then look
// for content zones inside them and grab .textContent (defeats React splitting).
const _facebookContainers = [
  '[role="article"]',                     // feed posts + comment wrappers
  '[data-pagelet^="FeedUnit"]',           // newsfeed units (pagelet pattern)
  '[aria-label="Comment"]',               // individual comment wrappers
  '[role="complementary"] ul',            // right-rail / chat lists
  '[data-pagelet="RightRail"] ul',        // right-rail conversations
  '[role="main"] [role="article"]',       // posts inside the main content area
  '[role="dialog"] [role="article"]',     // post detail opened in a modal dialog
  '[data-pagelet^="ProfileTimeline"]',    // profile page timeline feed
  '[data-pagelet^="Profile"]',            // profile header / about sections
  '[role="dialog"]',                       // bare dialog — theater / detail / photo overlay
  '[role="article"] ul',                  // nested reply lists inside articles
  '[data-testid="Keycommand_wrapper_feed"]', // feed root container
  '[data-testid="fb-feed-item-content"]', // shared post inner content
  '[role="main"]',                        // main content area (broad fallback)
  '[role="row"]',                         // Messenger chat rows (facebook.com/messages)
  '[role="gridcell"]',                    // Messenger grid cells
  '[role="listitem"]',                    // Messenger list items
];

// Content-zone selectors — text-bearing sub-elements within each container.
// .textContent on these zones gives flattened text that spans React fragments.
const _facebookContentZones = [
  '[dir="auto"]',
  '.userContent',
  '[data-ad-preview="message"]',
  '[data-ad-comet-preview="message"]',
  '[data-testid="fb-feed-item-content"]',
];

// FB-specific UI noise — short standalone labels that live in spans outside <button>.
// Checked case-insensitively against the full trimmed text of each flattened zone.
const _facebookSkipText = /^(like|reply|share|comment|send|love|haha|wow|sad|angry|see more|hide|report|\d+[hmdw]?|view \d+ more|view more comments|most relevant|all comments|newest first|·|…)$/i;

// ── Messenger container selectors ──────────────────────────────────────────
// messenger.com uses a distinct React tree from facebook.com but similar patterns.
const _messengerContainers = [
  '[role="row"]',                              // message row in chat thread
  '[data-pagelet="MessengerMessage"]',         // pagelet-based message wrapper
  '[role="main"] [role="grid"] [role="row"]',  // chat grid rows
  '[role="main"] [role="listitem"]',           // message list items
  '[role="article"]',                          // fallback — some views use article
  '[data-testid="message-container"]',         // testid-based wrapper
  '[role="main"]',                             // broad fallback
];

const _messengerContentZones = [
  '[dir="auto"]',
  'span[dir="auto"]',
  '[role="gridcell"] [dir="auto"]',
];

const SURIIN_DOMAIN_CONFIG = {
  // ── Facebook — flattened .textContent extraction (defeats React span-splitting) ─
  'facebook.com': { containerSelectors: _facebookContainers, contentZoneSelectors: _facebookContentZones, useFlattenedExtract: true, skipTextPatterns: _facebookSkipText },
  'www.facebook.com': { containerSelectors: _facebookContainers, contentZoneSelectors: _facebookContentZones, useFlattenedExtract: true, skipTextPatterns: _facebookSkipText },
  'm.facebook.com': { containerSelectors: _facebookContainers, contentZoneSelectors: _facebookContentZones, useFlattenedExtract: true, skipTextPatterns: _facebookSkipText },

  // ── Messenger — same flattened extraction strategy ──────────────────────────
  'messenger.com': { containerSelectors: _messengerContainers, contentZoneSelectors: _messengerContentZones, useFlattenedExtract: true, skipTextPatterns: _facebookSkipText },
  'www.messenger.com': { containerSelectors: _messengerContainers, contentZoneSelectors: _messengerContentZones, useFlattenedExtract: true, skipTextPatterns: _facebookSkipText },

  // ── X / Twitter — container-based deep walker ──────────────────────────────
  'twitter.com': { containerSelectors: _twitterContainers, useContainerWalker: true },
  'x.com': { containerSelectors: _twitterContainers, useContainerWalker: true },

  // ── Instagram ──────────────────────────────────────────────────────────────
  'www.instagram.com': {
    selectors: [
      'article span',                    // post captions & comments
      'h1._aacl',                        // primary post caption
      '[role="presentation"] span',      // DM bubbles
      'div._aacl span',                  // alt caption class
    ]
  },

  // ── Generic fallback for unknown domains ───────────────────────────────────
  __generic__: {
    selectors: ['p', 'span', 'div'],
    minWords: 5,
    ignoreAncestors: [
      'nav', 'button', 'header', 'footer',
      'script', 'style', 'noscript', 'select', 'option', 'label',
      '[role="menu"]', '[role="navigation"]', '[aria-hidden="true"]',
    ],
  },
};

/**
 * Resolves the active domain config for the current page.
 * Falls back to __generic__ for unknown hostnames.
 * @returns {Object} domain config entry
 */
function getActiveDomainConfig() {
  const host = window.location.hostname;
  if (SURIIN_DOMAIN_CONFIG[host]) return SURIIN_DOMAIN_CONFIG[host];
  // Subdomain fallback: match any registered bare domain
  const bare = host.replace(/^www\./, '');
  for (const key of Object.keys(SURIIN_DOMAIN_CONFIG)) {
    if (key === '__generic__') continue;
    if (host.endsWith('.' + key) || bare === key) return SURIIN_DOMAIN_CONFIG[key];
  }
  return SURIIN_DOMAIN_CONFIG.__generic__;
}

/**
 * Extracts scannable text chunks from `root` using the active domain config.
 *
 * - Facebook (`useFlattenedExtract: true`): finds stable containers, then
 *   locates content zones inside each and grabs `.textContent` — this defeats
 *   React span-splitting by flattening all child text into one string.
 * - X/Twitter (`useContainerWalker: true`): finds stable high-level containers,
 *   then runs a TreeWalker inside each.
 * - `useGenericWalker: true` (reserved): runs a naive full-body TreeWalker.
 * - Instagram / Generic: uses querySelectorAll with domain-specific selectors,
 *   filtered by `shouldSkipNode`, `isInsideEditableContext`, optional viewport
 *   bounds, and (for the generic fallback) a standalone direct-text-node guard.
 *
 * @param {Element} root              - Root element to search within (document.body or a mutation-added node)
 * @param {boolean} filterViewport     - If true, only include elements within the current viewport
 * @param {boolean} skipContainerCache - If true, bypass _processedContainers guard (used by IntersectionObserver re-scan)
 * @returns {string[]} Deduplicated text chunks, each >= 8 characters
 */
function extractTextByConfig(root, filterViewport = false, skipContainerCache = false) {
  const config = getActiveDomainConfig();
  const vH = window.innerHeight;
  const vW = window.innerWidth;
  const collected = [];
  const seen = new Set();

  function isInViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom >= 0 && r.right >= 0 && r.top <= vH && r.left <= vW;
  }

  function addText(text) {
    const trimmed = text.trim();
    if (trimmed.length < 8) return;
    const key = location.hostname + '|' + _fnv1a(trimmed);
    if (!seen.has(key)) {
      seen.add(key);
      collected.push(trimmed);
    }
  }

  const restrictFacebookChatbox = _shouldRestrictToFacebookChatbox();
  const isAllowedScope = (el) => !restrictFacebookChatbox || _isInsideActiveFacebookChatbox(el);

  // ── Facebook: flattened .textContent extraction ────────────────────────────
  // Finds containers, locates content zones inside each, and grabs .textContent
  // on the zone element. This naturally joins React-split spans (e.g. "test" +
  // "-" + "scam" → "test-scam") so the full string reaches MOCK_SCAN.
  if (config.useFlattenedExtract) {
    const seenContainers = new Set();
    const seenZones = new Set();
    const skipRe = config.skipTextPatterns || null;
    const zoneSelectors = config.contentZoneSelectors || ['[dir="auto"]'];

    for (const selector of config.containerSelectors) {
      let containers = [];
      try {
        if (root.querySelectorAll) {
          containers = Array.from(root.querySelectorAll(selector));
        }
        if (root.matches && root.matches(selector)) {
          containers = [root, ...containers];
        }
      } catch { continue; }

      for (const container of containers) {
        if (seenContainers.has(container)) continue;
        seenContainers.add(container);

        if (!isAllowedScope(container)) continue;
        if (filterViewport && !isInViewport(container)) continue;

        // Find content zones within this container
        let zones = [];
        for (const zSel of zoneSelectors) {
          try {
            const found = container.querySelectorAll(zSel);
            zones.push(...found);
          } catch { /* skip invalid selector */ }
        }

        // If no content zones found, use the container itself as fallback
        if (zones.length === 0) zones = [container];

        for (const zone of zones) {
          if (seenZones.has(zone)) continue;
          seenZones.add(zone);
          if (!isAllowedScope(zone)) continue;

          // Skip zones we already processed in a previous mutation batch
          // (bypassed for IntersectionObserver re-scans so re-entered containers refresh)
          if (!skipContainerCache && _processedContainers.has(zone)) continue;

          // Skip editable contexts (input fields, textboxes, etc.)
          if (isInsideEditableContext(zone)) continue;
          if (_isChatSurface(zone) && !_isChatTextZone(zone)) continue;

          const flatText = zone.textContent?.trim();
          if (!flatText || flatText.length < 8) continue;

          // Skip pure UI noise (entire zone matches a noise pattern)
          if (skipRe && skipRe.test(flatText)) continue;

          _processedContainers.add(zone);
          addText(flatText);
        }
      }
    }
    return collected;
  }

  // ── Reserved: naive full-body TreeWalker (no domain currently uses this) ────
  if (config.useGenericWalker) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (filterViewport && !isInViewport(parent)) continue;
      addText(node.textContent);
    }
    return collected;
  }

  // ── Container-based deep walk (X/Twitter) ────────────────────────────────
  // Finds high-level stable containers, then TreeWalks text nodes inside them.
  // This is more resilient than querying specific leaf testids because React
  // may not have rendered inner elements at the time the mutation fires.
  //
  // Optional config keys honoured here:
  //   prioritizeDir  {boolean} - When true, prefer text nodes whose parent has
  //                              dir="auto" (Facebook user-generated text pattern).
  //   skipTextPatterns {RegExp} - Reject text nodes whose trimmed content matches
  //                              this pattern (FB "Like"/"Reply"/"Share" noise).
  if (config.useContainerWalker) {
    const seenContainers = new Set();
    const skipRe = config.skipTextPatterns || null;
    const wantDir = !!config.prioritizeDir;

    for (const selector of config.containerSelectors) {
      let containers = [];
      try {
        if (root.querySelectorAll) {
          containers = Array.from(root.querySelectorAll(selector));
        }
        if (root.matches && root.matches(selector)) {
          containers = [root, ...containers];
        }
      } catch { continue; }

      for (const container of containers) {
        if (seenContainers.has(container)) continue;
        seenContainers.add(container);

        if (filterViewport && !isInViewport(container)) continue;

        const walker = document.createTreeWalker(
          container,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode(node) {
              const txt = node.textContent.trim();
              if (!txt) return NodeFilter.FILTER_REJECT;
              if (!isAllowedScope(node.parentElement)) return NodeFilter.FILTER_REJECT;
              if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
              if (isInsideEditableContext(node)) return NodeFilter.FILTER_REJECT;
              // Skip FB UI noise ("Like", "Reply", "Share", timestamps, etc.)
              if (skipRe && skipRe.test(txt)) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );

        let textNode;
        while ((textNode = walker.nextNode())) {
          // When prioritizeDir is set, only collect text nodes that have an
          // ancestor with dir="auto" (FB user text), OR are inside a known
          // content wrapper (.userContent, ad preview), OR whose content is
          // >= 20 chars (long enough to be real content regardless of attr).
          if (wantDir) {
            const parent = textNode.parentElement;
            const hasDir = parent && parent.closest('[dir="auto"]');
            if (!hasDir) {
              const inContent = parent && (
                parent.closest('.userContent') ||
                parent.closest('[data-ad-preview="message"]') ||
                parent.closest('[data-ad-comet-preview="message"]')
              );
              if (!inContent && textNode.textContent.trim().length < 20) continue;
            }
          }
          addText(textNode.textContent);
        }
      }
    }
    return collected;
  }

  // ── Selector-based path (Instagram, Generic) ──────────────────────────────
  const { selectors, ignoreAncestors, minWords } = config;
  const ignoreSelector = ignoreAncestors?.join(', ') || null;

  for (const selector of selectors) {
    let elements = [];
    try {
      if (root.querySelectorAll) {
        elements = Array.from(root.querySelectorAll(selector));
      }
      // Also check if root itself matches the selector (e.g., the added node
      // IS a tweet text element) using document-scoped context matching.
      if (root.matches && root.matches(selector)) {
        elements = [root, ...elements];
      }
    } catch {
      continue; // guard against invalid selectors on certain platforms
    }

    for (const el of elements) {
      if (!isAllowedScope(el)) continue;
      if (shouldSkipNode(el)) continue;
      if (isInsideEditableContext(el)) continue;
      if (ignoreSelector && el.closest(ignoreSelector)) continue;

      // Generic fallback: require at least one direct text node child with
      // enough words to exclude nav labels, button text, aria labels, etc.
      if (minWords !== undefined) {
        const hasDirectText = Array.from(el.childNodes).some(child => {
          if (child.nodeType !== Node.TEXT_NODE) return false;
          return child.textContent.trim().split(/\s+/).filter(Boolean).length >= minWords;
        });
        if (!hasDirectText) continue;
      }

      if (filterViewport && !isInViewport(el)) continue;

      const text = (el.innerText || el.textContent || '').trim();
      addText(text);
    }
  }

  return collected;
}

// ── CONTEXT-AWARE EXTRACTOR ───────────────────────────────────────────────────

/**
 * Like extractTextByConfig but returns {text: string, containerEl: Element}[]
 * pairs so callers can compute a contextKey from the source DOM element.
 * Only implements the useFlattenedExtract branch (Facebook/Messenger).
 * Falls back to a plain string array wrapped with containerEl=document.body for
 * other platforms so the buffer still works (just with a generic key).
 * @param {Element} root
 * @param {boolean} filterViewport
 * @param {boolean} skipContainerCache
 * @returns {{text: string, containerEl: Element}[]}
 */
function _extractContainerPairs(root, filterViewport = false, skipContainerCache = false) {
  const config = getActiveDomainConfig();
  const vH = window.innerHeight;
  const vW = window.innerWidth;
  const collected = [];
  const seenTexts = new Set();
  const restrictFacebookChatbox = _shouldRestrictToFacebookChatbox();
  const isAllowedScope = (el) => !restrictFacebookChatbox || _isInsideActiveFacebookChatbox(el);

  function addPair(text, containerEl) {
    const trimmed = text.trim();
    if (trimmed.length < 8) return;
    const key = location.hostname + '|' + _fnv1a(trimmed);
    if (!seenTexts.has(key)) {
      seenTexts.add(key);
      collected.push({ text: trimmed, containerEl });
    }
  }

  if (config.useFlattenedExtract) {
    const seenContainers = new Set();
    const seenZones = new Set();
    const skipRe = config.skipTextPatterns || null;
    const zoneSelectors = config.contentZoneSelectors || ['[dir="auto"]'];

    for (const selector of config.containerSelectors) {
      let containers = [];
      try {
        if (root.querySelectorAll) containers = Array.from(root.querySelectorAll(selector));
        if (root.matches && root.matches(selector)) containers = [root, ...containers];
      } catch { continue; }

      for (const container of containers) {
        if (seenContainers.has(container)) continue;
        seenContainers.add(container);
        if (!isAllowedScope(container)) continue;
        if ((_isMessengerHost() || container.closest?.('[data-pagelet^="ChatTab"]')) && !_isChatSurface(container)) continue;
        if (filterViewport) {
          const r = container.getBoundingClientRect();
          if (r.bottom < 0 || r.right < 0 || r.top > vH || r.left > vW) continue;
        }

        let zones = [];
        for (const zSel of zoneSelectors) {
          try { zones.push(...container.querySelectorAll(zSel)); } catch { /* skip */ }
        }
        if (zones.length === 0) zones = [container];

        for (const zone of zones) {
          if (seenZones.has(zone)) continue;
          seenZones.add(zone);
          if (!isAllowedScope(zone)) continue;
          if (!skipContainerCache && _processedContainers.has(zone)) continue;
          if (isInsideEditableContext(zone)) continue;
          if (_isChatSurface(zone) && !_isChatTextZone(zone)) continue;
          const flatText = zone.textContent?.trim();
          if (!flatText || flatText.length < 8) continue;
          if (skipRe && skipRe.test(flatText)) continue;
          _processedContainers.add(zone);
          addPair(flatText, zone);
        }
      }
    }
    return collected;
  }

  // Non-flattenedExtract fallback: reuse extractTextByConfig and attach body as containerEl
  const plainTexts = extractTextByConfig(root, filterViewport, skipContainerCache);
  for (const text of plainTexts) {
    addPair(text, root);
  }
  return collected;
}

// ── DEBOUNCE UTILITY ──────────────────────────────────────────────────────────

/**
 * Creates a debounced version of a function.
 * Prevents the function from being called more than once per `delay` ms.
 * @param {Function} fn
 * @param {number} delay - milliseconds
 * @returns {Function}
 */
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, delay);
  };
}

// ── SAFE ELEMENT CHECKS ───────────────────────────────────────────────────────

/**
 * Checks whether a DOM node is inside an editable context that should NOT
 * be modified (to avoid breaking user typing in inputs, textareas,
 * contenteditable divs, etc.).
 * @param {Node} node
 * @returns {boolean} true if the node is in an unsafe/editable context
 */
function isInsideEditableContext(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el) return false;

  const tag = el.tagName?.toLowerCase();

  // Direct form elements
  if (['input', 'textarea', 'select', 'option'].includes(tag)) return true;

  // Contenteditable elements or their descendants
  if (el.isContentEditable) return true;
  if (el.closest('[contenteditable="true"], [contenteditable=""]')) return true;

  // Elements with specific roles that imply editability
  const role = el.getAttribute('role');
  if (['textbox', 'searchbox', 'combobox'].includes(role)) return true;

  // X/Twitter: reply and DM composer boxes (covers all viewport sizes)
  if (el.closest('[data-testid^="tweetTextarea"]')) return true;

  // Belt-and-suspenders: any contenteditable ancestor (catches empty-string variant
  // and deeply nested React trees where isContentEditable may not propagate)
  if (el.closest('[contenteditable]')) return true;

  // Skip elements the user is currently focused on (typing into)
  if (document.activeElement && (el === document.activeElement || el.contains(document.activeElement))) return true;

  return false;
}

/**
 * Checks whether a node should be skipped entirely during scanning.
 * @param {Node} node
 * @returns {boolean}
 */
function shouldSkipNode(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el) return true;
  if (_shouldRestrictToFacebookChatbox() && !_isInsideActiveFacebookChatbox(el)) return true;

  const tag = el.tagName?.toLowerCase();

  // Skip script/style/meta elements and non-content UI elements
  if (['script', 'style', 'noscript', 'head', 'svg', 'canvas', 'video', 'audio', 'iframe',
    'button', 'nav', 'select'].includes(tag)) return true;

  // Skip our own injected elements
  if (tag === 'suriin-scan-icon') return true;
  if (el.closest('suriin-scan-icon')) return true;
  if (el.closest('[data-suriin-highlighted]')) return true;

  // Skip editable contexts
  if (isInsideEditableContext(node)) return true;

  // Skip composer / comment-input areas
  if (el.closest('[role="textbox"]')) return true;
  if (el.closest('[aria-label*="Write a comment"]')) return true;

  return false;
}

// ── SPA ROUTE CHANGE LISTENER ─────────────────────────────────────────────────

/**
 * Fired whenever the SPA navigates to a new route.
 * Clears the result cache and re-runs the initial viewport scan after React
 * has had time (600 ms) to commit the new route's DOM.
 */
let _spaRouteTimer = null;
function onSpaRouteChange() {
  if (_spaRouteTimer) clearTimeout(_spaRouteTimer);

  // ── Immediate: clear caches so the new page never sees stale results ────────
  _scanResultCache.clear();
  _contextBuffers.clear();
  _processedContainers = new WeakSet();
  _inlineSuccessByContext.clear();
  _inlineSuccessByReportedKey.clear();
  document.querySelectorAll('[data-suriin-processed]').forEach(el => {
    el.removeAttribute('data-suriin-processed');
  });
  // Destroy all active container overlays so stale icons don't linger on new page
  _containerOverlays.forEach((_, el) => _destroyContainerOverlay(el));
  // Cancel and restart idle scan so it doesn't double-fire during navigation
  if (_idleScanHandle !== null) {
    cancelIdleCallback(_idleScanHandle);
    _idleScanHandle = null;
  }

  // ── Delayed: React needs ~600ms to commit the new route's DOM ───────────────
  _spaRouteTimer = setTimeout(() => {
    _spaRouteTimer = null;
    console.log('[SuriinAI] SPA route change detected — re-scanning viewport.');
    try {
      chrome.storage.local.get([_SURIIN_REPORTED_TEXTS_KEY, _SURIIN_REPORTED_CONTEXTS_KEY], (stored) => {
        _inlineSuccessByReportedKey.clear();
        const obj = (stored && typeof stored[_SURIIN_REPORTED_TEXTS_KEY] === 'object')
          ? stored[_SURIIN_REPORTED_TEXTS_KEY]
          : {};
        for (const [k, st] of Object.entries(obj)) {
          _inlineSuccessByReportedKey.set(k, st);
        }
        if (stored && stored[_SURIIN_REPORTED_CONTEXTS_KEY]) {
          chrome.storage.local.remove([_SURIIN_REPORTED_CONTEXTS_KEY]);
        }
        runAutoScanWithHighlighting();
        _observeContainersForIntersection();
        _scheduleIdleScan();
      });
    } catch {
      runAutoScanWithHighlighting();
      _observeContainersForIntersection();
      _scheduleIdleScan();
    }
  }, 600);
}

/**
 * Registers pushState / replaceState patches and a popstate listener so that
 * SPA route changes always trigger a re-scan.
 * Safe to call multiple times — _spaListenerActive guards against repetition.
 */
function startSpaRouteListener() {
  if (_spaListenerActive) return;
  _spaListenerActive = true;

  // Monkey-patch history.pushState
  const _origPush = history.pushState.bind(history);
  history.pushState = function (...args) {
    _origPush(...args);
    onSpaRouteChange();
  };

  // Monkey-patch history.replaceState
  const _origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _origReplace(...args);
    onSpaRouteChange();
  };

  // Back / forward button
  window.addEventListener('popstate', onSpaRouteChange);

  // NOTE: <title> observer intentionally omitted — Facebook and Messenger update
  // the title on every notification/message, causing constant false-positive
  // onSpaRouteChange() calls that destroy overlays faster than they can be rebuilt.
  // pushState/replaceState patches + popstate cover all real SPA navigations.

  console.log('[SuriinAI] SPA route listener registered.');
}

// ── PERFORMANCE HELPERS ───────────────────────────────────────────────────────

/**
 * Returns true only for mutations that touch known content containers.
 * Drops unrelated mutations (nav updates, ads, scripts, etc.) before they
 * reach the queue, reducing CPU overhead by up to ~80% on busy feeds.
 * @param {MutationRecord} m
 * @returns {boolean}
 */
function _isMutationRelevant(m) {
  if (m.type === 'characterData') return true;
  if (m.type !== 'childList' || m.addedNodes.length === 0) return false;
  for (const node of m.addedNodes) {
    if (node.nodeType === Node.TEXT_NODE) return true;
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    for (const sel of RELEVANT_SELECTORS) {
      try {
        if (node.matches(sel) || node.closest(sel) || node.querySelector(sel)) {
          return true;
        }
      } catch { /* invalid selector — skip */ }
    }
  }
  return false;
}

/**
 * Processes a batch of pending MutationRecords: extracts text and scans it.
 * Extracted from the observer callback so it can be called from both the
 * leading-edge and trailing-edge throttle paths.
 * @param {MutationRecord[]} batch
 */
function _flushPendingMutations(batch) {
  if (batch.length === 0) return;
  try {
    // Extract {text, containerEl} pairs from mutations so we can build context keys.
    // For mutations, we reconstruct pairs by re-running _extractContainerPairs on
    // each added element node, and use a fallback containerEl for plain text nodes.
    const contextItems = [];
    const seen = new Set();

    for (const mutation of batch) {
      if (mutation.type === 'characterData') {
        const text = mutation.target.textContent?.trim();
        if (text && text.length >= 8 && !shouldSkipNode(mutation.target)) {
          const containerEl = mutation.target.parentElement ?? document.body;
          const ctxKey = _getContextKey(containerEl);
          _pushToContextBuffer(ctxKey, text);
          const bufferText = _contextBuffers.get(ctxKey).join(' ');
          const key = location.hostname + '|' + _fnv1a(text);
          if (!seen.has(key)) { seen.add(key); contextItems.push({ text, bufferText }); }
        }
        continue;
      }
      for (const addedNode of mutation.addedNodes) {
        if (addedNode.nodeType === Node.TEXT_NODE) {
          const text = addedNode.textContent?.trim();
          if (text && text.length >= 8 && !shouldSkipNode(addedNode)) {
            const containerEl = addedNode.parentElement ?? document.body;
            const ctxKey = _getContextKey(containerEl);
            _pushToContextBuffer(ctxKey, text);
            const bufferText = _contextBuffers.get(ctxKey).join(' ');
            const key = location.hostname + '|' + _fnv1a(text);
            if (!seen.has(key)) { seen.add(key); contextItems.push({ text, bufferText }); }
          }
          continue;
        }
        if (addedNode.nodeType === Node.ELEMENT_NODE) {
          if (shouldSkipNode(addedNode)) continue;
          const pairs = _extractContainerPairs(addedNode, false, true);
          for (const { text, containerEl } of pairs) {
            const parts = text.split(/(?<=[.!?\n])\s+/).map(s => s.trim()).filter(s => s.length >= 8);
            for (const part of parts) {
              const key = location.hostname + '|' + _fnv1a(part);
              if (seen.has(key)) continue;
              seen.add(key);
              const ctxKey = _getContextKey(containerEl);
              _pushToContextBuffer(ctxKey, part);
              const bufferText = _contextBuffers.get(ctxKey).join(' ');
              contextItems.push({ text: part, bufferText });
            }
          }
        }
      }
    }

    if (contextItems.length > 0) {
      scanAndHighlightChunksWithContext(contextItems);
      _observeContainersForIntersection();
    }
  } catch (err) {
    console.warn('[SuriinAI] Mutation batch processing error:', err);
  }
}

/**
 * Queries all container selectors for the active domain config and registers
 * each element with the IntersectionObserver. Idempotent — observing an
 * already-observed element is a no-op in the browser API.
 */
function _observeContainersForIntersection() {
  if (!_intersectionObserver) return;
  const config = getActiveDomainConfig();
  const selectors = config.containerSelectors || [];
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach(el => {
        _intersectionObserver.observe(el);
      });
    } catch { /* skip invalid selector */ }
  }
}

/**
 * Creates (or recreates) the IntersectionObserver that triggers a scan
 * whenever a content container scrolls into the viewport.
 * Uses threshold 0.1 — fires when ≥10% of the container is visible.
 */
function startIntersectionObserver() {
  if (_intersectionObserver) {
    _intersectionObserver.disconnect();
  }
  _intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const container = entry.target;
      // Option 3: delete zones inside this container from _processedContainers
      // so re-extraction runs but _scanResultCache skips the MOCK_SCAN call.
      // This re-highlights nodes that React may have re-created on scroll-back.
      const config = getActiveDomainConfig();
      const zoneSelectors = config.contentZoneSelectors || ['[dir="auto"]'];
      for (const zSel of zoneSelectors) {
        try {
          container.querySelectorAll(zSel).forEach(zone => {
            // Clear injection-check stamp so the overlay can re-attach after React re-renders
            zone.removeAttribute('data-suriin-processed');
          });
        } catch { /* skip */ }
      }
      // Re-extract and scan the now-visible container with context buffer support.
      const pairs = _extractContainerPairs(container, false, true);
      if (pairs.length > 0) {
        const ctxItems = [];
        const seenIO = new Set();
        for (const { text, containerEl } of pairs) {
          const parts = text.split(/(?<=[.!?\n])\s+/).map(s => s.trim()).filter(s => s.length >= 8);
          for (const part of parts) {
            const key = location.hostname + '|' + _fnv1a(part);
            if (seenIO.has(key)) continue;
            seenIO.add(key);
            const ctxKey = _getContextKey(containerEl);
            _pushToContextBuffer(ctxKey, part);
            const bufferText = _contextBuffers.get(ctxKey).join(' ');
            ctxItems.push({ text: part, bufferText });
          }
        }
        scanAndHighlightChunksWithContext(ctxItems);
      }
      // Restore icon for this container if it was hidden while scrolled out
      const _co = _containerOverlays.get(container);
      if (_co && container.isConnected) {
        _co.iconHost.style.setProperty('display', 'flex', 'important');
      }
    }
  }, { threshold: 0.1 });

  _observeContainersForIntersection();
}

/**
 * Schedules a full viewport deep-scan using requestIdleCallback every ~2s.
 * Catches posts/comments missed during rapid scrolling or React hydration.
 * Self-rescheduling — call once from startAutoScanObserver().
 */
function _scheduleIdleScan() {
  if (_idleScanHandle !== null) return; // already scheduled
  _idleScanHandle = requestIdleCallback(() => {
    _idleScanHandle = null;
    if (!_autoScanObserverActive) return; // observer was stopped
    runAutoScanWithHighlighting();
    _scheduleIdleScan(); // reschedule for the next idle window
  }, { timeout: 2000 });
}

// ── MUTATION OBSERVER AUTO-SCAN ───────────────────────────────────────────────

/**
 * Starts the MutationObserver that watches the DOM for newly added nodes.
 * When new text appears (SPA navigation, infinite scroll, dynamic content),
 * it is throttled and sent to the background mock scan API.
 */
function startAutoScanObserver() {
  if (_autoScanObserverActive) return;
  _autoScanObserverActive = true;

  if (_autoScanObserver) {
    try { _autoScanObserver.disconnect(); } catch { }
    _autoScanObserver = null;
  }

  _autoScanObserver = new MutationObserver((mutationList) => {
    const newBubbleEls = new Map(); // bubbleEl -> threadEl
    for (const m of mutationList) {
      if (m.type !== 'childList') continue;
      for (const n of m.addedNodes) {
        if (!n) continue;
        if (n.nodeType === Node.ELEMENT_NODE) {
          const el = /** @type {Element} */ (n);
          try { if (isInsideEditableContext(el)) continue; } catch { }
          // For Facebook/Messenger: find the chatbox root that contains this new node.
          // This prevents scanning elements outside chatboxes (sidebar, feed, ads).
          let fbThreadEl = null;
          if (_isFacebookHost() || _isMessengerHost()) {
            fbThreadEl = _getThreadForBubble(el) || null;
            // If we can't find a thread for this element, try its children below.
            // (The added node might be a wrapper div containing bubble rows.)
          }
          for (const sel of _SURIIN_CHAT_BUBBLE_SELECTORS) {
            try {
              if (el.matches && el.matches(sel)) {
                if (_isFacebookHost() || _isMessengerHost()) {
                  // For FB/Messenger, require the bubble to be inside a known chatbox root.
                  const threadEl = fbThreadEl || _getThreadForBubble(el);
                  if (threadEl) newBubbleEls.set(el, threadEl);
                } else if (_isChatSurface(el) || _getThreadForBubble(el)) {
                  newBubbleEls.set(el, _getThreadForBubble(el));
                }
              }
              el.querySelectorAll && el.querySelectorAll(sel).forEach(b => {
                if (_isFacebookHost() || _isMessengerHost()) {
                  const threadEl = _getThreadForBubble(b);
                  if (threadEl) newBubbleEls.set(b, threadEl);
                } else if (_isChatSurface(b) || _getThreadForBubble(b)) {
                  newBubbleEls.set(b, _getThreadForBubble(b));
                }
              });
            } catch { }
          }
          try {
            const zones = (el.matches && el.matches('[dir="auto"]'))
              ? [el]
              : Array.from(el.querySelectorAll ? el.querySelectorAll('[dir="auto"]') : []);
            for (const zone of zones) {
              if (!_isChatTextZone(zone)) continue;
              const text = (zone.textContent || '').trim();
              if (text.length < 5) continue;
              _findBubblesBottomUp(zone.parentElement || zone, { onlyVisible: false, limit: 5 })
                .forEach(b => {
                  if (!newBubbleEls.has(b)) {
                    const threadEl = _getThreadForBubble(b);
                    if (threadEl) newBubbleEls.set(b, threadEl);
                  }
                });
            }
          } catch { }
        }
      }
    }
    if (newBubbleEls.size === 0) return;
    const allBubbles = Array.from(newBubbleEls.keys());
    const dedupedBubbles = _dedupeByContainment(allBubbles);
    for (const bubbleEl of dedupedBubbles) {
      const threadEl = newBubbleEls.get(bubbleEl) || _getThreadForBubble(bubbleEl);
      if (!threadEl) continue;
      enqueueChatBubbleScan(bubbleEl, { threadEl });
    }
  });

  _autoScanObserver.observe(document.body, { childList: true, subtree: true });
  startSpaRouteListener();
  void runAutoScanWithHighlighting();
}

/**
 * Stops the MutationObserver and cleans up timers.
 */
function stopAutoScanObserver() {
  if (_autoScanObserver) {
    _autoScanObserver.disconnect();
    _autoScanObserver = null;
  }
  _suriinChatQueueStopToken++;
  _suriinChatScanQueue.length = 0;
  if (_debounceScanTimer) {
    clearTimeout(_debounceScanTimer);
    _debounceScanTimer = null;
  }
  if (_throttleTrailingTimer) {
    clearTimeout(_throttleTrailingTimer);
    _throttleTrailingTimer = null;
  }
  _throttleActive = false;
  _autoScanObserverActive = false;
  // Disconnect header mutation observer
  if (_headerMutObs) {
    _headerMutObs.disconnect();
    _headerMutObs = null;
  }
  if (_headerRevalidateTimer) {
    clearTimeout(_headerRevalidateTimer);
    _headerRevalidateTimer = null;
  }
  try {
    document.querySelectorAll('[data-suriin-bubble-icon="1"]').forEach((b) => {
      try { b.remove(); } catch { }
    });
    document.querySelectorAll('[data-suriin-risk]').forEach((el) => {
      try {
        const prevPos = el.dataset.suriinPrevPosition ?? '';
        if (prevPos) el.style.position = prevPos;
        else el.style.removeProperty('position');
        el.removeAttribute('data-suriin-risk');
        delete el.dataset.suriinPrevPosition;
      } catch { }
    });
    document.querySelectorAll('[data-suriin-underlined="1"]').forEach((el) => {
      try {
        el.style.removeProperty('text-decoration-line');
        el.style.removeProperty('text-decoration-color');
        el.style.removeProperty('text-decoration-thickness');
        el.style.removeProperty('text-underline-offset');
        delete el.dataset.suriinUnderlined;
      } catch { }
    });
  } catch { }
  console.log('[SuriinAI] MutationObserver stopped.');
}

/**
 * Extracts text content from newly added DOM nodes (from MutationObserver).
 * Uses the active domain config via extractTextByConfig for element nodes.
 * Skips editable contexts, scripts, styles, and already-scanned nodes.
 * @param {MutationRecord[]} mutations
 * @returns {string[]} Array of text chunks to scan
 */
function extractTextFromMutations(mutations) {
  const textChunks = [];

  for (const mutation of mutations) {
    // ── characterData: raw text of an existing Text node changed ─────────────
    if (mutation.type === 'characterData') {
      const textNode = mutation.target;
      const text = textNode.textContent?.trim();
      if (text && text.length >= 8 && !shouldSkipNode(textNode)) {
        textChunks.push(text);
      }
      continue;
    }

    // ── childList: new nodes added to the DOM ─────────────────────────────────
    for (const addedNode of mutation.addedNodes) {
      // Text node added directly — keep existing lightweight check
      if (addedNode.nodeType === Node.TEXT_NODE) {
        const text = addedNode.textContent?.trim();
        if (text && text.length >= 8 && !shouldSkipNode(addedNode)) {
          textChunks.push(text);
        }
        continue;
      }

      // Element node — delegate to domain-aware extractor (no viewport filter).
      // skipContainerCache=true: bypass _processedContainers so a newly-injected
      // comment node isn't silently dropped because its [dir="auto"] zone was
      // already processed when the parent article first loaded.
      // _scanResultCache still prevents duplicate MOCK_SCAN API calls.
      if (addedNode.nodeType === Node.ELEMENT_NODE) {
        if (shouldSkipNode(addedNode)) continue;
        const chunks = extractTextByConfig(addedNode, false, true);
        textChunks.push(...chunks);
      }
    }
  }

  // Deduplicate and split long chunks into sentences
  const allSentences = [];
  const seen = new Set();

  for (const chunk of textChunks) {
    const sentences = chunk
      .split(/(?<=[.!?\n])\s+/)
      .map(s => s.trim())
      .filter(s => s.length >= 8);

    for (const sentence of sentences) {
      const key = location.hostname + '|' + _fnv1a(sentence);
      if (!seen.has(key)) {
        seen.add(key);
        allSentences.push(sentence);
      }
    }
  }

  return allSentences;
}

// ── CORE SCAN + HIGHLIGHT PIPELINE ────────────────────────────────────────────

/**
 * Checks if the extension context (chrome.runtime) is still valid.
 * After an extension reload/update, the old content script's runtime is invalidated.
 * @returns {boolean}
 */
function isExtensionContextValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

/**
 * Sends text chunks to the background MOCK_SCAN API and highlights flagged ones.
 * Shared by both the initial viewport scan and the MutationObserver.
 * @param {string[]} chunks
 */
async function scanAndHighlightChunks(chunks) {
  for (const chunk of chunks) {
    const sanitizedChunk = sanitizeScanText(chunk);

    // Bail out if extension context was invalidated (extension reloaded)
    if (!isExtensionContextValid()) {
      console.warn('[SuriinAI] Extension context invalidated — stopping auto-scan.');
      stopAutoScanObserver();
      return;
    }

    const chunkKey = location.hostname + '|' + _fnv1a(sanitizedChunk);

    // ── Fast path: we already scanned this text — skip MOCK_SCAN but still
    //    re-run highlightAndInjectUI so any NEW DOM nodes with the same text
    //    (e.g. a second "test-scam" comment loaded via scroll) get overlaid.
    const cached = _scanResultCache.get(chunkKey);
    if (cached) {
      if (cached.success && cached.status !== 'safe') {
        highlightAndInjectUI(chunk, cached);
      }
      continue;
    }

    try {
      const result = await new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage(
            { action: 'MOCK_SCAN', text: sanitizedChunk },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(response);
              }
            }
          );
        } catch (err) {
          reject(err);
        }
      });

      // Cache the result regardless of status (safe results are cached too
      // so we don't re-scan them)
      if (result) _scanResultCache.set(chunkKey, result);

      if (result?.success && result.status !== 'safe') {
        console.log(`[SuriinAI] Flagged (${result.status}):`, chunk.substring(0, 50) + '…');
        highlightAndInjectUI(chunk, result);
      }
    } catch (err) {
      if (err.message?.includes('Extension context invalidated')) {
        console.warn('[SuriinAI] Extension was reloaded — auto-scan stopped. Refresh the page to resume.');
        stopAutoScanObserver();
        return;
      }
      console.warn('[SuriinAI] Scan chunk error:', err.message);
    }
  }
}

/**
 * Context-aware scan: each item carries the current text AND the pre-built
 * bufferText (concatenated recent messages for the same thread/post).
 * The bufferText is what gets sent to MOCK_SCAN / real API so cross-message
 * patterns are detectable. Highlights use triggerWords from the response,
 * searching only within the current item's text to avoid cross-node crashes.
 * @param {{text: string, bufferText: string}[]} items
 */
async function scanAndHighlightChunksWithContext(items) {
  for (const { text, bufferText } of items) {
    if (!isExtensionContextValid()) {
      console.warn('[SuriinAI] Extension context invalidated — stopping auto-scan.');
      stopAutoScanObserver();
      return;
    }

    const sanitizedBufferText = sanitizeScanText(bufferText);

    // Cache key is based on bufferText so the same buffer state hits the cache.
    const chunkKey = location.hostname + '|ctx|' + _fnv1a(sanitizedBufferText);

    const cached = _scanResultCache.get(chunkKey);
    if (cached) {
      if (cached.success && cached.status !== 'safe') {
        highlightAndInjectUI(text, cached);
      }
      continue;
    }

    try {
      const result = await new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage(
            { action: 'MOCK_SCAN', text: sanitizedBufferText },
            (response) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(response);
            }
          );
        } catch (err) { reject(err); }
      });

      if (result) _scanResultCache.set(chunkKey, result);

      if (result?.success && result.status !== 'safe') {
        const label = result.triggerWords?.length
          ? `triggerWords=[${result.triggerWords.join(',')}]`
          : result.status;
        console.log(`[SuriinAI] Flagged (${label}):`, text.substring(0, 50) + '\u2026');
        highlightAndInjectUI(text, result);
      }
    } catch (err) {
      if (err.message?.includes('Extension context invalidated')) {
        console.warn('[SuriinAI] Extension was reloaded — auto-scan stopped. Refresh the page to resume.');
        stopAutoScanObserver();
        return;
      }
      console.warn('[SuriinAI] Scan chunk error:', err.message);
    }
  }
}

/**
 * Runs the initial auto-scan: extracts per-element text chunks from the viewport
 * using the context-aware extractor, builds the sliding context buffer for each
 * thread/post, and scans each chunk using the concatenated buffer as context.
 */
async function runAutoScanWithHighlighting() {
  if (_manualScanActive) return;
  const threads = getActiveChatThreads({ onlyVisible: true, allThreads: true });
  if (!threads.length) return;

  for (const threadEl of threads) {
    const bubbles = getChatBubblesInThread(threadEl, { onlyVisible: true, limit: 40 });
    for (const bubbleEl of bubbles) {
      enqueueChatBubbleScan(bubbleEl, { threadEl });
    }
  }
}

// ── AUTO-SCAN STATE LISTENER ──────────────────────────────────────────────────

/**
 * Listens for auto-scan mode changes in chrome.storage and starts/stops
 * the MutationObserver accordingly.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && 'suriin_auto_scan_enabled' in changes) {
    _clearSuriinScanUi({ clearQueue: true });
    const enabled = changes.suriin_auto_scan_enabled.newValue === true;
    if (enabled) {
      startAutoScanObserver();
    } else {
      stopAutoScanObserver();
    }
  }
});

// On content script init, check if auto-scan is already enabled
chrome.storage.local.get('suriin_auto_scan_enabled', (stored) => {
  if (stored.suriin_auto_scan_enabled === true) {
    startAutoScanObserver();
  }
});

/**
 * Container-keyed overlay map.
 * Key:   HTMLElement — the closest semantic container (row/article/comment/dir=auto)
 * Value: ContainerOverlay — { iconHost, modalContainer, highlights Map, scanResult,
 *                             domRemovalObs, modalOpen, hasShownOnce }
 * One icon per container; one underline HighlightEntry per flagged word inside it.
 */
const _containerOverlays = new Map();

const _inlineSuccessByContext = new Map();
const _inlineSuccessByReportedKey = new Map();
const _SURIIN_REPORTED_TEXTS_KEY = 'suriin_reported_texts';
const _SURIIN_REPORTED_CONTEXTS_KEY = 'suriin_reported_contexts';
const _inlineContextToCo = new Map();
let _inlineMessageListenerAttached = false;

// Pre-load reported text keys so any overlay created after a page refresh
// immediately shows the green shield for already-reported texts.
chrome.storage.local.get(_SURIIN_REPORTED_TEXTS_KEY, (stored) => {
  const existing = (stored && typeof stored[_SURIIN_REPORTED_TEXTS_KEY] === 'object')
    ? stored[_SURIIN_REPORTED_TEXTS_KEY]
    : {};
  Object.entries(existing).forEach(([key, val]) => {
    const st = typeof val === 'string' ? val : (val?.type || 'report');
    if (st) _inlineSuccessByReportedKey.set(key, st);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[_SURIIN_REPORTED_TEXTS_KEY]) {
    const newVal = changes[_SURIIN_REPORTED_TEXTS_KEY].newValue || {};
    Object.entries(newVal).forEach(([key, val]) => {
      const successType = typeof val === 'string' ? val : (val?.type || 'report');
      if (successType && !_inlineSuccessByReportedKey.has(key)) {
        _inlineSuccessByReportedKey.set(key, successType);
        
        // 1. Update bubble overlays
        for (const [, co] of _inlineContextToCo.entries()) {
          if (co.reportedKey === key) {
            co.inlineSuccessType = successType;
            _applyGreenShield(co);
            if (co.iframe?.contentWindow) {
              co.iframe.contentWindow.postMessage({ type: 'SURIIN_INLINE_SUCCESS_EXTERNAL', successType }, '*');
            }
          }
        }
        
        // 2. Update non-bubble overlays
        for (const [, co] of _containerOverlays.entries()) {
          if (co.reportedKey === key) {
            co.inlineSuccessType = successType;
            _applyGreenShield(co);
            if (co.iframe?.contentWindow) {
              co.iframe.contentWindow.postMessage({ type: 'SURIIN_INLINE_SUCCESS_EXTERNAL', successType }, '*');
            }
          }
        }
        
        // 3. Update matching bubble icons in _suriinBubbleUi
        for (const [bubbleEl, st] of _suriinBubbleUi.entries()) {
          const _rKey = _makeReportedKey(bubbleEl, st.bubbleText || '');
          if (_rKey === key) {
            if (st.icon) {
              _applyGreenShield({ iconHost: st.icon });
            }
            const inlineId = _makeInlineContextId(bubbleEl, 'bubble', st.bubbleText);
            const co = _inlineContextToCo.get(inlineId);
            if (co) {
              co.inlineSuccessType = successType;
              if (co.iframe?.contentWindow) {
                co.iframe.contentWindow.postMessage({ type: 'SURIIN_INLINE_SUCCESS_EXTERNAL', successType }, '*');
              }
            }
          }
        }
      }
    });
  }
});

/**
 * Applies the green shield icon and border to a ContainerOverlay record.
 * @param {Object} co
 */
function _applyGreenShield(co) {
  if (!co || !co.iconHost) return;
  co.iconHost.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>';
  co.iconHost.style.setProperty('border-color', 'rgba(34,197,94,0.5)', 'important');
  co.iconHost.style.setProperty('box-shadow', '0 2px 8px rgba(0,0,0,0.4), 0 0 12px rgba(34,197,94,0.3)', 'important');
}

function _hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function _makeInlineContextId(containerEl, seed, targetText) {
  const ctxKey = _getContextKey(containerEl);
  const textHash = _fnv1a(String(targetText || ''));
  const raw = `${location.hostname}|${ctxKey}|${seed}|${textHash}`;
  return `ctx_${_hash32(raw)}`;
}

function _makeReportedKey(_containerEl, targetText) {
  let host = location.hostname.replace(/^www\./i, '').toLowerCase();
  if (host.includes('facebook.com') || host.includes('messenger.com')) {
    host = 'facebook.com';
  }
  const t = String(targetText || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${host}|rp|${_fnv1a(t)}`;
}

function _attachInlineMessageListener() {
  if (_inlineMessageListenerAttached) return;
  _inlineMessageListenerAttached = true;

  window.addEventListener('message', (ev) => {
    const d = ev?.data;
    if (!d || typeof d !== 'object') return;

    if (d.type === 'SURIIN_INLINE_RESIZE') {
      const id = d.inlineContextId;
      const rawH = Number(d.height);
      const h = Number.isFinite(rawH) ? Math.floor(rawH) : 0;
      let co = id ? _inlineContextToCo.get(id) : null;
      if (!co && ev?.source) {
        for (const [, _co] of _containerOverlays) {
          if (_co?.iframe?.contentWindow && _co.iframe.contentWindow === ev.source) {
            co = _co;
            break;
          }
        }
      }
      if (!co || !co.iframe) return;
      const maxH = Math.max(220, Math.min((window.screen.availHeight || window.innerHeight || 700) - 8, 900));
      const clamped = Math.max(160, Math.min(h || 0, maxH));
      if (!clamped) return;
      co.iframe.style.setProperty('height', `${clamped}px`, 'important');
      if (co.modalWrapper) co.modalWrapper.style.setProperty('height', `${clamped}px`, 'important');
      if (co.modalContainer) co.modalContainer.style.setProperty('height', `${clamped}px`, 'important');
      if (co.positionModal && co.modalOpen) co.positionModal();
      return;
    }

    if (d.type === 'SURIIN_INLINE_CLOSE') {
      const id = d.inlineContextId;
      let co = id ? _inlineContextToCo.get(id) : null;
      if (!co && ev?.source) {
        for (const [, _co] of _containerOverlays) {
          if (_co?.iframe?.contentWindow && _co.iframe.contentWindow === ev.source) {
            co = _co;
            break;
          }
        }
        if (!co) {
          for (const [, _co] of _inlineContextToCo) {
            if (_co?.iframe?.contentWindow && _co.iframe.contentWindow === ev.source) {
              co = _co;
              break;
            }
          }
        }
      }
      if (co) {
        if (typeof co.closeModal === 'function') {
          co.closeModal();
        } else if (co.modalContainer) {
          co.modalContainer.style.setProperty('display', 'none', 'important');
        }
      } else if (typeof _activeSuriinInlineClose === 'function') {
        const close = _activeSuriinInlineClose;
        _activeSuriinInlineClose = null;
        try { close(); } catch { }
      }
      return;
    }

    if (d.type === 'SURIIN_INLINE_SUCCESS') {
      const id = d.inlineContextId;
      const successType = String(d.successType || '').trim();
      if (!successType) return;
      let co = null;
      if (ev?.source) {
        for (const [, _co] of _containerOverlays) {
          if (_co?.iframe?.contentWindow && _co.iframe.contentWindow === ev.source) {
            co = _co;
            break;
          }
        }
      }
      if (!co) co = _inlineContextToCo.get(id) || null;
      if (!co) {
        for (const [, _co] of _containerOverlays) {
          if (_co?.inlineContextId === id) { co = _co; break; }
        }
      }
      if (!co) return;
      if (co.reportedKey) {
        _inlineSuccessByReportedKey.set(co.reportedKey, successType);
        try {
          chrome.storage.local.get(_SURIIN_REPORTED_TEXTS_KEY, (stored) => {
            const existing = (stored && typeof stored[_SURIIN_REPORTED_TEXTS_KEY] === 'object')
              ? stored[_SURIIN_REPORTED_TEXTS_KEY]
              : {};
            existing[co.reportedKey] = successType;
            chrome.storage.local.set({ [_SURIIN_REPORTED_TEXTS_KEY]: existing });
          });
        } catch { }
        try { chrome.storage.local.remove([_SURIIN_REPORTED_CONTEXTS_KEY]); } catch { }
      }
      if (co) {
        co.inlineSuccessType = successType;
        _applyGreenShield(co);
      }
      // Apply green shield and post success message to ALL other overlays on this page
      for (const [, _allCo] of _containerOverlays) {
        if (_allCo === co) continue;
        _allCo.inlineSuccessType = successType;
        _applyGreenShield(_allCo);
        if (_allCo.iframe?.contentWindow) {
          _allCo.iframe.contentWindow.postMessage({ type: 'SURIIN_INLINE_SUCCESS_EXTERNAL', successType }, '*');
        }
      }
      for (const [, _allCo] of _inlineContextToCo) {
        if (_allCo === co) continue;
        _allCo.inlineSuccessType = successType;
        _applyGreenShield(_allCo);
        if (_allCo.iframe?.contentWindow) {
          _allCo.iframe.contentWindow.postMessage({ type: 'SURIIN_INLINE_SUCCESS_EXTERNAL', successType }, '*');
        }
      }
      // Swap matching bubble icons in _suriinBubbleUi
      for (const [bubbleEl, st] of _suriinBubbleUi.entries()) {
        const _rKey = _makeReportedKey(bubbleEl, st.bubbleText || '');
        if (_rKey === co.reportedKey) {
          if (st.icon) {
            _applyGreenShield({ iconHost: st.icon });
          }
        }
      }
    }
  }, true);
}

/** Flag to prevent duplicate style injections */
let _suriinStylesInjected = false;

/**
 * Returns the best semantic container ancestor for a given TextNode.
 * Priority: row > gridcell > listitem > aria-label Comment > dir=auto > article > body
 * @param {Text} textNode
 * @returns {HTMLElement}
 */
function _getContainerElement(textNode) {
  const el = textNode.parentElement;
  if (!el) return document.body;
  // Prefer tight semantic containers; prefer [dir="auto"] over broad dialog/article
  // so post-detail icons anchor beside the actual text rather than the whole dialog edge.
  return (
    el.closest('[role="row"]') ??
    el.closest('[role="gridcell"]') ??
    el.closest('[role="listitem"]') ??
    el.closest('[aria-label="Comment"]') ??
    el.closest('[dir="auto"]') ??
    el.closest('[data-pagelet]') ??
    el.closest('[role="article"]') ??
    document.body
  );
}

/**
 * NON-INVASIVE OVERLAY APPROACH:
 * Instead of modifying the host page's DOM (which React/Vue SPAs destroy on re-render),
 * we create absolutely-positioned overlays anchored to document.body that float
 * on top of the flagged text. This survives React re-renders.
 *
 * Uses a container-keyed map (_containerOverlays) so there is exactly ONE icon
 * per semantic container (message bubble / post / comment), with independent
 * underline highlights for every flagged word inside it.
 *
 * @param {string} targetText - The text to find and highlight
 * @param {Object} scanResult - { score, status, breakdown }
 */
function highlightAndInjectUI(targetText, scanResult) {
  if (!targetText || targetText.length < 5) return;
  const restrictFacebookChatbox = _shouldRestrictToFacebookChatbox();

  // Use triggerWords from the scan result when available (context-buffer detections).
  // Fall back to PLACEHOLDER_KEYWORDS for legacy single-message detections.
  // Sort longest-first so a longer token (e.g. 'test-scam') is matched and
  // highlighted before a shorter substring ('test') can claim the same node.
  const rawKeywords = [...((scanResult?.triggerWords?.length > 0)
    ? scanResult.triggerWords
    : PLACEHOLDER_KEYWORDS)].sort((a, b) => b.length - a.length);

  // ── Contextual fragmentation: if a compound keyword (e.g. 'test-scam') is
  // NOT present in the current message (targetText) but WAS detected in the
  // actor-isolated context buffer, expand it to its component parts so we
  // can still highlight what IS in this message.
  // E.g. buffer = "test" + "scam" → keyword = "test-scam" → targetText = "scam"
  // → highlight "scam" in the current message.
  const keywords = [];
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const kw of rawKeywords) {
    const _esc = escapeRegExp(kw);
    const _testRe = new RegExp('(^|[^a-zA-Z0-9])(' + _esc + ')(?=[^a-zA-Z0-9]|$)', 'i');
    if (_testRe.test(targetText)) {
      // Full keyword present — use it directly.
      keywords.push(kw);
    } else if (kw.includes('-')) {
      // Compound/hyphenated keyword NOT in this message — split on hyphens and
      // add only the parts that appear in the current message (actor-isolated context
      // means one part was in a prior message by the same actor).
      for (const part of kw.split('-')) {
        if (part.length < 3) continue; // skip trivially short fragments
        const _partEsc = escapeRegExp(part);
        const _partRe = new RegExp('(^|[^a-zA-Z0-9])(' + _partEsc + ')(?=[^a-zA-Z0-9]|$)', 'i');
        if (_partRe.test(targetText)) keywords.push(part);
      }
    }
    // If neither the full keyword nor any part appears, this keyword is skipped
    // (it belonged to a previous message in the buffer — don't highlight here).
  }

  if (keywords.length === 0) return;

  // ── Iterate each keyword independently (longest first) ───────────────────
  for (const keyword of keywords) {
    const _esc = escapeRegExp(keyword);
    // Always create a FRESH RegExp — 'g' flag makes RegExp stateful via lastIndex.
    const _makeMatchRe = () => new RegExp('(^|[^a-zA-Z0-9])(' + _esc + ')(?=[^a-zA-Z0-9]|$)', 'gi');

    // ── Path A: single-node matches ──────────────────────────────────────────
    const matchingNodes = findAllTextNodesContaining(keyword, _makeMatchRe());

    let created = 0;
    for (const textNode of matchingNodes) {
      if (_highlightedTextNodes.has(textNode)) continue;
      // CRITICAL FIX: Check data-suriin-checked attribute to prevent duplicates across re-renders
      if (textNode.parentElement && textNode.parentElement.hasAttribute('data-suriin-checked')) continue;
      if (isInsideEditableContext(textNode)) continue;
      if (restrictFacebookChatbox && !_isInsideActiveFacebookChatbox(textNode.parentElement)) continue;
      // Walk up ancestors to check if text node is inside a chat surface
      let _inChat = _isChatSurface(textNode.parentElement);
      if (!_inChat) {
        let _anc = textNode.parentElement?.parentElement;
        for (let _d = 0; _d < 8 && _anc && _anc !== document.body; _d++, _anc = _anc.parentElement) {
          if (_isChatSurface(_anc)) { _inChat = true; break; }
        }
      }
      if (!_inChat) continue;
      console.log('[SuriinAI] Injecting highlight for:', keyword, '|', textNode.textContent.substring(0, 40));
      _createOverlayForNode(textNode, keyword, targetText, scanResult);
      created++;
    }

    // ── Path B: cross-node fallback (React split text across spans) ──────────
    // Only attempt if Path A found nothing — avoids duplicate overlays.
    if (created === 0) {
      const rangeMatches = findTextRangeAcrossNodes(keyword);
      for (const { range, anchorNode } of rangeMatches) {
        if (_highlightedTextNodes.has(anchorNode)) continue;
        // CRITICAL FIX: Check data-suriin-checked attribute to prevent duplicates across re-renders
        if (anchorNode.parentElement && anchorNode.parentElement.hasAttribute('data-suriin-checked')) continue;
        if (isInsideEditableContext(anchorNode)) continue;
        if (restrictFacebookChatbox && !_isInsideActiveFacebookChatbox(anchorNode.parentElement)) continue;
        // Walk up ancestors to check if text node is inside a chat surface
        let _inChat = _isChatSurface(anchorNode.parentElement);
        if (!_inChat) {
          let _anc = anchorNode.parentElement?.parentElement;
          for (let _d = 0; _d < 8 && _anc && _anc !== document.body; _d++, _anc = _anc.parentElement) {
            if (_isChatSurface(_anc)) { _inChat = true; break; }
          }
        }
        if (!_inChat) continue;
        _createOverlayForNode(anchorNode, keyword, targetText, scanResult, range);
      }
    }
  }
}

/**
 * Creates or updates the overlay set for a single text node.
 * Container-keyed: one icon per semantic container, one underline per flagged word.
 *
 * If the container already has an entry in _containerOverlays:
 *   - Skip if this searchStr is already tracked (highlight exists).
 *   - Otherwise add a new underline HighlightEntry to the existing ContainerOverlay.
 *
 * If the container is new:
 *   - Create iconHost + modalContainer (one per container).
 *   - Create the first HighlightEntry (underline for this word).
 *   - Register in _containerOverlays and start a single domRemovalObs on the container.
 *
 * @param {Text}   textNode      - Anchor TextNode
 * @param {string} searchStr     - Truncated search string (≤60 chars)
 * @param {string} targetText    - Full original flagged text (for modal)
 * @param {Object} scanResult    - { score, status, breakdown }
 * @param {Range}  [prebuiltRange] - Cross-node Range from findTextRangeAcrossNodes
 * @private
 */
function _createOverlayForNode(textNode, searchStr, targetText, scanResult, prebuiltRange) {
  // Resolve the semantic container this text lives inside
  const containerEl = _getContainerElement(textNode);
  if (_shouldRestrictToFacebookChatbox() && !_isInsideActiveFacebookChatbox(containerEl)) return;
  // Check if containerEl or any ancestor is a chat surface
  let _containerInChat = _isChatSurface(containerEl);
  if (!_containerInChat) {
    let _anc = containerEl.parentElement;
    for (let _d = 0; _d < 10 && _anc && _anc !== document.body; _d++, _anc = _anc.parentElement) {
      if (_isChatSurface(_anc)) { _containerInChat = true; break; }
    }
  }
  if (!_containerInChat) return;

  // For Facebook chatboxes, avoid creating a second overlay system on top of the
  // per-bubble UI from applyBubbleRiskUI. If this text lives inside a chat bubble
  // (identified by existing Suriin bubble markers or common bubble roles), skip
  // container overlays entirely and let the in-bubble icon/underline represent it.
  try {
    if (_isFacebookHost()) {
      const bubbleAncestor = containerEl.closest('[data-suriin-bubble-id], [data-suriin-bubble-key], [data-suriin-bubble-icon="1"], [role="message"], [role="row"], [role="listitem"], [data-testid*="message" i], [data-scope*="message" i]');
      if (bubbleAncestor) return;
    }
  } catch { }

  // Fix 1a: skip document.body — no selector matched, icon would float at page top
  if (containerEl === document.body) return;

  // Fix 1b: skip text inside the top banner, or left/top-edge navigation elements
  // (Messenger sidebar preview badges, notification panel previews) that duplicate
  // the real chatbox bubble.  We do NOT skip ALL [role="navigation"] because
  // Facebook post-detail pages can wrap comment threads in a navigation ancestor.
  if (textNode.parentElement?.closest('[role="banner"]')) return;
  const _fix1bNavEl = textNode.parentElement?.closest('[role="navigation"]');
  if (_fix1bNavEl) {
    const _fix1bR = _fix1bNavEl.getBoundingClientRect();
    // Left edge nav (sidebar chat list) or top edge nav — skip.
    if (_fix1bR.right < window.innerWidth * 0.35 || _fix1bR.bottom < window.innerHeight * 0.15) return;
  }

  // ── Case A: Container already has an overlay — add highlight only ───────────
  if (_containerOverlays.has(containerEl)) {
    const co = _containerOverlays.get(containerEl);
    // Skip if this exact word is already tracked
    if (co.highlights.has(searchStr)) return;
    // Add a new underline for this additional flagged word
    const he = _createHighlightEntry(textNode, searchStr, scanResult, prebuiltRange);
    if (!he) return;
    co.highlights.set(searchStr, he);
    _highlightedTextNodes.add(textNode);
    // Register parent element for hover detection
    if (he.textNode.parentElement) {
      _textParentToIconHost.set(he.textNode.parentElement, co.iconHost);
      // CRITICAL FIX: Mark element with data-suriin-checked for persistent state across re-renders
      he.textNode.parentElement.setAttribute('data-suriin-checked', 'true');
    }
    return;
  }

  // Chatbox dedup: within the same non-modal chatbox dialog one overlay per keyword
  // is enough.  Reply-to previews inside a chat contain the same quoted text as the
  // Chatbox dedup: within the same dialog/chatbox allow only ONE overlay per
  // keyword to prevent reply-preview ghost icons.
  // Applies to:
  //   - non-modal dialogs (classic chatbox popup on facebook.com)
  //   - modal dialogs that are SMALL (< 15% viewport) — e.g. the FB Messenger
  //     chatbox which may have aria-modal="true" but is not a full post modal.
  // Large modals (post detail, photo viewer) are excluded so multiple comments
  // inside them can each get their own overlay.
  const _chatboxDialog = containerEl.closest('[role="dialog"]');
  if (_chatboxDialog) {
    const _cdR = _chatboxDialog.getBoundingClientRect();
    const _cdArea = _cdR.width * _cdR.height;
    const _vpArea2 = window.innerWidth * window.innerHeight;
    const _isSmallDialog = _cdArea < _vpArea2 * 0.15;
    const _isNonModal = _chatboxDialog.getAttribute('aria-modal') !== 'true';
    if (_isSmallDialog || _isNonModal) {
      for (const [existingEl, existingCo] of _containerOverlays) {
        if (!existingCo.highlights.has(searchStr)) continue;
        if (_chatboxDialog.contains(existingEl)) return;
      }
    }
  }

  // Messenger-specific: skip containers that are inside a reply/quoted-message
  // preview wrapper — these duplicate the real bubble and produce ghost icons.
  const _messengerQuoteWrap = containerEl.closest(
    '[data-testid="message-reply-context"], [class*="replyPreview"], [aria-label*="replied"], [data-scope="reply"]'
  );
  if (_messengerQuoteWrap) return;

  // Fix 2: deduplicate — always prefer the TIGHTER (more specific) container.
  // "tighter" means the existing container is a descendant of the new one (or vice-versa).
  let _broadToReplace = null;
  for (const [existingEl, existingCo] of _containerOverlays) {
    if (!existingCo.highlights.has(searchStr)) continue;
    if (existingEl.contains(containerEl)) {
      // Existing is BROADER (ancestor of new tight container) — replace it.
      _broadToReplace = existingEl;
      break;
    }
    if (containerEl.contains(existingEl)) {
      // Existing is TIGHTER (descendant of new broad container) — skip new.
      return;
    }
  }
  if (_broadToReplace) _destroyContainerOverlay(_broadToReplace);

  // ── Case B: New container — build the full overlay set ──────────────────────
  const isCritical = scanResult.status === 'critical';
  _attachInlineMessageListener();
  const inlineContextId = _makeInlineContextId(containerEl, searchStr, targetText);
  const reportedKey = _makeReportedKey(containerEl, targetText);
  const inlineSuccessType = _inlineSuccessByReportedKey.get(reportedKey) || null;

  // Build initial highlight entry (underline for this word)
  const firstHighlight = _createHighlightEntry(textNode, searchStr, scanResult, prebuiltRange);
  if (!firstHighlight) return;

  // Mark text node before creating UI to prevent races
  _highlightedTextNodes.add(textNode);

  // Inject CSS once
  injectSuriinStyles();

  // ── Icon: anchored to container top-right, updated every RAF frame ───────────
  const cRect = containerEl.getBoundingClientRect();
  const iconHost = document.createElement('div');
  iconHost.setAttribute('data-suriin-overlay', 'icon');
  iconHost.setAttribute('data-suriin-id', searchStr.substring(0, 20));
  // Set icon SVG based on success/severity state
  const _iconColor = inlineSuccessType ? '#22C55E' : (isCritical ? '#EF4444' : '#FBBF24');
  const _iconBorder = inlineSuccessType ? 'rgba(34,197,94,0.5)' : (isCritical ? 'rgba(239,68,68,0.5)' : 'rgba(251,191,36,0.5)');
  const _iconSvg = inlineSuccessType
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="${_iconColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>`
    : isCritical
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="${_iconColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="${_iconColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  iconHost.innerHTML = _iconSvg;
  iconHost.style.cssText = `
    position: fixed !important;
    top: ${cRect.top}px !important;
    left: ${cRect.right + _iconXOffset()}px !important;
    z-index: 2147483646 !important;
    cursor: pointer !important;
    pointer-events: none !important;
    width: 24px !important;
    height: 24px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    visibility: visible !important;
    opacity: 0 !important;
    border-radius: 50% !important;
    background: rgba(15, 14, 23, 0.92) !important;
    border: 1.5px solid ${_iconBorder} !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4), 0 0 12px ${_iconBorder} !important;
    transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease !important;
    user-select: none !important;
    -webkit-user-select: none !important;
    box-sizing: border-box !important;
    padding: 0 !important;
    margin: 0 !important;
    animation: none !important;
    float: none !important;
    transform: none !important;
    overflow: hidden !important;
    min-width: 24px !important;
    min-height: 24px !important;
    max-width: 24px !important;
    max-height: 24px !important;
  `;
  document.body.appendChild(iconHost);

  // ── Modal ────────────────────────────────────────────────────────────────────
  const modalContainer = document.createElement('div');
  modalContainer.setAttribute('data-suriin-overlay', 'modal');
  modalContainer.style.cssText = `
    position: fixed !important;
    top: 0px !important;
    left: 0px !important;
    z-index: 2147483647 !important;
    pointer-events: auto !important;
    display: none !important;
    width: 290px !important;
    visibility: visible !important;
    opacity: 0 !important;
    transition: opacity 0.18s ease !important;
  `;
  document.body.appendChild(modalContainer);

  // ── ContainerOverlay record ──────────────────────────────────────────────────
  const co = {
    iconHost,
    modalContainer,
    highlights: new Map([[searchStr, firstHighlight]]),
    scanResult,
    inlineContextId,
    reportedKey,
    inlineSuccessType,
    modalOpen: false,
    hasShownOnce: false,
    domRemovalObs: null,
    ensureModalLoaded: null,
    positionModal: null,
    closeModal: null,
    iframe: null,
    modalWrapper: null
  };

  // ── Modal content + event listeners ─────────────────────────────────────────
  const { modal, modalWrapper, closeBtn, ensureLoaded, iframe } = createSuriinPopupIframeModal(
    scanResult,
    targetText,
    () => {
      if (typeof co.closeModal === 'function') co.closeModal();
    }
  );
  co.iframe = iframe;
  co.modalWrapper = modalWrapper;
  co.ensureModalLoaded = () => ensureLoaded({ inlineContextId: co.inlineContextId, inlineSuccessType: co.inlineSuccessType });
  modalContainer.appendChild(modal);

  function closeModalSoft() {
    if (modalContainer.style.display === 'none') {
      co.modalOpen = false;
      co.hasShownOnce = false;
      return;
    }
    if (co._modalCloseToken) {
      co.modalOpen = false;
      co.hasShownOnce = false;
      return;
    }
    const token = Date.now();
    co._modalCloseToken = token;
    modalContainer.style.setProperty('opacity', '0', 'important');
    modalContainer.style.setProperty('pointer-events', 'none', 'important');
    co.modalOpen = false;
    co.hasShownOnce = false;
    if (_activeSuriinInlineClose === closeModalSoft) _activeSuriinInlineClose = null;
    setTimeout(() => {
      if (co._modalCloseToken !== token) return;
      modalContainer.style.setProperty('display', 'none', 'important');
      co._modalCloseToken = null;
    }, 210);
  }

  function openModalHard() {
    co.modalOpen = true;
    co._modalCloseToken = null;
    modalContainer.style.setProperty('display', 'block', 'important');
    modalContainer.style.setProperty('pointer-events', 'auto', 'important');
    modalContainer.style.setProperty('opacity', '0', 'important');
    // Reset iframe + wrapper height to a baseline; resize messages correct this quickly
    if (co.iframe) co.iframe.style.setProperty('height', '300px', 'important');
    if (co.modalWrapper) co.modalWrapper.style.setProperty('height', '300px', 'important');
  }

  co.closeModal = closeModalSoft;

  function positionModal(anchorRectOverride = null) {
    const padding = 12;
    const anchorRect = anchorRectOverride || co.lastAnchorRect || iconHost.getBoundingClientRect() || _getBestVisibleHighlightRect(co, 0);
    if (!anchorRect) {
      closeModalSoft();
      return;
    }

    modalContainer.style.setProperty('visibility', 'hidden', 'important');
    modalContainer.style.setProperty('display', 'block', 'important');
    modalContainer.style.setProperty('top', '0px', 'important');
    modalContainer.style.setProperty('left', '0px', 'important');

    const mRect = modal.getBoundingClientRect();
    const modalWidth = mRect.width || 290;
    // Use the live iframe height for vertical placement — the iframe is resized
    // by SURIIN_INLINE_RESIZE messages, so this always reflects actual content height.
    const iframeH = co.iframe ? (parseFloat(co.iframe.style.height) || 0) : 0;
    const modalHeight = iframeH > 80 ? iframeH : (mRect.height || 300);
    const chatRoot = containerEl.closest('[data-suriin-fb-chatbox-root="1"], [data-pagelet^="ChatTab"], [role="dialog"]');
    const chatRect = chatRoot?.getBoundingClientRect?.() || null;
    const sourceRect = (_getBestVisibleHighlightRect(co, 0) || containerEl.getBoundingClientRect());
    const overlapsSource = (c) => !(
      c.left + modalWidth < sourceRect.left ||
      c.left > sourceRect.right ||
      c.top + modalHeight < sourceRect.top ||
      c.top > sourceRect.bottom
    );
    const candidates = [
      { left: anchorRect.left - modalWidth - padding, top: anchorRect.top - 12 },
      { left: anchorRect.right + padding, top: anchorRect.top - 12 },
      { left: anchorRect.left - (modalWidth / 2) + (anchorRect.width / 2), top: anchorRect.top - modalHeight - padding },
      { left: anchorRect.left - (modalWidth / 2) + (anchorRect.width / 2), top: anchorRect.bottom + padding }
    ];
    if (chatRect && chatRect.width < modalWidth + 80) {
      candidates.unshift({ left: chatRect.left - modalWidth - padding, top: anchorRect.top - 12 });
    }
    const picked = candidates.find((c) => (
      c.left >= padding &&
      c.top >= padding &&
      c.left + modalWidth + padding <= window.innerWidth &&
      c.top + modalHeight + padding <= window.innerHeight &&
      !overlapsSource(c)
    )) || candidates[0];

    const top = Math.max(padding, Math.min(picked.top, window.innerHeight - modalHeight - padding));
    const left = Math.max(padding, Math.min(picked.left, window.innerWidth - modalWidth - padding));

    modalContainer.style.setProperty('top', `${top}px`, 'important');
    modalContainer.style.setProperty('left', `${left}px`, 'important');
    modalContainer.style.setProperty('display', 'block', 'important');
    modalContainer.style.setProperty('visibility', 'visible', 'important');
    modalContainer.style.setProperty('pointer-events', 'auto', 'important');
    requestAnimationFrame(() => {
      if (!co.modalOpen) return;
      modalContainer.style.setProperty('opacity', '1', 'important');
    });
  }

  co.positionModal = positionModal;

  const repositionIfOpen = () => { if (co.modalOpen) positionModal(); };
  window.addEventListener('resize', repositionIfOpen, true);

  iconHost.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    co.lastAnchorRect = iconHost.getBoundingClientRect();
    for (const [, otherCo] of _containerOverlays) {
      if (!otherCo || otherCo === co) continue;
      if (typeof otherCo.closeModal === 'function') otherCo.closeModal();
      else if (otherCo.modalContainer && otherCo.modalContainer !== modalContainer) {
        otherCo.modalContainer.style.setProperty('display', 'none', 'important');
        otherCo.modalOpen = false;
        otherCo.hasShownOnce = false;
      }
    }
    const isOpen = modalContainer.style.display !== 'none';
    if (isOpen) {
      closeModalSoft();
    } else {
      _attachInlineOutsideCloseListener();
      if (typeof _activeSuriinInlineClose === 'function' && _activeSuriinInlineClose !== closeModalSoft) {
        _activeSuriinInlineClose();
      }
      openModalHard();
      _activeSuriinInlineClose = closeModalSoft;
      if (typeof co.ensureModalLoaded === 'function') {
        co.ensureModalLoaded();
      }
      // Send SURIIN_INLINE_OPEN before positionModal so popup.js has maximum
      // time to switch to the correct view (success or scan result) before
      // the modal becomes visible and a resize measurement is taken
      if (co.iframe?.contentWindow) {
        co.iframe.contentWindow.postMessage({
          type: 'SURIIN_INLINE_OPEN',
          inlineContextId: co.inlineContextId,
          inlineSuccessType: co.inlineSuccessType || null
        }, '*');
      }
      positionModal(co.lastAnchorRect);
      // Re-position after the iframe view switches + measures its final height.
      // This avoids initial placement using the baseline 300px height.
      setTimeout(() => {
        if (!co.modalOpen) return;
        positionModal(co.lastAnchorRect);
      }, 120);
    }
  }, true);


  if (closeBtn) {
    const closeClickHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      console.log('[SuriinAI] Close button clicked');
      closeModalSoft();
    };
    closeBtn.addEventListener('click', closeClickHandler, true);
    closeBtn.addEventListener('click', closeClickHandler, false);
  }

  modalContainer.addEventListener('click', (e) => {
    if (e.target === modalContainer || !modal.contains(e.target)) {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, false);

  document.addEventListener('mousedown', (e) => {
    if (iconHost.contains(e.target) || e.target === iconHost) return;
    if (modalContainer.contains(e.target) || e.target === modalContainer) return;
    if (modalContainer.style.display !== 'none') {
      closeModalSoft();
      // After modal closes, revalidate all overlay positions so icons hidden by
      // the occlusion check (modal was covering them) are restored on next idle.
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(_revalidateAllOverlays, { timeout: 300 });
      } else {
        setTimeout(_revalidateAllOverlays, 100);
      }
    }
  });

  // ── Register parent→icon mapping for hover detection ───────────────────────
  if (firstHighlight.textNode.parentElement) {
    _textParentToIconHost.set(firstHighlight.textNode.parentElement, iconHost);
  }

  // ── Register and start render loop ───────────────────────────────────────────
  _containerOverlays.set(containerEl, co);
  _inlineContextToCo.set(inlineContextId, co);
  containerEl.setAttribute('data-suriin-icon', 'true');

  _attachGlobalHoverListeners();
  _startRenderLoop();
}

/**
 * Creates a HighlightEntry (underline overlay + range) for a single text node.
 * Returns null if the range has zero dimensions (node not yet rendered).
 * @param {Text}    textNode
 * @param {string}  searchStr
 * @param {Object}  scanResult
 * @param {Range}   [prebuiltRange]
 * @returns {{ highlightOverlay, textNode, searchStr, range }|null}
 */
function _createHighlightEntry(textNode, searchStr, scanResult, prebuiltRange) {
  // isMultiNode = true when the keyword spans multiple adjacent TextNodes (React-split
  // text like "test" + "-" + "scam"). We store this so the RAF rebuild knows to call
  // findTextRangeAcrossNodes() instead of a single-node indexOf.
  const isMultiNode = !!prebuiltRange;

  let range;
  if (prebuiltRange) {
    range = prebuiltRange;
  } else {
    range = document.createRange();
    range.selectNodeContents(textNode);
    const fullText = textNode.textContent;
    // Case-insensitive index lookup so 'test-scam', 'Test-scam', 'TEST-SCAM' all match.
    const matchIndex = fullText.toLowerCase().indexOf(searchStr.toLowerCase());
    if (matchIndex >= 0) {
      range.setStart(textNode, matchIndex);
      range.setEnd(textNode, Math.min(matchIndex + searchStr.length, fullText.length));
    }
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const isCritical = scanResult.status === 'critical';
  const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
  const baseRects = rects.length ? rects : [rect];
  const highlightOverlays = baseRects.map((r) => {
    const el = document.createElement('div');
    el.setAttribute('data-suriin-overlay', 'highlight');
    el.style.cssText = `
      position: fixed !important;
      top: ${r.top}px !important;
      left: ${r.left}px !important;
      width: ${r.width}px !important;
      height: ${r.height}px !important;
      pointer-events: none !important;
      z-index: 2147483645 !important;
      border-bottom: 2px solid ${isCritical ? '#ff4d4f' : '#faad14'} !important;
      background-color: ${isCritical ? 'rgba(255, 77, 79, 0.08)' : 'rgba(250, 173, 20, 0.08)'} !important;
      border-radius: 2px !important;
      box-sizing: border-box !important;
      text-decoration: none !important;
      opacity: 1 !important;
      transition: opacity 0.18s ease !important;
    `;
    document.body.appendChild(el);
    return el;
  });
  const highlightOverlay = highlightOverlays[0];

  // For single-node matches, return range:null so it gets rebuilt from the live textNode
  // on each RAF frame (handles React re-renders that create a new TextNode object).
  // For multi-node matches, store the range directly — it spans multiple nodes so
  // indexOf on a single node would fail; we re-find via findTextRangeAcrossNodes instead.
  return { highlightOverlay, highlightOverlays, isCritical, textNode, searchStr, isMultiNode, range: isMultiNode ? range : null };
}

function _setHighlightVisible(he, visible) {
  const list = he.highlightOverlays && Array.isArray(he.highlightOverlays)
    ? he.highlightOverlays
    : (he.highlightOverlay ? [he.highlightOverlay] : []);
  if (list.length === 0) return;

  if (visible) {
    if (he._hlVisible) return;
    he._hlVisible = true;
    if (he._hlHideTimer) {
      clearTimeout(he._hlHideTimer);
      he._hlHideTimer = null;
    }
    list.forEach((el) => {
      el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('opacity', '0', 'important');
    });
    requestAnimationFrame(() => {
      if (!he._hlVisible) return;
      list.forEach((el) => el.style.setProperty('opacity', '1', 'important'));
    });
    return;
  }

  if (!he._hlVisible) return;
  he._hlVisible = false;
  list.forEach((el) => el.style.setProperty('opacity', '0', 'important'));
  if (he._hlHideTimer) return;
  he._hlHideTimer = setTimeout(() => {
    if (he._hlVisible) return;
    list.forEach((el) => el.style.setProperty('display', 'none', 'important'));
    he._hlHideTimer = null;
  }, 190);
}

function _syncHighlightOverlaysToRects(he, rects) {
  const want = rects.length;
  if (!he.highlightOverlays || !Array.isArray(he.highlightOverlays)) {
    he.highlightOverlays = he.highlightOverlay ? [he.highlightOverlay] : [];
  }
  const list = he.highlightOverlays;
  while (list.length > want) {
    const el = list.pop();
    if (el && el !== he.highlightOverlay) el.remove();
  }
  while (list.length < want) {
    const el = document.createElement('div');
    el.setAttribute('data-suriin-overlay', 'highlight');
    el.style.cssText = `
      position: fixed !important;
      top: 0px !important;
      left: 0px !important;
      width: 0px !important;
      height: 0px !important;
      pointer-events: none !important;
      z-index: 2147483645 !important;
      border-bottom: 2px solid ${he.isCritical ? '#ff4d4f' : '#faad14'} !important;
      background-color: ${he.isCritical ? 'rgba(255, 77, 79, 0.08)' : 'rgba(250, 173, 20, 0.08)'} !important;
      border-radius: 2px !important;
      box-sizing: border-box !important;
      text-decoration: none !important;
      opacity: 1 !important;
      transition: opacity 0.18s ease !important;
    `;
    document.body.appendChild(el);
    list.push(el);
  }
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const el = list[i];
    el.style.setProperty('top', `${r.top}px`, 'important');
    el.style.setProperty('left', `${r.left}px`, 'important');
    el.style.setProperty('width', `${r.width}px`, 'important');
    el.style.setProperty('height', `${r.height}px`, 'important');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  GLOBAL RAF RENDER LOOP
//  One loop for ALL active overlays — no per-overlay scroll listeners.
// ══════════════════════════════════════════════════════════════════════════════

let _renderLoopRunning = false;

/**
 * Returns the bounding rect of the nearest overflow-clipping ancestor of `el`,
 * or null if no such ancestor exists before document.body.
 * Used to hide overlays that are inside a scrollable container but have scrolled
 * outside its visible clip area (chat message lists, modal scroll areas).
 * @param {Element} el
 * @returns {DOMRect|null}
 */
function _getClipAncestorRect(el) {
  let cur = el?.parentElement;
  while (cur && cur !== document.body) {
    const st = window.getComputedStyle(cur);
    if (/scroll|auto/.test(st.overflow + st.overflowX + st.overflowY)) {
      const r = cur.getBoundingClientRect();
      // Skip page-level scroll containers that span most of the viewport:
      // position:fixed overlays are not clipped by them in the browser, and
      // using their rect as a clip boundary produces false-positive hide events.
      // BUT: if this is a small-to-medium scroll container (chat thread pane,
      // modal body) keep it — these ARE real clip boundaries.
      const _isFullPage = r.width > window.innerWidth * 0.85 && r.height > window.innerHeight * 0.85;
      if (_isFullPage) {
        cur = cur.parentElement;
        continue;
      }
      return r;
    }
    cur = cur.parentElement;
  }
  // Fallback for Messenger full-page thread: find any scrollable ancestor even
  // if it spans the full viewport, so we have a real vertical clip boundary.
  cur = el?.parentElement;
  while (cur && cur !== document.body) {
    const st = window.getComputedStyle(cur);
    if (/scroll|auto/.test(st.overflow + st.overflowX + st.overflowY)) {
      return cur.getBoundingClientRect();
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Returns the first highlight Range rect that is non-zero and within the viewport.
 * Used to anchor the icon beside the matched word rather than the container edge.
 * Falls back to null — caller uses container rect in that case.
 * @param {ContainerOverlay} co
 * @returns {DOMRect|null}
 */

function _getBestVisibleHighlightRect(co, minTop = 0) {
  let _best = null;
  for (const he of co.highlights.values()) {
    if (!he.textNode?.isConnected) continue;
    try {
      if (!he.range) {
        // Multi-node match (e.g. React-split "test"+"-"+"scam"): re-find across nodes.
        // Pass ignoreHighlighted=true so already-tracked anchor nodes are not skipped.
        if (he.isMultiNode) {
          const crossMatches = findTextRangeAcrossNodes(he.searchStr, true);
          if (crossMatches.length > 0) {
            he.range = crossMatches[0].range;
          } else {
            // Nodes gone — fall back to whole textNode contents
            he.range = document.createRange();
            he.range.selectNodeContents(he.textNode);
          }
        } else {
          he.range = document.createRange();
          const fullText = he.textNode.textContent;
          const idx = fullText.toLowerCase().indexOf(he.searchStr.toLowerCase());
          if (idx >= 0) {
            he.range.setStart(he.textNode, idx);
            he.range.setEnd(he.textNode, Math.min(idx + he.searchStr.length, fullText.length));
          } else {
            he.range.selectNodeContents(he.textNode);
          }
        }
      }
      const r = he.range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 &&
          r.top >= minTop && r.top < window.innerHeight &&
          r.right > 0 && r.left < window.innerWidth) {
        if (!_best || r.height > _best.height) _best = r;
      }
    } catch { he.range = null; }
  }
  return _best;
}

/**
 * Force-repositions all active ContainerOverlay icons to their containers'
 * current getBoundingClientRect() and resets highlight ranges so they rebuild
 * on the next frame. Called after header mutations (notification banners) or
 * modal close to correct layout-shift misalignment and restore hidden icons.
 */
function _revalidateAllOverlays() {
  for (const [containerEl, co] of _containerOverlays) {
    if (!containerEl.isConnected) continue;
    const cRect = containerEl.getBoundingClientRect();
    const inVP = (
      cRect.bottom > 0 && cRect.top < window.innerHeight &&
      cRect.right > 0 && cRect.left < window.innerWidth
    );
    if (!inVP) continue;
    // Always anchor to the semantic containerEl right edge — it IS the comment/row boundary.
    co.iconHost.style.setProperty('top', `${cRect.top}px`, 'important');
    co.iconHost.style.setProperty('left', `${cRect.right + 8}px`, 'important');
    co.iconHost.style.setProperty('display', 'flex', 'important');
    // Only null single-node ranges — isMultiNode ranges are live DOM Ranges that
    // automatically track their text nodes; nulling them forces a rebuild via
    // findTextRangeAcrossNodes which skips _highlightedTextNodes and returns empty.
    for (const he of co.highlights.values()) {
      if (!he.isMultiNode) he.range = null;
    }
  }
}

/** Starts the global render loop if not already running */
function _startRenderLoop() {
  if (_renderLoopRunning) return;
  _renderLoopRunning = true;
  _renderFrame();
}

// ── Fast scroll sync ──────────────────────────────────────────────────────────
// position:fixed overlays repositioned only in RAF have a ~1 frame lag on
// fast/compositor-threaded scrolling.  This listener fires BEFORE the browser
// paints the scrolled frame and shifts every visible overlay by the exact
// scroll delta — zero layout reads, zero reflows.  RAF then corrects any drift
// caused by approximation (e.g. inside a scrollable sub-container).
let _fsLastY = window.scrollY;
let _fsLastX = window.scrollX;
let _fsHoldUntil = 0;

function _fastScrollSync(e) {
  _closeActiveSuriinInlineModal();
  // Only apply delta correction for window-level scroll.
  // Internal container scrolls (e.g. Messenger chat list) don't change
  // window.scrollY, so dy would be 0 and we'd misplace overlays.
  // The RAF loop handles those via getBoundingClientRect() accurately.
  const t = e.target;
  if (t !== document && t !== document.documentElement && t !== document.body) return;

  const dy = window.scrollY - _fsLastY;
  const dx = window.scrollX - _fsLastX;
  _fsLastY = window.scrollY;
  _fsLastX = window.scrollX;
  if (dy === 0 && dx === 0) return;

  _fsHoldUntil = performance.now() + 140;

  for (const [, co] of _containerOverlays) {
    // Icon
    const ih = co.iconHost;
    if (ih && ih.style.display !== 'none') {
      const t = (parseFloat(ih.style.getPropertyValue('top')) || 0) - dy;
      const l = (parseFloat(ih.style.getPropertyValue('left')) || 0) - dx;
      ih.style.setProperty('top', `${t}px`, 'important');
      ih.style.setProperty('left', `${l}px`, 'important');
    }

    const mc = co.modalContainer;
    if (mc && mc.style.display !== 'none') {
      const t = (parseFloat(mc.style.getPropertyValue('top')) || 0) - dy;
      const l = (parseFloat(mc.style.getPropertyValue('left')) || 0) - dx;
      mc.style.setProperty('top', `${t}px`, 'important');
      mc.style.setProperty('left', `${l}px`, 'important');
    }
    // Underline highlights
    for (const he of co.highlights.values()) {
      const list = he.highlightOverlays && Array.isArray(he.highlightOverlays)
        ? he.highlightOverlays
        : (he.highlightOverlay ? [he.highlightOverlay] : []);
      for (const ho of list) {
        if (!ho || ho.style.display === 'none') continue;
        const t = (parseFloat(ho.style.getPropertyValue('top')) || 0) - dy;
        const l = (parseFloat(ho.style.getPropertyValue('left')) || 0) - dx;
        ho.style.setProperty('top', `${t}px`, 'important');
        ho.style.setProperty('left', `${l}px`, 'important');
      }
    }
  }
}

// capture:true so we receive scroll events from ANY scrollable container,
// not just the window.  passive:true keeps scrolling smooth (no jank).
window.addEventListener('scroll', _fastScrollSync, { passive: true, capture: true });




/**
 * Returns the currently open Facebook/generic dialog, or null if none.
 * Used to suppress feed overlays while a post modal is open.
 * @returns {Element|null}
 */
function _getActiveDialog() {
  return document.querySelector('[role="dialog"]');
}

/**
 * Updates a single ContainerOverlay every RAF frame.
 *
 * For each container:
 *   A. Container gone from DOM → destroy immediately.
 *   A2. Dialog guard: hide feed overlays while a post modal is open.
 *   B. Container present:
 *      1. Reposition icon anchored to first visible highlight rect (or container).
 *      2. For each HighlightEntry: if textNode detached → destroy+instant re-find;
 *         else rebuild range if null and reposition underline.
 *      3. Hide/show icon + all highlights based on container viewport visibility.
 *
 * @param {HTMLElement}     containerEl
 * @param {ContainerOverlay} co
 */
function _updateContainerOverlay(containerEl, co) {
  const { iconHost, modalContainer } = co;

  if (_fsHoldUntil && performance.now() < _fsHoldUntil) {
    return;
  }

  // Navbar top-clip: hide overlays that bleed above the fixed top nav bar.
  const _bannerEl = document.querySelector('[role="banner"]');
  const _navBottom = _bannerEl ? Math.max(0, _bannerEl.getBoundingClientRect().bottom) : 0;

  // ── A. Container removed from DOM — destroy everything immediately ──────────
  if (!containerEl.isConnected || !document.body.contains(containerEl)) {
    _destroyContainerOverlay(containerEl);
    return;
  }

  // ── A2. Dialog guard — Facebook-only; not applied on Messenger ─────────────
  // Uses `contains` semantics so only containers INSIDE an open dialog are shown.
  // Handles nested dialogs (reply modal inside post modal) via querySelectorAll.
  // Also clips overlays that are inside a dialog but scrolled out of its rect.
  const _hostname = window.location.hostname;
  const _isFacebook = _hostname === 'www.facebook.com' || _hostname === 'facebook.com';
  if (_isFacebook) {
    // Only count "proper" modals: require aria-modal="true" (post/photo/video
    // modals) AND cover > 10% of the viewport. Notification panels, friend-request
    // dropdowns, and emoji pickers are excluded by the aria-modal requirement.
    const _vpArea = window.innerWidth * window.innerHeight;
    const _dialogs = Array.from(
      document.querySelectorAll('[role="dialog"][aria-modal="true"]')
    ).filter(d => {
      const r = d.getBoundingClientRect();
      return r.width * r.height > _vpArea * 0.10;
    });
    if (_dialogs.length > 0) {
      const _hostDialog = _dialogs.find(d => d.contains(containerEl));
      if (!_hostDialog) {
          // Before hiding, check if the container is inside ANY [role="dialog"]
          // (e.g. a Messenger chatbox popup or a small reply dialog).
          // Those must NOT be suppressed by the post-modal guard — only truly
          // "feed items behind the backdrop" should be hidden.
          const _containerInAnyDialog = containerEl.closest('[role="dialog"]');
          if (!_containerInAnyDialog) {
            // Feed item behind the backdrop — hide it.
            iconHost.style.setProperty('display', 'none', 'important');
            for (const he of co.highlights.values()) {
              _setHighlightVisible(he, false);
            }
            return;
          }
          // Container is in a small/non-primary dialog (chatbox etc.) — fall through
          // so Messenger chatbox overlays remain visible.
        }
      // Fix 4: stacked-modal check — e.g. Share modal opened on top of Post modal.
      // If another large modal exists that is NOT the host dialog and does NOT
      // contain this container, the content is behind the stacked modal — hide it.
      const _stackedModal = _dialogs.find(
        d => d !== _hostDialog && !d.contains(containerEl) && !_hostDialog.contains(d)
      );
      if (_stackedModal) {
        iconHost.style.setProperty('display', 'none', 'important');
        for (const he of co.highlights.values()) {
          _setHighlightVisible(he, false);
        }
        return;
      }
      // Container is inside a dialog — hide if scrolled outside the dialog's clip.
      const _dRect = _hostDialog.getBoundingClientRect();
      const _cRect2 = containerEl.getBoundingClientRect();
      const _inDialog = (
        _cRect2.right > _dRect.left &&
        _cRect2.left < _dRect.right &&
        _cRect2.bottom > _dRect.top &&
        _cRect2.top < _dRect.bottom
      );
      if (!_inDialog) {
        iconHost.style.setProperty('display', 'none', 'important');
        for (const he of co.highlights.values()) {
          _setHighlightVisible(he, false);
        }
        return;
      }
    }

    // ── Geometry-first occlusion check (catches ALL large overlays) ────────────
    // Using document.elementsFromPoint at the container's centre is the only
    // reliable way to detect the FB Menu dropdown (and similar portals) because
    // Facebook renders them as plain divs with no semantic role.
    //
    // Throttled to every 6 RAF frames (~100 ms at 60 fps) to limit CPU cost.
    // The result is cached in co._occluded between checks.
    const _cRectForPanel = containerEl.getBoundingClientRect();
    co._occlusionTick = ((co._occlusionTick || 0) + 1);
    if (co._occlusionTick >= 6) {
      co._occlusionTick = 0;
      const _cx = (_cRectForPanel.left + _cRectForPanel.right) / 2;
      const _cy = (_cRectForPanel.top + _cRectForPanel.bottom) / 2;
      co._occluded = false; // reset before re-test
      if (_cx >= 0 && _cx <= window.innerWidth &&
        _cy >= 0 && _cy <= window.innerHeight) {
        // elementsFromPoint returns elements from topmost (highest z-index) downwards.
        // Walk the stack: if we encounter a large non-suriin element BEFORE we
        // reach the containerEl, something is covering the feed item → occluded.
        const _stack = document.elementsFromPoint(_cx, _cy);
        for (const sEl of _stack) {
          // Stop when we reach the container itself (nothing is blocking it).
          if (sEl === containerEl || containerEl.contains(sEl)) break;
          // Skip our own overlay elements.
          if (sEl.hasAttribute('data-suriin-overlay') ||
            sEl.hasAttribute('data-suriin-icon') ||
            sEl.closest('[data-suriin-overlay]')) continue;
          // If this non-suriin element is large (> 8 % of viewport area), treat
          // the container as occluded.
          const sR = sEl.getBoundingClientRect();
          if (sR.width * sR.height > _vpArea * 0.08) {
            co._occluded = true;
            break;
          }
        }
      }
    }
    if (co._occluded) {
      iconHost.style.setProperty('display', 'none', 'important');
      for (const he of co.highlights.values()) {
        _setHighlightVisible(he, false);
      }
      if (typeof co.closeModal === 'function') co.closeModal();
      return;
    }
  }

  const cRect = containerEl.getBoundingClientRect();

  // ── B1. Container in viewport? ───────────────────────────────────────────────
  const inViewport = (
    cRect.bottom > 0 &&
    cRect.top < window.innerHeight &&
    cRect.right > 0 &&
    cRect.left < window.innerWidth
  );

  // ── B2. Update each HighlightEntry ──────────────────────────────────────────
  for (const [searchStr, he] of co.highlights) {
    const list = he.highlightOverlays && Array.isArray(he.highlightOverlays)
      ? he.highlightOverlays
      : (he.highlightOverlay ? [he.highlightOverlay] : []);

    // If text node detached: destroy+instant re-find
    if (!he.textNode || !he.textNode.isConnected) {
      const newNode = findTextNodeContaining(searchStr);
      if (newNode && !isInsideEditableContext(newNode)) {
        he.textNode = newNode;
        he.range = null;
        _highlightedTextNodes.add(newNode);
      } else {
        // Truly gone — remove this highlight entry
        _setHighlightVisible(he, false);
        setTimeout(() => {
          list.forEach(el => el?.remove());
        }, 210);
        co.highlights.delete(searchStr);
        if (co.highlights.size === 0) {
          _destroyContainerOverlay(containerEl);
          return;
        }
        continue;
      }
    }

    if (!inViewport) {
      _setHighlightVisible(he, false);
      continue;
    }

    // Rebuild range if null.
    // Multi-node (React-split): pass ignoreHighlighted=true so the anchor node
    // (already in _highlightedTextNodes) is not skipped during the cross-node search.
    // Single-node: case-insensitive indexOf on the live textNode.
    try {
      if (!he.range) {
        if (he.isMultiNode) {
          const _crossMatches = findTextRangeAcrossNodes(searchStr, true);
          if (_crossMatches.length > 0) {
            he.range = _crossMatches[0].range;
          } else {
            he.range = document.createRange();
            he.range.selectNodeContents(he.textNode);
          }
        } else {
          he.range = document.createRange();
          const fullText = he.textNode.textContent;
          const idx = fullText.toLowerCase().indexOf(searchStr.toLowerCase());
          if (idx >= 0) {
            he.range.setStart(he.textNode, idx);
            he.range.setEnd(he.textNode, Math.min(idx + searchStr.length, fullText.length));
          } else {
            he.range.selectNodeContents(he.textNode);
          }
        }
      }

      const hRect = he.range.getBoundingClientRect();
      if (hRect.width === 0 && hRect.height === 0) {
        _setHighlightVisible(he, false);
        continue;
      }

      // Hide if the highlight is above the effective top floor (navbar or scroll-pane
      // header). Reuse the same _minTopForIcon logic from B3 would require computing it
      // outside the loop; instead inline a lightweight version here.
      {
        const _hClipEl = _getClipAncestorRect(he.textNode?.parentElement ?? containerEl);
        let _hFloor = _navBottom;
        if (_hClipEl) {
          const _hIsFullPage = _hClipEl.width > window.innerWidth * 0.85 && _hClipEl.height > window.innerHeight * 0.85;
          _hFloor = Math.max(_hFloor, _hIsFullPage ? _hClipEl.top + 56 : _hClipEl.top);
        }
        if (hRect.top < _hFloor) {
          _setHighlightVisible(he, false);
          continue;
        }
      }

      // Dialog-boundary clip for highlights: same header/footer-aware logic as icon.
      const _hDialogEl = (he.textNode?.parentElement ?? containerEl).closest('[role="dialog"]');
      if (_hDialogEl) {
        const _hdClip = _hDialogEl.getBoundingClientRect();
        const _hClipAncestor = _getClipAncestorRect(he.textNode?.parentElement ?? containerEl);
        const _hdHeaderH = _hClipAncestor ? 0 : 56;
        const _hdFooterH = _hClipAncestor ? 0 : 56;
        const _hMsgTop    = _hdClip.top    + _hdHeaderH;
        const _hMsgBottom = _hdClip.bottom - _hdFooterH;
        if (hRect.bottom <= _hMsgTop || hRect.top >= _hMsgBottom) {
          _setHighlightVisible(he, false);
          continue;
        }
      }

      // Hide if scrolled outside a clipping scroll ancestor (chat list, modal body)
      const _hClip = _getClipAncestorRect(he.textNode?.parentElement ?? containerEl);
      if (_hClip) {
        const _hInClip = (
          hRect.right > _hClip.left &&
          hRect.left < _hClip.right &&
          hRect.bottom > _hClip.top &&
          hRect.top < _hClip.bottom
        );
        if (!_hInClip) {
          _setHighlightVisible(he, false);
          continue;
        }
      }

      const segRects = Array.from(he.range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      if (segRects.length === 0) {
        _setHighlightVisible(he, false);
        continue;
      }
      _syncHighlightOverlaysToRects(he, segRects);
      _setHighlightVisible(he, true);
    } catch {
      he.range = null;
    }
  }

  // ── B3. Reposition icon to container top-right every frame ──────────────────
  if (!inViewport) {
    iconHost.style.setProperty('display', 'none', 'important');
    if (typeof co.closeModal === 'function') co.closeModal();
  } else {
    // Determine the effective top floor: max of navbar bottom and clip-ancestor top.
    // This ensures messages scrolled above either boundary are treated as off-screen.
    const _iClipForIcon = _getClipAncestorRect(containerEl);
    // When the clip ancestor spans most of the viewport (Messenger full-page thread),
    // the raw clip.top ≈ 0 — but the chat has a sticky header bar above the message
    // list. Use the bottom of the first [role="main"] header child, or fall back to
    // a 56px estimate, so icons behind the header are correctly hidden.
    let _clipTop = _iClipForIcon ? _iClipForIcon.top : 0;
    if (_iClipForIcon) {
      const _cr = _iClipForIcon;
      const _isFullPageClip = _cr.width > window.innerWidth * 0.85 && _cr.height > window.innerHeight * 0.85;
      if (_isFullPageClip) {
        // Try to find the sticky chat header bottom (Messenger: first child of [role="main"])
        const _mainEl = document.querySelector('[role="main"]');
        const _chatHeader = _mainEl?.querySelector('[role="banner"], [role="heading"], header, [data-testid="mwthreadlist-header"], [class*="header"]');
        if (_chatHeader) {
          _clipTop = Math.max(_clipTop, _chatHeader.getBoundingClientRect().bottom);
        } else {
          _clipTop = Math.max(_clipTop, _cr.top + 56);
        }
      }
    }
    const _minTopForIcon = Math.max(_navBottom, _clipTop);

    // Anchor icon to the best visible highlight rect (beside the matched word).
    // If no highlight is visible above the floor, the text is off-screen — hide.
    // We do NOT set display:flex before confirming a valid anchor to prevent
    // a one-frame ghost flash at the last known position.
    const _bestRect = _getBestVisibleHighlightRect(co, _minTopForIcon);
    if (!_bestRect) {
      iconHost.style.setProperty('display', 'none', 'important');
      if (typeof co.closeModal === 'function') co.closeModal();
      return;
    }
    const anchorRect = _bestRect;

    // All checks passed — now restore display (after confirming a valid anchor).
    iconHost.style.setProperty('display', 'flex', 'important');

    // ── Icon X position: always use the semantic containerEl right edge.
    // containerEl is already the tightest semantic wrapper (comment, row, article)
    // so this naturally places the icon outside the text block without any
    // block-ancestor walking or threshold arithmetic.
    const iconLeft = cRect.right + 8;
    const iconTop  = anchorRect.top - 8;

    // Clip-ancestor check: hide if text has scrolled out of its scroll container;
    // clamp left so the icon never floats past the container's right boundary.
    const _iClip = _iClipForIcon;
    if (_iClip) {
      const _anchorInClip = (
        anchorRect.right > _iClip.left &&
        anchorRect.left < _iClip.right &&
        anchorRect.bottom > _iClip.top &&
        anchorRect.top < _iClip.bottom
      );
      if (!_anchorInClip) {
        iconHost.style.setProperty('display', 'none', 'important');
        if (typeof co.closeModal === 'function') co.closeModal();
        return;
      }
    }

    // Dialog-boundary clip: if the container lives inside any dialog/chatbox popup,
    // hide the icon when the anchor text has scrolled above or below the dialog rect.
    // When no scroll-clip ancestor was found (_iClip is null), derive a tighter clip
    // from the dialog rect itself by subtracting an estimated header/footer height so
    // icons don't bleed into the chatbox title bar area.
    const _hostDialogEl = containerEl.closest('[role="dialog"]');
    if (_hostDialogEl) {
      const _dClip = _hostDialogEl.getBoundingClientRect();
      // Estimate chatbox header height (toolbar + name bar ≈ 56px) and
      // bottom bar (input area ≈ 56px) to derive the true message-area rect.
      const _dlgHeaderH = _iClip ? 0 : 56;
      const _dlgFooterH = _iClip ? 0 : 56;
      const _msgAreaTop    = _dClip.top    + _dlgHeaderH;
      const _msgAreaBottom = _dClip.bottom - _dlgFooterH;
      const _anchorInDialog = (
        anchorRect.bottom > _msgAreaTop &&
        anchorRect.top    < _msgAreaBottom
      );
      if (!_anchorInDialog) {
        iconHost.style.setProperty('display', 'none', 'important');
        if (typeof co.closeModal === 'function') co.closeModal();
        return;
      }
    }

    // Clamp: never let the icon float past the clip container's right edge,
    // or past the enclosing dialog's right edge (chatbox popup boundary).
    let _clampRight = Infinity;
    if (_iClip) _clampRight = Math.min(_clampRight, _iClip.right - 28);
    if (_hostDialogEl) {
      const _dR = _hostDialogEl.getBoundingClientRect();
      _clampRight = Math.min(_clampRight, _dR.right - 28);
    }
    const _effectiveLeft = _clampRight < Infinity
      ? Math.min(iconLeft, _clampRight)
      : iconLeft;

    iconHost.style.setProperty('top', `${iconTop}px`, 'important');
    iconHost.style.setProperty('left', `${_effectiveLeft}px`, 'important');
    co.hasShownOnce = true;

    if (co.modalOpen && typeof co.positionModal === 'function') {
      co.positionModal(anchorRect);
    }
  }
}

/**
 * Permanently removes a ContainerOverlay: cleans up all DOM elements and
 * removes the container from _containerOverlays.
 * @param {HTMLElement} containerEl
 */
function _destroyContainerOverlay(containerEl) {
  const co = _containerOverlays.get(containerEl);
  if (!co) return;
  _containerOverlays.delete(containerEl);
  if (co.inlineContextId) {
    _inlineContextToCo.delete(co.inlineContextId);
    // Clean up per-iframe storage key to avoid stale data
    try { chrome.storage.local.remove([`suriin_inline_payload_${co.inlineContextId}`]); } catch { }
  }
  co.domRemovalObs?.disconnect();
  co.iconHost?.remove();
  co.modalContainer?.remove();
  for (const he of co.highlights.values()) {
    if (he.highlightOverlays && Array.isArray(he.highlightOverlays)) {
      he.highlightOverlays.forEach(el => el?.remove());
    }
    he.highlightOverlay?.remove();
    // Unregister the textNode so a subsequent re-scan can re-highlight it.
    if (he.textNode) _highlightedTextNodes.delete(he.textNode);
  }
  containerEl.removeAttribute('data-suriin-icon');
}

/** Single RAF frame — updates every ContainerOverlay with crash protection */
function _renderFrame() {
  if (_containerOverlays.size === 0) {
    _renderLoopRunning = false;
    return;
  }

  for (const [containerEl, co] of _containerOverlays) {
    try {
      _updateContainerOverlay(containerEl, co);
    } catch (err) {
      console.warn('[SuriinAI] _updateContainerOverlay error (skipping):', err);
    }
  }

  requestAnimationFrame(_renderFrame);
}

/** Shows or hides icon + all highlights in a ContainerOverlay (never touches modal) */
function _setContainerVisible(co, visible) {
  if (visible) {
    co.iconHost?.style.setProperty('display', 'flex', 'important');
    for (const he of co.highlights.values()) {
      if (he.highlightOverlays && Array.isArray(he.highlightOverlays)) {
        he.highlightOverlays.forEach(el => el?.style.setProperty('display', 'block', 'important'));
      }
      he.highlightOverlay?.style.setProperty('display', 'block', 'important');
    }
  } else {
    co.iconHost?.style.setProperty('display', 'none', 'important');
    for (const he of co.highlights.values()) {
      if (he.highlightOverlays && Array.isArray(he.highlightOverlays)) {
        he.highlightOverlays.forEach(el => el?.style.setProperty('display', 'none', 'important'));
      }
      he.highlightOverlay?.style.setProperty('display', 'none', 'important');
    }
  }
}

/**
 * Walks the DOM to find a text node containing the search string.
 * Skips editable contexts, already-highlighted nodes, and our own injected elements.
 * @param {string} searchStr
 * @returns {Text|null}
 */
function findTextNodeContaining(searchStr) {
  if (!searchStr) return null;

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.includes(searchStr)) {
      return node;
    }
  }
  return null;
}

/**
 * Finds ALL text nodes in the document that contain the search string.
 * Skips nodes already in _highlightedTextNodes, editable contexts, and our own UI.
 * @param {string} searchStr
 * @returns {Text[]}
 */
function findAllTextNodesContaining(searchStr, wordBoundaryRe = null) {
  if (!searchStr) return [];

  const results = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    if (_highlightedTextNodes.has(node)) continue;
    // CRITICAL FIX: Skip if parent has data-suriin-checked attribute (persistent across re-renders)
    if (node.parentElement && node.parentElement.hasAttribute('data-suriin-checked')) continue;
    // Use case-insensitive matching in both paths so 'test-scam' matches 'Test-scam' etc.
    const matches = wordBoundaryRe
      ? wordBoundaryRe.test(node.textContent)
      : node.textContent.toLowerCase().includes(searchStr.toLowerCase());
    if (matches) results.push(node);
  }
  return results;
}

/**
 * Cross-node Range search — finds `searchStr` even when React splits it across
 * multiple adjacent TextNodes (e.g. "test" + "-" + "scam").
 *
 * Walks all TextNodes sequentially, maintaining a sliding window of concatenated
 * text. When the concatenation contains `searchStr`, builds a DOM Range spanning
 * the relevant nodes and returns it along with the anchor (first) TextNode.
 *
 * Returns an array of { range: Range, anchorNode: Text } for every non-
 * highlighted match found. Returns [] if nothing matches.
 *
 * @param {string} searchStr
 * @returns {{ range: Range, anchorNode: Text }[]}
 */
/**
 * @param {string}  searchStr
 * @param {boolean} [ignoreHighlighted=false] — when true, skips the
 *   _highlightedTextNodes guard so that already-tracked ranges can be
 *   rebuilt (e.g. after revalidation nulled them). Used by the RAF loop
 *   and _getBestVisibleHighlightRect when rebuilding isMultiNode ranges.
 * @returns {{ range: Range, anchorNode: Text }[]}
 */
function findTextRangeAcrossNodes(searchStr, ignoreHighlighted = false) {
  if (!searchStr) return [];

  // Case-insensitive search: compare lower-case copy of the searchStr.
  const searchLower = searchStr.toLowerCase();

  const results = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent) return NodeFilter.FILTER_REJECT;
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  // Collect all eligible text nodes first
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  // Sliding window over adjacent text nodes
  let winStart = 0;
  while (winStart < textNodes.length) {
    let concat = '';
    let winEnd = winStart;

    while (winEnd < textNodes.length) {
      concat += textNodes[winEnd].textContent;
      // Case-insensitive match
      const idx = concat.toLowerCase().indexOf(searchLower);

      if (idx >= 0) {
        let charsSoFar = 0;
        let startNode = null, startOffset = 0;
        let endNode = null, endOffset = 0;
        const endIdx = idx + searchStr.length;

        for (let i = winStart; i <= winEnd; i++) {
          const nodeLen = textNodes[i].textContent.length;
          const nodeStart = charsSoFar;
          const nodeEnd = charsSoFar + nodeLen;

          if (!startNode && nodeEnd > idx) {
            startNode = textNodes[i];
            startOffset = idx - nodeStart;
          }
          if (!endNode && nodeEnd >= endIdx) {
            endNode = textNodes[i];
            endOffset = endIdx - nodeStart;
          }

          charsSoFar += nodeLen;
          if (startNode && endNode) break;
        }

        // Guard: skip already-highlighted anchors UNLESS caller explicitly
        // bypasses this check (e.g. RAF loop rebuilding isMultiNode ranges).
        const _alreadyHighlighted = !ignoreHighlighted && _highlightedTextNodes.has(startNode);
        if (startNode && endNode && !_alreadyHighlighted) {
          try {
            const range = document.createRange();
            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset);
            results.push({ range, anchorNode: startNode });
          } catch { /* invalid range — skip */ }
        }

        winStart = winEnd + 1;
        break;
      }

      if (concat.length > searchStr.length * 3) {
        winStart++;
        break;
      }

      winEnd++;
    }

    if (winEnd >= textNodes.length) break;
  }

  return results;
}

function normalizeAutoScanResultForPopup(scanResult, targetText) {
  const overallRaw = String(scanResult?.overall_status || scanResult?.risk_status || scanResult?.status || '').trim();
  const overallUpper = overallRaw.toUpperCase();

  let status = String(scanResult?.status || '').trim().toLowerCase();
  if (!status) {
    if (overallUpper === 'CRITICAL') status = 'critical';
    else if (overallUpper === 'WARNING') status = 'warning';
    else if (overallUpper === 'SAFE') status = 'safe';
    else status = 'warning';
  }

  let scorePct = null;
  if (typeof scanResult?.overall_score === 'number') scorePct = scanResult.overall_score;
  else if (typeof scanResult?.score === 'number') scorePct = scanResult.score;
  if (!Number.isFinite(scorePct)) scorePct = null;
  if (scorePct === null) scorePct = status === 'critical' ? 100 : (status === 'warning' ? 75 : 0);
  scorePct = Math.max(0, Math.min(100, Math.round(scorePct)));
  const confidence = Math.max(0, Math.min(1, scorePct / 100));

  const watchlist = (scanResult?.watchlist && typeof scanResult.watchlist === 'object') ? scanResult.watchlist : null;
  const ai_scan = (scanResult?.ai_scan && typeof scanResult.ai_scan === 'object') ? scanResult.ai_scan : null;

  // Build a 2-key breakdown for any legacy UI pieces still expecting it.
  const breakdown = {
    message_tone: {
      is_flagged: String(ai_scan?.status || '').toUpperCase() === 'SUSPICIOUS',
      severity: String(ai_scan?.status || '').toUpperCase() === 'SUSPICIOUS' ? 'warning' : 'safe',
      display_text: ai_scan?.detail || (String(ai_scan?.status || '').toUpperCase() === 'SUSPICIOUS'
        ? 'Suspicious language patterns detected.'
        : 'No suspicious patterns detected.')
    },
    gov_records: {
      is_flagged: String(watchlist?.status || '').toUpperCase() === 'MATCHED',
      severity: String(watchlist?.status || '').toUpperCase() === 'MATCHED' ? 'critical' : 'safe',
      display_text: watchlist?.detail || (String(watchlist?.status || '').toUpperCase() === 'MATCHED'
        ? 'Matched an official SEC/DTI watchlist item.'
        : 'No watchlist match found.')
    }
  };

  const message = scanResult?.message || (status === 'critical'
    ? 'CRITICAL: Matched an official SEC/DTI watchlist item.'
    : (status === 'warning'
      ? 'WARNING: AI flagged this message as suspicious.'
      : 'SAFE: No watchlist match and AI found no suspicious patterns.'));

  // Deduplicate and gather all page flagged results in the active scan session
  const flaggedResults = [];
  try {
    for (const [bubbleEl, st] of _suriinBubbleUi.entries()) {
      if (st.scanResult && st.bubbleText) {
        const s = String(st.scanResult.status || st.scanResult.overall_status || '').toLowerCase();
        if (s === 'critical' || s === 'warning') {
          flaggedResults.push({
            bubbleId: bubbleEl.id || '',
            bubbleKey: '',
            text: st.bubbleText,
            status: s,
            score: st.scanResult.overall_score ?? st.scanResult.score ?? (s === 'critical' ? 100 : (s === 'warning' ? 75 : 0)),
            ai_scan: st.scanResult.ai_scan || null,
            watchlist: st.scanResult.watchlist || null,
            sec_watchlist_hits: st.scanResult.sec_watchlist_hits || []
          });
        }
      }
    }
  } catch (err) {
    console.error('Error gathering flagged results:', err);
  }

  return {
    text: targetText || '',
    url: window.location.href || '',
    confidence,
    score: scorePct,
    scorePct,
    status,
    overall_status: overallUpper || (status === 'critical' ? 'CRITICAL' : (status === 'warning' ? 'WARNING' : 'SAFE')),
    overall_score: scorePct,
    watchlist,
    ai_scan,
    sec_watchlist_hits: scanResult.sec_watchlist_hits || [],
    flaggedResults,
    breakdown,
    message
  };
}

function createSuriinPopupIframeModal(scanResult, targetText, onClose) {
  if (scanResult && typeof scanResult === 'object') {
    const level = scanResult.threat_level || scanResult.status || 'safe';
    scanResult.status = level.toLowerCase();
    scanResult.overall_status = level.toUpperCase();
  }
  const modal = document.createElement('div');
  modal.style.cssText = `
    width: 290px !important;
    height: 300px !important;
    border-radius: 18px !important;
    overflow: hidden !important;
    pointer-events: auto !important;
    background: transparent !important;
    position: relative !important;
    box-shadow: 0 16px 64px rgba(0,0,0,0.8), 0 0 0 1px rgba(108,99,255,0.15) !important;
  `;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    position: absolute !important;
    top: 8px !important;
    right: 8px !important;
    z-index: 2147483648 !important;
    cursor: pointer !important;
    width: 28px !important;
    height: 28px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 8px !important;
    font-size: 14px !important;
    color: #eeeef4 !important;
    background: rgba(15, 14, 23, 0.92) !important;
    border: 1px solid rgba(255,255,255,0.12) !important;
    padding: 0 !important;
  `;
  if (typeof onClose === 'function') {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    }, true);
  }

  const iframe = document.createElement('iframe');
  iframe.style.cssText = `
    width: 290px !important;
    height: 300px !important;
    border: 0 !important;
    display: block !important;
    border-radius: 18px !important;
    background: transparent !important;
  `;

  modal.appendChild(iframe);
  modal.appendChild(closeBtn);

  let loaded = false;
  const ensureLoaded = (opts = null) => {
    try {
      const payload = normalizeAutoScanResultForPopup(scanResult, targetText);
      if (opts && typeof opts === 'object') {
        if (opts.inlineContextId) payload.inlineContextId = opts.inlineContextId;
        if (opts.inlineSuccessType) payload.inlineSuccess = { type: opts.inlineSuccessType };
      }
      const ts = Date.now();
      const ctxId = opts?.inlineContextId || null;

      if (typeof chrome !== 'undefined' && chrome.storage?.local?.set && chrome.runtime?.getURL) {
        if (ctxId) {
          // Per-iframe isolated key — prevents success bleed across simultaneous modals
          const perIframeKey = `suriin_inline_payload_${ctxId}`;
          chrome.storage.local.set({ [perIframeKey]: payload }, () => {
            if (loaded) return;
            loaded = true;
            const popupUrl = chrome.runtime.getURL('popup.html');
            iframe.src = popupUrl + `?inline=1&ctx=${encodeURIComponent(ctxId)}&ts=${ts}`;
          });
        } else {
          chrome.storage.local.set(
            {
              suriin_auto_mode_action: 'autoscan_inline',
              suriin_auto_mode_scan_result: payload,
              suriin_auto_mode_timestamp: ts
            },
            () => {
              if (loaded) return;
              loaded = true;
              const popupUrl = chrome.runtime.getURL('popup.html');
              iframe.src = popupUrl + `?inline=1&ts=${ts}`;
            }
          );
        }
      } else {
        iframe.src = '';
      }
    } catch {
      iframe.src = '';
    }
  };

  return { modal, modalWrapper: modal, closeBtn, ensureLoaded, iframe };
}

// ══════════════════════════════════════════════════════════════════════════════
//  INLINE-STYLED POPUP MODAL — Two-View (Grammarly-style)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Builds a two-view self-contained popup modal.
 * VIEW 1 — scan results + checklist + CTA buttons
 * VIEW 2 — expert review escalation form (inline, no new window)
 * All state transitions and message passing are handled internally.
 *
 * @param {Object} scanResult  { score, status, breakdown }
 * @param {string} targetText  The original scanned text snippet
 * @param {Function} onClose   Called when the modal should close
 * @returns {{ modal: HTMLElement, closeBtn: HTMLElement }}
 */
function createSuriinInlineModal(scanResult, targetText, onClose) {
  const { score, status, breakdown, watchlist } = scanResult;

  // Always treat SEC watchlist match as critical for UI
  const isSecCritical = (watchlist && typeof watchlist === 'object' && String(watchlist.status || '').toUpperCase() === 'MATCHED') || (breakdown && breakdown.gov_records && breakdown.gov_records.is_flagged);
  const severityEmoji = { danger: '🔴', warning: '🟡', safe: '🟢' };
  const statusLabel = { critical: 'CRITICAL RISK', uncertain: 'Review Needed', safe: 'Low Risk' };
  const isCritical = status === 'critical' || isSecCritical;
  const isActionable = isCritical || status === 'uncertain';

  // ── Shared helpers ─────────────────────────────────────────────────────────
  const S = (el, css) => { el.style.cssText = css; return el; };
  const mk = (tag, css = '') => S(document.createElement(tag), css);
  const imp = s => s.replace(/;/g, ' !important;');

  // ── Wrapper (outer shell — fixed width, height transitions) ───────────────
  const modal = mk('div', imp(`
    width: 300px;
    background: #13121f;
    border: 1px solid rgba(108,99,255,0.3);
    border-radius: 14px;
    box-shadow: 0 16px 64px rgba(0,0,0,0.8), 0 0 0 1px rgba(108,99,255,0.15);
    color: #eeeef4;
    font-size: 12px;
    font-family: 'Inter','Segoe UI',system-ui,-apple-system,sans-serif;
    overflow: hidden;
    pointer-events: auto;
    line-height: 1.5;
    box-sizing: border-box;
    text-align: left;
    transition: max-height 0.32s cubic-bezier(0.4,0,0.2,1);
    max-height: 500px;
  `));

  // ── Shared Header ──────────────────────────────────────────────────────────
  const header = mk('div', imp(`
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px 8px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    box-sizing: border-box; pointer-events: auto;
  `));

  const brand = mk('div', 'display:flex !important;align-items:center !important;gap:6px !important;');
  const shield = mk('span', 'display:flex !important;align-items:center !important;justify-content:center !important;width:16px !important;height:16px !important;');
  shield.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="url(#sg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><defs><linearGradient id="sg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6C63FF"/><stop offset="100%" stop-color="#3ECFCF"/></linearGradient></defs><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>';
  const titleSpan = mk('span', imp(`
    font-size: 12px; font-weight: 700;
    background: linear-gradient(135deg,#6C63FF,#3ECFCF);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  `));
  titleSpan.textContent = 'Security Scan Results:';
  brand.append(shield, titleSpan);

  const closeBtn = mk('button', imp(`
    cursor: pointer; width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 4px; font-size: 14px; color: #9898b2;
    background: transparent; border: none; padding: 0;
    pointer-events: auto; z-index: 2147483648;
    transition: all 0.15s ease; user-select: none;
  `));
  closeBtn.setAttribute('data-suriin-close', 'true');
  closeBtn.textContent = '✕';
  closeBtn.onmouseenter = () => {
    closeBtn.style.setProperty('background', 'rgba(255,255,255,0.1)', 'important');
    closeBtn.style.setProperty('color', '#eeeef4', 'important');
  };
  closeBtn.onmouseleave = () => {
    closeBtn.style.setProperty('background', 'transparent', 'important');
    closeBtn.style.setProperty('color', '#9898b2', 'important');
  };

  header.append(brand, closeBtn);
  modal.appendChild(header);

  // ══════════════════════════════════════════════════════════════════════════
  //  VIEW 1 — Scan Results
  // ══════════════════════════════════════════════════════════════════════════
  const view1 = mk('div', 'pointer-events:auto !important;');

  // Status bar
  const statusBar = mk('div', imp(`
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; font-weight: 600; font-size: 11.5px;
    background: ${isCritical ? 'rgba(239,68,68,0.1)' : 'rgba(251,191,36,0.1)'};
    color: ${isCritical ? '#EF4444' : '#FBBF24'};
    border-bottom: 1px solid ${isCritical ? 'rgba(239,68,68,0.15)' : 'rgba(251,191,36,0.15)'};
    box-sizing: border-box;
  `));
  const statusLbl = mk('span', 'font-weight:600 !important;');
  statusLbl.textContent = statusLabel[status] || status;
  const scoreSpan = mk('span', 'font-weight:700 !important;font-size:12px !important;');
  scoreSpan.textContent = `Score: ${score}%`;
  statusBar.append(statusLbl, scoreSpan);
  view1.appendChild(statusBar);

  // Checklist
  const checklist = mk('div', imp('padding:8px 12px;display:flex;flex-direction:column;gap:6px;pointer-events:auto;'));
  [
    { key: 'message_tone', label: 'AI Scam Result' },
    { key: 'gov_records', label: 'Official SEC / DTI Watchlist' }
  ].forEach(({ key, label }) => {
    const d = breakdown?.[key];
    if (!d) return;
    const row = mk('div', imp('display:flex;align-items:flex-start;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);border-radius:8px;box-sizing:border-box;'));
    const ico = mk('span', 'font-size:14px !important;flex-shrink:0 !important;margin-top:1px !important;');
    ico.textContent = severityEmoji[d.severity] || '⚪';
    const col = mk('div', 'display:flex !important;flex-direction:column !important;gap:1px !important;');
    const lbl = mk('span', 'font-size:11.5px !important;font-weight:600 !important;color:#eeeef4 !important;');
    lbl.textContent = label;
    const txt = mk('span', 'font-size:10.5px !important;color:#9898b2 !important;font-style:italic !important;');
    txt.textContent = d.display_text || d.text || '';
    col.append(lbl, txt);
    row.append(ico, col);
    checklist.appendChild(row);
  });
  view1.appendChild(checklist);

  // CTA button (only for uncertain status)
  if (isActionable) {
    const btnRow = mk('div', imp('padding:8px 12px;border-top:1px solid rgba(255,255,255,0.05);box-sizing:border-box;pointer-events:auto;display:flex;flex-direction:column;gap:6px;'));

    // Expert Review button (uncertain status)
    if (status === 'uncertain') {
      const expertBtn = mk('button', imp(`
        width:100%;padding:8px 10px;border:none;border-radius:8px;
        font-size:11px;font-weight:600;cursor:pointer;
        background:#6C63FF;color:#fff;text-align:center;
        box-sizing:border-box;pointer-events:auto;user-select:none;
        transition:background 0.15s ease;
      `));
      expertBtn.textContent = '💬 Request Expert Review';
      expertBtn.onmouseenter = () => expertBtn.style.setProperty('background', '#5a52d5', 'important');
      expertBtn.onmouseleave = () => expertBtn.style.setProperty('background', '#6C63FF', 'important');
      expertBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        showView(2);
      }, true);
      btnRow.appendChild(expertBtn);
    }

    // Report Evidence button (critical status)
    if (status === 'critical') {
      const reportBtn = mk('button', imp(`
        width:100%;padding:8px 10px;border:none;border-radius:8px;
        font-size:11px;font-weight:600;cursor:pointer;
        background:#EF4444;color:#fff;text-align:center;
        box-sizing:border-box;pointer-events:auto;user-select:none;
        transition:background 0.15s ease;
      `));
      reportBtn.textContent = '📋 Generate Report Evidence';
      reportBtn.onmouseenter = () => reportBtn.style.setProperty('background', '#DC2626', 'important');
      reportBtn.onmouseleave = () => reportBtn.style.setProperty('background', '#EF4444', 'important');
      reportBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        showView(2);
      }, true);
      btnRow.appendChild(reportBtn);
    }

    view1.appendChild(btnRow);
  }

  // View 1 footer
  const footer1 = mk('div', imp('padding:6px 12px;text-align:center;font-size:9.5px;color:#5a5a80;border-top:1px solid rgba(255,255,255,0.05);letter-spacing:0.02em;'));
  footer1.textContent = 'Suriin AI Scanner • Auto-Scan';
  view1.appendChild(footer1);
  modal.appendChild(view1);

  // ══════════════════════════════════════════════════════════════════════════
  //  VIEW 2 — Expert Review Escalation Form
  // ══════════════════════════════════════════════════════════════════════════
  const view2 = mk('div', 'display:none !important;pointer-events:auto !important;');

  // Form title
  const formTitle = mk('div', imp('padding:8px 12px 4px;font-size:11px;font-weight:700;color:#6C63FF;letter-spacing:0.04em;'));
  formTitle.textContent = 'REQUEST EXPERT REVIEW';
  view2.appendChild(formTitle);

  // Scanned text (read-only)
  const scannedLabel = mk('div', imp('padding:2px 12px 2px;font-size:10px;color:#9898b2;'));
  scannedLabel.textContent = 'Scanned text:';
  view2.appendChild(scannedLabel);

  const scannedBox = mk('div', imp(`
    margin: 0 12px 8px; padding: 6px 8px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 6px; font-size: 10.5px; color: #9898b2;
    line-height: 1.4; max-height: 48px; overflow: hidden;
    word-break: break-word; box-sizing: border-box;
  `));
  scannedBox.textContent = (targetText || '').substring(0, 120) + (targetText?.length > 120 ? '…' : '');
  view2.appendChild(scannedBox);

  // Context textarea
  const ctxLabel = mk('div', imp('padding:0 12px 2px;font-size:10px;color:#9898b2;'));
  ctxLabel.textContent = 'Additional context (optional):';
  view2.appendChild(ctxLabel);

  const textarea = mk('textarea', imp(`
    width: calc(100% - 24px); margin: 0 12px 8px;
    padding: 6px 8px; background: rgba(255,255,255,0.04);
    border: 1px solid rgba(108,99,255,0.3); border-radius: 6px;
    color: #eeeef4; font-size: 11px; line-height: 1.4;
    resize: vertical; min-height: 56px; max-height: 100px;
    box-sizing: border-box; outline: none;
    font-family: 'Inter','Segoe UI',system-ui,sans-serif;
    pointer-events: auto;
  `));
  textarea.placeholder = 'Describe why this looks suspicious…';
  view2.appendChild(textarea);

  // Privacy consent
  const consentRow = mk('div', imp('display:flex;align-items:flex-start;gap:8px;padding:0 12px 10px;pointer-events:auto;'));
  const checkbox = mk('input', imp('margin-top:2px;cursor:pointer;pointer-events:auto;accent-color:#6C63FF;flex-shrink:0;'));
  checkbox.type = 'checkbox';
  const consentLbl = mk('label', imp('font-size:10px;color:#9898b2;line-height:1.4;cursor:pointer;pointer-events:auto;'));
  consentLbl.textContent = 'I consent to sharing this scanned text and context with a Suriin AI expert for review. Data is handled per our Privacy Policy.';
  consentRow.append(checkbox, consentLbl);
  view2.appendChild(consentRow);

  // Form action buttons
  const formBtns = mk('div', imp('display:flex;gap:6px;padding:0 12px 10px;box-sizing:border-box;pointer-events:auto;'));

  const cancelBtn = mk('button', imp(`
    flex:1;padding:7px 10px;border:1px solid rgba(255,255,255,0.12);border-radius:8px;
    font-size:11px;font-weight:600;cursor:pointer;
    background:transparent;color:#9898b2;pointer-events:auto;user-select:none;
    transition:all 0.15s ease;
  `));
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onmouseenter = () => cancelBtn.style.setProperty('background', 'rgba(255,255,255,0.06)', 'important');
  cancelBtn.onmouseleave = () => cancelBtn.style.setProperty('background', 'transparent', 'important');
  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    showView(1);
  }, true);

  const submitBtn = mk('button', imp(`
    flex:1;padding:7px 10px;border:none;border-radius:8px;
    font-size:11px;font-weight:600;cursor:pointer;
    background:#6C63FF;color:#fff;pointer-events:auto;user-select:none;
    transition:all 0.15s ease;
  `));
  submitBtn.textContent = 'Submit';
  submitBtn.onmouseenter = () => submitBtn.style.setProperty('background', '#5a52d5', 'important');
  submitBtn.onmouseleave = () => submitBtn.style.setProperty('background', '#6C63FF', 'important');

  submitBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();

    if (!checkbox.checked) {
      // Shake consent row to signal it's required
      consentRow.style.setProperty('animation', 'none', 'important');
      consentLbl.style.setProperty('color', '#EF4444', 'important');
      setTimeout(() => consentLbl.style.setProperty('color', '#9898b2', 'important'), 1200);
      return;
    }

    submitBtn.textContent = 'Sending…';
    submitBtn.style.setProperty('opacity', '0.6', 'important');

    if (isExtensionContextValid()) {
      chrome.runtime.sendMessage({
        type: 'AUTO_MODE_ACTION',
        action: 'expert-review',
        consent: true,
        context: textarea.value.trim(),
        scanResult: { ...scanResult, text: targetText, url: window.location.href }
      }, () => {
        if (chrome.runtime.lastError) {
          submitBtn.textContent = 'Error — retry';
          submitBtn.style.setProperty('opacity', '1', 'important');
        } else {
          showSuccess();
        }
      });
    } else {
      showSuccess(); // extension context gone — close gracefully
    }
  }, true);

  formBtns.append(cancelBtn, submitBtn);
  view2.appendChild(formBtns);

  // View 2 footer
  const footer2 = mk('div', imp('padding:6px 12px;text-align:center;font-size:9.5px;color:#5a5a80;border-top:1px solid rgba(255,255,255,0.05);letter-spacing:0.02em;'));
  footer2.textContent = 'Suriin AI Scanner • Privacy Protected';
  view2.appendChild(footer2);
  modal.appendChild(view2);

  // ══════════════════════════════════════════════════════════════════════════
  //  VIEW STATE MACHINE
  // ══════════════════════════════════════════════════════════════════════════

  function showView(n) {
    if (n === 1) {
      view2.style.setProperty('display', 'none', 'important');
      view1.style.setProperty('display', 'block', 'important');
      titleSpan.textContent = 'Security Scan Results:';
      modal.style.setProperty('max-height', '500px', 'important');
    } else {
      view1.style.setProperty('display', 'none', 'important');
      view2.style.setProperty('display', 'block', 'important');
      titleSpan.textContent = 'Expert Review Request:';
      modal.style.setProperty('max-height', '600px', 'important');
    }
  }

  function showSuccess() {
    view2.innerHTML = '';
    const ok = mk('div', imp('padding:24px 12px;text-align:center;'));
    const okIcon = mk('div', imp('font-size:32px;margin-bottom:8px;'));
    okIcon.textContent = '✅';
    const okMsg = mk('div', imp('font-size:12px;font-weight:600;color:#3ECFCF;margin-bottom:4px;'));
    okMsg.textContent = 'Submitted!';
    const okSub = mk('div', imp('font-size:10.5px;color:#9898b2;'));
    okSub.textContent = 'An expert will review this soon.';
    ok.append(okIcon, okMsg, okSub);
    view2.appendChild(ok);
    setTimeout(() => onClose?.(), 2000);
  }

  return { modal, closeBtn };
}

/**
 * Injects a <style> tag into document.head with only the styles
 * that can't be done inline (keyframe animations).
 */
function injectSuriinStyles() {
  if (_suriinStylesInjected) return;
  _suriinStylesInjected = true;

  const styleTag = document.createElement('style');
  styleTag.setAttribute('data-suriin-styles', 'true');
  styleTag.textContent = `
    [data-suriin-overlay="icon"]:hover {
      transform: scale(1.25) !important;
      box-shadow: 0 4px 16px rgba(108, 99, 255, 0.6) !important;
    }
  `;

  // Append to <html> instead of <head> to avoid Facebook stripping it
  (document.head || document.documentElement).appendChild(styleTag);
}
