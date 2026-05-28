/**
 * popup.js — Suriin AI Scanner
 * ============================================================
 * Responsibilities:
 *  1. Boot sequence: check onboarding state & scan mode in chrome.storage
 *  2. View switching (onboarding → main ↔ settings, main → result)
 *  3. Settings persistence (scan mode saved to chrome.storage.sync)
 *  4. Scan orchestration: inject content.js → extract text → POST to API
 *  5. Mock fallback: random traffic-light result when API is unreachable
 *  6. Result rendering: confidence bar, icons, action buttons
 *  7. Report forms: pre-fill, consent, submit via background script
 *  8. Notification badge + notification panel
 * ============================================================
 */

'use strict';

function sanitizeScanText(input) {
  if (typeof input !== 'string') return '';
  let text = input;
  text = text.replace(/^[\s\n\r\t\u00A0]+|[\s\n\r\t\u00A0]+$/g, '');
  text = text.replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

// ── DOM REFERENCES ────────────────────────────────────────────────────────────

// Views
const viewOnboarding     = document.getElementById('auth-state');
const viewMain           = document.getElementById('main-state');
const viewAdminDiagnostics = document.getElementById('view-admin-diagnostics');
const viewSettings       = document.getElementById('view-settings');
const viewResult         = document.getElementById('view-result');
const viewReportForm     = document.getElementById('view-report-form');
const viewExpertReview   = document.getElementById('view-expert-review-form');
const viewExpertConfirm  = document.getElementById('view-expert-confirm-form');
const viewNotifications  = document.getElementById('view-notifications');

// Auth State
const btnGoToLogin = document.getElementById('btn-go-to-login');

// Main view
const btnOpenSettings   = document.getElementById('btn-open-settings');
const btnScan           = document.getElementById('btn-scan');
const btnScanLabel      = document.getElementById('btn-scan-label');
const modeLabel         = document.getElementById('mode-label');
const mainInstruction   = document.getElementById('main-instruction');
const autoActiveBanner  = document.getElementById('auto-active-banner');
const loadingState      = document.getElementById('loading-state');
const btnNotifBell      = document.getElementById('btn-notif-bell');
const notifBadge        = document.getElementById('notif-badge');

// Settings view
const btnBackFromSettings = document.getElementById('btn-back-from-settings');
const btnDashboard        = document.getElementById('btn-dashboard');
const btnRevoke           = document.getElementById('btn-revoke');
const radioCards          = document.querySelectorAll('.radio-card');
const radioInputs         = document.querySelectorAll('input[name="scan-mode"]');

// Result view
const btnBackFromResult  = document.getElementById('btn-back-from-result');
const btnScanNew         = document.getElementById('btn-scan-new');
const btnExpertReview    = document.getElementById('btn-expert-review');
const btnReportEvidence  = document.getElementById('btn-report-evidence');
const btnConfirmScam     = document.getElementById('btn-confirm-scam');
const btnInvestigateFurther = document.getElementById('btn-investigate-further');
const resultIcon         = document.getElementById('result-icon');
const resultLabel        = document.getElementById('result-label');
const resultMessage      = document.getElementById('result-message');
const confidenceBar      = document.getElementById('confidence-bar');
const confidenceValue    = document.getElementById('confidence-value');
const scannedTextPreview = document.getElementById('scanned-text-preview');

// Report form (Flow A)
const btnBackFromReport     = document.getElementById('btn-back-from-report');
const btnSubmitReport       = document.getElementById('btn-submit-report');
const reportConsentCheckbox = document.getElementById('report-consent-checkbox');
const reportSuccess         = document.getElementById('report-success');
const btnCloseReportSuccess = document.getElementById('btn-close-report-success');
const btnReviewDetailsReport = document.getElementById('btn-review-details-report');

// Expert review form (Flow B)
const btnBackFromReview     = document.getElementById('btn-back-from-review');
const btnSubmitReview       = document.getElementById('btn-submit-review');
const reviewConsentCheckbox = document.getElementById('review-consent-checkbox');
const reviewSuccess         = document.getElementById('review-success');
const btnCloseReviewSuccess = document.getElementById('btn-close-review-success');
const btnReviewDetailsUser  = document.getElementById('btn-review-details-user');

// Expert confirmation form (Expert only)
const btnBackFromExpertConfirm = document.getElementById('btn-back-from-expert-confirm');
const btnSubmitExpertConfirm   = document.getElementById('btn-submit-expert-confirm');
const expertConfirmSuccess     = document.getElementById('expert-confirm-success');
const btnCloseExpertConfirmSuccess = document.getElementById('btn-close-expert-confirm-success');
const btnReviewDetailsExpert   = document.getElementById('btn-review-details-expert');
const btnBackFromConfirmSuccess = document.getElementById('btn-back-from-confirm-success');

// Expert investigation form (Expert only)
const viewExpertInvestigate      = document.getElementById('view-expert-investigate-form');
const btnBackFromExpertInvestigate = document.getElementById('btn-back-from-expert-investigate');
const btnSubmitExpertInvestigate = document.getElementById('btn-submit-expert-investigate');
const investigateSuccess         = document.getElementById('investigate-success');
const btnCloseInvestigateSuccess = document.getElementById('btn-close-investigate-success');
const btnReviewDetailsInvestigate = document.getElementById('btn-review-details-investigate');

// Expert verified-safe form (Expert only)
const viewExpertSafe             = document.getElementById('view-expert-safe-form');
const btnBackFromExpertSafe      = document.getElementById('btn-back-from-expert-safe');
const btnSubmitExpertSafe        = document.getElementById('btn-submit-expert-safe');
const expertSafeSuccess          = document.getElementById('expert-safe-success');
const btnCloseExpertSafeSuccess  = document.getElementById('btn-close-expert-safe-success');
const btnReviewDetailsSafe       = document.getElementById('btn-review-details-safe');
const btnVerifySafe              = document.getElementById('btn-verify-safe');

// Expert multi-verdict view (Expert only)
const viewMultiVerdict           = document.getElementById('view-expert-multi-verdict');

// Notification panel
const btnBackFromNotif  = document.getElementById('btn-back-from-notif');
const btnViewDashboard  = document.getElementById('btn-view-dashboard');
const btnMarkAllNotif   = document.getElementById('btn-mark-all-notif');
const notifList         = document.getElementById('notif-list');
const notifEmpty        = document.getElementById('notif-empty');

// Guest mode elements
const guestModeBanner     = document.getElementById('guest-mode-banner');
const btnGuestLogin       = document.getElementById('btn-guest-login');
const guestLoginPrompt    = document.getElementById('guest-login-prompt');
const btnGuestPromptLogin = document.getElementById('btn-guest-prompt-login');
const btnGuestPromptClose = document.getElementById('btn-guest-prompt-close');

// Auto-Scan consent modal
const modalAutoScanConsent = document.getElementById('modal-autoscan-consent');
const btnConsentAgree      = document.getElementById('btn-consent-agree');
const btnConsentCancel     = document.getElementById('btn-consent-cancel');

// Admin diagnostics view
const adminSystemStatusLine = document.getElementById('admin-system-status');
const adminExtensionApiStatusLine = document.getElementById('admin-extension-api-status');
const adminScanEngineApiStatusLine = document.getElementById('admin-scan-engine-api-status');
const adminLastCheckedLine = document.getElementById('admin-last-checked');
const adminScrapeTestCard = document.getElementById('admin-scrape-test-card');
const adminScrapeTestSummary = document.getElementById('admin-scrape-test-summary');
const btnAdminRunScrapingTest = document.getElementById('btn-admin-run-scraping-test');
const btnAdminOpenDashboard = document.getElementById('btn-admin-open-dashboard');
const adminSystemDot = document.getElementById('admin-system-dot');
const adminExtApiDot = document.getElementById('admin-ext-api-dot');
const adminScanApiDot = document.getElementById('admin-scan-api-dot');

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

/** The local Python backend endpoint */
const API_ENDPOINT = 'http://127.0.0.1:5000/api/scan-text';

/** Web app URL */
const WEB_APP_URL = 'http://127.0.0.1:5000';

/** Storage keys (keep in one place to avoid typos) */
const STORAGE_KEY_ONBOARDED = 'suriin_onboarded';
const STORAGE_KEY_SCAN_MODE = 'suriin_scan_mode';
const STORAGE_KEY_IS_AUTHENTICATED = 'isAuthenticated';
const STORAGE_KEY_USER_ROLE = 'suriin_user_role';
const STORAGE_KEY_AUTO_SCAN_CONSENT = 'hasAgreedToAutoScan';
const STORAGE_KEY_LAST_SCAN = 'suriin_last_scan';

/** Default scan mode */
const DEFAULT_SCAN_MODE = 'highlight';

// ── STATE ─────────────────────────────────────────────────────────────────────
let currentScanMode = DEFAULT_SCAN_MODE;
let isAuthenticated = false;
let userRole = 'user'; // 'user' or 'expert'
let isInlineEmbed = false;
let inlineContextId = null;
let inlineSuccessType = null;

let _inlineLastSentHeight = 0;
let _inlineResizeRaf = 0;

function normalizeRole(role) {
  const r = String(role || 'user').trim().toLowerCase();
  return r || 'user';
}

function scheduleInlineResize() {
  if (!isInlineEmbed) return;
  if (_inlineResizeRaf) return;
  // Double-RAF: first RAF commits layout changes (display:block, display:none),
  // second RAF measures after the browser has fully reflowed.
  _inlineResizeRaf = requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _inlineResizeRaf = 0;
      postInlineResize();
    });
  });
}

function postInlineResize(overrideH) {
  if (!isInlineEmbed) return;
  try {
    let h;
    if (typeof overrideH === 'number' && overrideH > 0) {
      h = Math.max(Math.ceil(overrideH), 80);
    } else {
      // Use the maximum of scrollHeight and offsetHeight — scrollHeight captures full
      // content height even when overflow:hidden clips the visible area in the iframe,
      // while offsetHeight is more accurate right after display:none transitions.
      const de = document.documentElement;
      const b = document.body;
      h = Math.max(
        Math.ceil(de?.scrollHeight || 0),
        Math.ceil(b?.scrollHeight || 0),
        Math.ceil(de?.offsetHeight || 0),
        Math.ceil(b?.offsetHeight || 0),
        80
      );
    }
    if (!h) return;
    if (Math.abs(h - _inlineLastSentHeight) < 2) return;
    _inlineLastSentHeight = h;
    window.parent.postMessage({
      type: 'SURIIN_INLINE_RESIZE',
      inlineContextId: inlineContextId || null,
      height: h
    }, '*');
  } catch { }
}

function _forceSuccessResize(successEl) {
  if (!isInlineEmbed) return;
  // Cancel any RAF queued by showView() — it would fire with the inflated
  // pre-reflow height (form fields just set to display:none but not yet reflowed).
  if (_inlineResizeRaf) {
    cancelAnimationFrame(_inlineResizeRaf);
    _inlineResizeRaf = 0;
  }
  // Imperatively collapse the parent view so scrollHeight is not inflated
  // by the view's own min-height (CSS :has() may not always fire in time).
  const parentView = successEl ? successEl.closest('.view') : null;
  if (parentView) {
    parentView.style.minHeight = '0';
    parentView.style.height = 'auto';
    parentView.style.padding = '0';
    parentView.style.overflow = 'hidden';
  }
  // Double-RAF: first RAF commits the display:none reflow,
  // second RAF measures the settled layout of only the success card.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!successEl) { scheduleInlineResize(); return; }
      const h = Math.ceil(successEl.offsetHeight || 0);
      if (h > 40) {
        // Add small vertical breathing room (top + bottom of the view)
        _inlineLastSentHeight = 0;
        postInlineResize(h + 16);
        // Additional delayed passes to ensure layout fully settles
        setTimeout(() => { _inlineLastSentHeight = 0; if (successEl) postInlineResize(Math.ceil(successEl.offsetHeight || 0) + 16); }, 80);
        setTimeout(() => { _inlineLastSentHeight = 0; if (successEl) postInlineResize(Math.ceil(successEl.offsetHeight || 0) + 16); }, 250);
      } else {
        scheduleInlineResize();
      }
    });
  });
}

function isExpertRole(role = userRole) {
  const r = normalizeRole(role);
  return isAuthenticated === true && r === 'expert';
}

function isAdminRole(role = userRole) {
  const r = normalizeRole(role);
  return isAuthenticated === true && r === 'admin';
}

function getDashboardPathForRole(role = userRole) {
  const r = normalizeRole(role);
  if (r === 'admin') return '/admin-dashboard';
  if (r === 'expert') return '/expert-dashboard';
  return '/user-dashboard';
}

function applyInlineEmbedUI() {
  if (!isInlineEmbed) return;

  const scannedBox = document.querySelector('.scanned-text-box');
  if (scannedBox) scannedBox.classList.add('hidden');

  // Hard-hide consent modal — must never appear inside the inline iframe
  if (modalAutoScanConsent) modalAutoScanConsent.classList.add('hidden');

  const prefillTextIds = [
    'report-prefill-text',
    'review-prefill-text',
    'expert-confirm-prefill-text',
    'investigate-prefill-text'
  ];

  prefillTextIds.forEach((id) => {
    const el = document.getElementById(id);
    const block = el?.closest('.form-prefill');
    if (block) block.classList.add('hidden');
  });
}

/** Holds the last scan result + text for pre-filling report forms */
let lastScanData = {
  text: '',
  url: '',
  confidence: 0,
  status: '',
  message: ''
};

// ── BOOT SEQUENCE ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const _urlParams = new URLSearchParams(window.location.search);
  isInlineEmbed = _urlParams.get('inline') === '1';
  // Per-iframe context id passed via ?ctx= — used to read isolated storage slot
  const _urlCtxId = _urlParams.get('ctx') || null;
  if (isInlineEmbed) {
    document.documentElement.classList.add('inline-embed');
    document.body.classList.add('inline-embed');
    window.addEventListener('message', (ev) => {
      const d = ev?.data;
      if (!d || typeof d !== 'object') return;
      if (d.type !== 'SURIIN_INLINE_OPEN') return;
      if (d.inlineContextId) inlineContextId = d.inlineContextId;
      const st = d.inlineSuccessType ? String(d.inlineSuccessType).trim() : '';
      if (st) {
        showInlineSuccessView(st);
      } else {
        inlineSuccessType = null;
        if (lastScanData && lastScanData.status) {
          renderResult(lastScanData, lastScanData.text);
          showView(viewResult);
        }
      }
      // Reset guard and fire resize immediately + after layout settles
      _inlineLastSentHeight = 0;
      scheduleInlineResize();
      setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 80);
      setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 250);
    }, true);

    try {
      const ro = new ResizeObserver(() => scheduleInlineResize());
      ro.observe(document.body);
    } catch { }
  }
  applyInlineEmbedUI();

  const storedSync = await chromeStorageGet([
    STORAGE_KEY_SCAN_MODE
  ]);

  // Build the per-iframe storage key (isolated per context) or fall back to legacy shared key
  const _inlinePayloadKey = _urlCtxId ? `suriin_inline_payload_${_urlCtxId}` : 'suriin_auto_mode_scan_result';

  const storedLocal = await chromeStorageLocalGet([
    STORAGE_KEY_IS_AUTHENTICATED,
    STORAGE_KEY_USER_ROLE,
    'suriin_auto_mode_action',
    _inlinePayloadKey
  ]);

  isAuthenticated = storedLocal[STORAGE_KEY_IS_AUTHENTICATED] === true;
  currentScanMode = storedSync[STORAGE_KEY_SCAN_MODE] || DEFAULT_SCAN_MODE;
  userRole = normalizeRole(storedLocal[STORAGE_KEY_USER_ROLE] || 'user');

  // Always re-probe web app tabs for latest auth and role state
  const probedResult = await probeAuthenticationAndRoleFromWebAppTabs();
  if (probedResult !== null) {
    if (probedResult.isAuthenticated === true && !isAuthenticated) {
      isAuthenticated = true;
      await chromeStorageLocalSet({ [STORAGE_KEY_IS_AUTHENTICATED]: true });
    }
    // Never downgrade isAuthenticated via probe — storage.onChanged handles that
    // Update role from web app probe if available
    const _probedRole = normalizeRole(probedResult.role);
    if (_probedRole && _probedRole !== userRole) {
      console.log(`[SuriinAI] Role updated from web app probe: ${userRole} → ${_probedRole}`);
      userRole = _probedRole;
      await chromeStorageLocalSet({ [STORAGE_KEY_USER_ROLE]: userRole });
    }
  }

  // Always re-fetch user role from Firestore if authenticated
  // This ensures role is correct even if web app probe didn't capture it
  if (isAuthenticated) {
    await fetchAndUpdateUserRole();
  }

  // Check for auto-mode action that triggered popup
  const autoModeAction = storedLocal['suriin_auto_mode_action'] || (_urlCtxId ? 'autoscan_inline' : null);
  const autoModeScanResult = storedLocal[_inlinePayloadKey];

  if (isAuthenticated && isAdminRole(userRole)) {
    if (autoModeAction && autoModeScanResult) {
      const keysToRemove = _urlCtxId
        ? [_inlinePayloadKey]
        : ['suriin_auto_mode_action', 'suriin_auto_mode_scan_result', 'suriin_auto_mode_timestamp'];
      await chrome.storage.local.remove(keysToRemove);
    }

    attachEventListeners();
    listenForAuthChanges();
    applyAuthStateToUI(isAuthenticated);
    showView(viewAdminDiagnostics);
    initAdminDiagnosticsView();
    return;
  }

  if (autoModeAction && autoModeScanResult) {
    // Clear the stored action — remove per-iframe key (or legacy key if no ctx)
    const keysToRemove = _urlCtxId
      ? [_inlinePayloadKey]
      : ['suriin_auto_mode_action', 'suriin_auto_mode_scan_result', 'suriin_auto_mode_timestamp'];
    await chrome.storage.local.remove(keysToRemove);
    
    // Set lastScanData from auto-mode result for report pre-fill
    inlineContextId = autoModeScanResult.inlineContextId || null;
    inlineSuccessType = autoModeScanResult.inlineSuccess?.type || null;

    lastScanData = {
      text: autoModeScanResult.text || '(Auto-scan result)',
      url: autoModeScanResult.url || '',
      confidence: autoModeScanResult.confidence || 0,
      scorePct: typeof autoModeScanResult.overall_score === 'number'
        ? autoModeScanResult.overall_score
        : (typeof autoModeScanResult.scorePct === 'number' ? autoModeScanResult.scorePct : (autoModeScanResult.score || 0)),
      status: (autoModeScanResult.status || autoModeScanResult.overall_status || 'safe').toString().toLowerCase(),
      message: autoModeScanResult.message || 'Scan result from auto-mode',
      breakdown: autoModeScanResult.breakdown || null,
      watchlist: autoModeScanResult.watchlist || null,
      ai_scan: autoModeScanResult.ai_scan || null,
      matched_company: autoModeScanResult.watchlist?.matched_company || null,
      ai_confidence: autoModeScanResult.ai_scan?.ai_confidence || 0,
      trigger_tokens: Array.isArray(autoModeScanResult.ai_scan?.trigger_tokens) ? autoModeScanResult.ai_scan.trigger_tokens : [],
      rawText: String(autoModeScanResult.rawText || autoModeScanResult.text || '').trim(),
      flaggedResults: Array.isArray(autoModeScanResult.flaggedResults) ? autoModeScanResult.flaggedResults : []
    };
    
    // Ensure auth listeners are set up first
    attachEventListeners();
    listenForAuthChanges();
    
    // Apply auth state to UI (shows guest banner if not authenticated)
    applyAuthStateToUI(isAuthenticated);
    
    if (isInlineEmbed && inlineSuccessType) {
      showInlineSuccessView(inlineSuccessType);
    } else {
      renderResult(lastScanData, lastScanData.text);
      showView(viewResult);
    }

    // Trigger a second resize after a short delay to catch post-paint layout
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 80);
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 250);
    
    // For guest users, also show the guest login prompt on top of the result
    if (!isAuthenticated) {
      showGuestLoginPrompt();
    }
    
    // If auto-action was triggered, we could optionally highlight the relevant button
    // but we let the user choose by showing the full UI
  } else {
    if (isInlineEmbed) {
      showView(viewResult);
      applyAuthStateToUI(isAuthenticated);
    } else {
      // A6: restore last scan result for this tab when in Scan Current Chat mode
      let _restoredScan = null;
      try {
        const [_activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (_activeTab?.id) {
          const _lsKey = `suriin_last_scan_tab_${_activeTab.id}`;
          const _lsLocal = await chromeStorageLocalGet([_lsKey]);
          const _ls = _lsLocal[_lsKey];
          if (_ls && _ls.status && _ls._scanMode === 'manual' && currentScanMode === 'manual' && _ls._tabUrl === (_activeTab.url || '')) {
            _restoredScan = _ls;
          }
        }
      } catch { }
      if (_restoredScan) {
        lastScanData = _restoredScan;
        renderResult(_restoredScan, _restoredScan.text);
        showView(viewResult);
        applyAuthStateToUI(isAuthenticated);
      } else {
        showView(document.getElementById('main-state'));
        applyModeToUI(currentScanMode);
        applyAuthStateToUI(isAuthenticated);
      }
    }

    if (isAuthenticated) {
      checkNotificationBadge();
    }

    syncRadioUI(currentScanMode);
    attachEventListeners();
    listenForAuthChanges();
  }
});

// ── VIEW MANAGEMENT ───────────────────────────────────────────────────────────

function showView(targetView) {
  // Dismiss the boot-loader overlay as soon as any real view is shown
  const _bootLoader = document.getElementById('boot-loader');
  if (_bootLoader) _bootLoader.classList.add('hidden');

  const allViews = [
    viewOnboarding, viewMain, viewAdminDiagnostics, viewSettings, viewResult,
    viewReportForm, viewExpertReview, viewExpertConfirm, viewExpertInvestigate,
    viewExpertSafe, viewMultiVerdict, viewNotifications
  ];
  allViews.forEach(v => {
    if (v) {
      v.classList.add('hidden');
      v.style.animation = 'none';
    }
  });

  if (!targetView) return;
  targetView.classList.remove('hidden');
  void targetView.offsetWidth;
  targetView.style.animation = '';

  // Reset height guard so the resize message always fires on every view switch
  _inlineLastSentHeight = 0;
  scheduleInlineResize();
}

function requestInlineModalClose() {
  try {
    window.parent.postMessage({
      type: 'SURIIN_INLINE_CLOSE',
      inlineContextId: inlineContextId || null
    }, '*');
  } catch { }
}

function notifyInlineSuccess(successType) {
  if (!isInlineEmbed) return;
  inlineSuccessType = successType;
  try {
    window.parent.postMessage({
      type: 'SURIIN_INLINE_SUCCESS',
      inlineContextId: inlineContextId || null,
      successType
    }, '*');
  } catch { }
}

function showInlineSuccessView(successType) {
  const t = String(successType || '').trim();
  inlineSuccessType = t || null;
  if (!t) {
    renderResult(lastScanData, lastScanData.text);
    showView(viewResult);
    scheduleInlineResize();
    return;
  }

  function _hideViewHeader(view) {
    if (!view || !isInlineEmbed) return;
    const hdr = view.querySelector('.header');
    if (hdr) hdr.style.display = 'none';
  }

  if (t === 'report') {
    const formElements = viewReportForm.querySelectorAll('.form-prefill-group, .form-prefill, .form-group, .consent-row, .btn-danger, .btn-warning');
    formElements.forEach(el => el.style.display = 'none');
    _hideViewHeader(viewReportForm);
    if (reportSuccess) reportSuccess.classList.remove('hidden');
    showView(viewReportForm);
    _forceSuccessResize(reportSuccess);
    return;
  }

  if (t === 'expert_review') {
    const formElements = viewExpertReview.querySelectorAll('.form-prefill-group, .form-prefill, .form-group, .consent-row, .btn-danger, .btn-warning');
    formElements.forEach(el => el.style.display = 'none');
    _hideViewHeader(viewExpertReview);
    if (reviewSuccess) reviewSuccess.classList.remove('hidden');
    showView(viewExpertReview);
    _forceSuccessResize(reviewSuccess);
    return;
  }

  if (t === 'confirm_scam') {
    const formElements = viewExpertConfirm.querySelectorAll('.form-prefill-group, .form-prefill, .form-group, .btn-danger');
    formElements.forEach(el => el.style.display = 'none');
    _hideViewHeader(viewExpertConfirm);
    if (expertConfirmSuccess) expertConfirmSuccess.classList.remove('hidden');
    showView(viewExpertConfirm);
    _forceSuccessResize(expertConfirmSuccess);
    return;
  }

  if (t === 'investigate') {
    const formElements = viewExpertInvestigate.querySelectorAll('.form-prefill-group, .form-prefill, .form-group, #btn-submit-expert-investigate');
    formElements.forEach(el => el.style.display = 'none');
    _hideViewHeader(viewExpertInvestigate);
    if (investigateSuccess) investigateSuccess.classList.remove('hidden');
    showView(viewExpertInvestigate);
    _forceSuccessResize(investigateSuccess);
    return;
  }

  if (t === 'verify_safe') {
    const formElements = viewExpertSafe ? viewExpertSafe.querySelectorAll('.form-prefill-group, .form-prefill, .form-group, #btn-submit-expert-safe') : [];
    formElements.forEach(el => el.style.display = 'none');
    if (viewExpertSafe) _hideViewHeader(viewExpertSafe);
    if (expertSafeSuccess) expertSafeSuccess.classList.remove('hidden');
    showView(viewExpertSafe);
    _forceSuccessResize(expertSafeSuccess);
    return;
  }

  if (t === 'multi_verdict') {
    const mvSuccess = document.getElementById('mv-success');
    if (viewMultiVerdict) {
      viewMultiVerdict.querySelectorAll('.mv-toggle-bar, #mv-bulk-section, #mv-individual-section').forEach(el => el.style.display = 'none');
      _hideViewHeader(viewMultiVerdict);
    }
    if (mvSuccess) mvSuccess.classList.remove('hidden');
    showView(viewMultiVerdict);
    _forceSuccessResize(mvSuccess);
    return;
  }

  renderResult(lastScanData, lastScanData.text);
  showView(viewResult);
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────

function attachEventListeners() {
  // ── Authentication / Auth State ──
  const btnGoToLogin = document.getElementById('btn-go-to-login');
  if (btnGoToLogin) {
    btnGoToLogin.addEventListener('click', () => {
      chrome.tabs.create({ url: WEB_APP_URL });
    });
  }

  // ── Guest Mode Buttons ──
  if (btnGuestLogin) {
    btnGuestLogin.addEventListener('click', () => {
      chrome.tabs.create({ url: WEB_APP_URL });
    });
  }
  if (btnGuestPromptLogin) {
    btnGuestPromptLogin.addEventListener('click', () => {
      chrome.tabs.create({ url: WEB_APP_URL });
    });
  }
  if (btnGuestPromptClose) {
    btnGuestPromptClose.addEventListener('click', () => {
      guestLoginPrompt.classList.add('hidden');
    });
  }

  // ── Main State ──
  btnOpenSettings.addEventListener('click', () => showView(document.getElementById('view-settings')));
  btnScan.addEventListener('click', handleScanTriggered);

  // ── Admin Diagnostics ──
  if (btnAdminRunScrapingTest) {
    btnAdminRunScrapingTest.addEventListener('click', handleAdminRunScrapingTest);
  }
  if (btnAdminOpenDashboard) {
    btnAdminOpenDashboard.addEventListener('click', () => {
      chrome.tabs.create({ url: WEB_APP_URL + getDashboardPathForRole('admin') });
    });
  }

  // ── Notification Bell ──
  if (btnNotifBell) {
    btnNotifBell.addEventListener('click', () => {
      loadNotifications();
      showView(viewNotifications);
    });
  }

  // ── Settings View ──
  btnBackFromSettings.addEventListener('click', () => showView(viewMain));
  btnDashboard.addEventListener('click', () => {
    if (!isAuthenticated) {
      showGuestLoginPrompt();
      return;
    }
    chrome.tabs.create({ url: WEB_APP_URL + getDashboardPathForRole(userRole) });
  });
  btnRevoke.addEventListener('click', handleRevoke);

  radioCards.forEach(card => {
    card.addEventListener('click', () => {
      const input = card.querySelector('input[type="radio"]');
      if (input) selectMode(input.value);
    });
  });

  // ── Result View ──
  btnBackFromResult.addEventListener('click', () => {
    guestLoginPrompt.classList.add('hidden');
    if (isInlineEmbed) {
      requestInlineModalClose();
      return;
    }
    showView(viewMain);
  });
  btnScanNew.addEventListener('click', () => {
    guestLoginPrompt.classList.add('hidden');
    if (isInlineEmbed) {
      requestInlineModalClose();
      return;
    }
    // A6: clear persisted scan so reopening popup shows fresh main view
    chrome.tabs.query({ active: true, currentWindow: true }, ([_t]) => {
      if (_t?.id) chrome.storage.local.remove([`suriin_last_scan_tab_${_t.id}`]);
    });
    showView(viewMain);
  });

  // Flow A: Critical Risk → Report Form (gated for guests)
  btnReportEvidence.addEventListener('click', () => {
    if (!isAuthenticated) { showGuestLoginPrompt(); return; }
    openReportForm('critical');
  });
  // Flow B: Moderate Risk → Expert Review Form (gated for guests)
  btnExpertReview.addEventListener('click', () => {
    if (!isAuthenticated) { showGuestLoginPrompt(); return; }
    openReportForm('moderate');
  });

  // Expert buttons (only visible to experts)
  if (btnConfirmScam) {
    btnConfirmScam.addEventListener('click', () => {
      if (!isAuthenticated) { showGuestLoginPrompt(); return; }
      openExpertConfirmForm();
    });
  }
  if (btnInvestigateFurther) {
    btnInvestigateFurther.addEventListener('click', () => {
      if (!isAuthenticated) { showGuestLoginPrompt(); return; }
      handleInvestigateSubmit();
    });
  }

  // ── Report Form (Flow A) ──
  if (btnBackFromReport) btnBackFromReport.addEventListener('click', () => {
    showView(viewResult);
    if (isInlineEmbed) { _inlineLastSentHeight = 0; scheduleInlineResize(); }
  });
  if (reportConsentCheckbox) {
    reportConsentCheckbox.addEventListener('change', () => {
      btnSubmitReport.disabled = !reportConsentCheckbox.checked;
    });
  }
  if (btnSubmitReport) btnSubmitReport.addEventListener('click', () => handleReportSubmit('critical'));
  if (btnCloseReportSuccess) btnCloseReportSuccess.addEventListener('click', () => {
    if (isInlineEmbed) {
      requestInlineModalClose();
      return;
    }
    showView(viewMain);
  });
  if (btnReviewDetailsReport) btnReviewDetailsReport.addEventListener('click', () => openDashboardForRole());

  // ── Expert Review Form (Flow B) ──
  if (btnBackFromReview) btnBackFromReview.addEventListener('click', () => {
    showView(viewResult);
    if (isInlineEmbed) { _inlineLastSentHeight = 0; scheduleInlineResize(); }
  });
  if (reviewConsentCheckbox) {
    reviewConsentCheckbox.addEventListener('change', () => {
      btnSubmitReview.disabled = !reviewConsentCheckbox.checked;
    });
  }
  if (btnSubmitReview) btnSubmitReview.addEventListener('click', () => handleReportSubmit('moderate'));
  if (btnCloseReviewSuccess) btnCloseReviewSuccess.addEventListener('click', () => {
    if (isInlineEmbed) {
      requestInlineModalClose();
      return;
    }
    showView(viewMain);
  });
  if (btnReviewDetailsUser) btnReviewDetailsUser.addEventListener('click', () => openDashboardForRole());

  // ── Expert Confirm Form (Expert only) ──
  if (btnBackFromExpertConfirm) btnBackFromExpertConfirm.addEventListener('click', () => {
    if (isInlineEmbed) {
      requestInlineModalClose();
      return;
    }
    showView(viewResult);
  });
  if (btnSubmitExpertConfirm) btnSubmitExpertConfirm.addEventListener('click', handleExpertConfirmSubmit);
  if (btnCloseExpertConfirmSuccess) btnCloseExpertConfirmSuccess.addEventListener('click', () => {
    if (isInlineEmbed) {
      requestInlineModalClose();
      return;
    }
    window.close();
  });
  if (btnReviewDetailsExpert) btnReviewDetailsExpert.addEventListener('click', () => openExpertResolved());

  // ── Expert Investigate Form (Expert only) ──
  if (btnBackFromExpertInvestigate) btnBackFromExpertInvestigate.addEventListener('click', () => {
    if (isInlineEmbed) {
      requestInlineModalClose();
      return;
    }
    showView(viewResult);
  });
  if (btnSubmitExpertInvestigate) btnSubmitExpertInvestigate.addEventListener('click', handleInvestigateSubmit);
  if (btnCloseInvestigateSuccess) btnCloseInvestigateSuccess.addEventListener('click', () => {
    if (isInlineEmbed) {
      requestInlineModalClose();
      return;
    }
    window.close();
  });
  if (btnReviewDetailsInvestigate) btnReviewDetailsInvestigate.addEventListener('click', () => openExpertDashboard());

  // ── Expert Verified Safe form ──
  if (btnVerifySafe) {
    btnVerifySafe.addEventListener('click', () => {
      if (!isAuthenticated) { showGuestLoginPrompt(); return; }
      openExpertSafeForm();
    });
  }
  if (btnBackFromExpertSafe) {
    btnBackFromExpertSafe.addEventListener('click', () => {
      if (isInlineEmbed) { requestInlineModalClose(); return; }
      showView(viewResult);
    });
  }
  if (btnSubmitExpertSafe) btnSubmitExpertSafe.addEventListener('click', handleExpertSafeSubmit);
  if (btnCloseExpertSafeSuccess) {
    btnCloseExpertSafeSuccess.addEventListener('click', () => {
      if (isInlineEmbed) { requestInlineModalClose(); return; }
      window.close();
    });
  }
  if (btnReviewDetailsSafe) btnReviewDetailsSafe.addEventListener('click', () => openExpertResolved());

  // Safety justification template auto-fill
  const safeTemplateSelect = document.getElementById('expert-safe-template');
  const safeNotesTextarea = document.getElementById('expert-safe-notes');
  if (safeTemplateSelect && safeNotesTextarea) {
    safeTemplateSelect.addEventListener('change', () => {
      const txt = getSafetyJustificationTemplateText(safeTemplateSelect.value);
      if (txt) { safeNotesTextarea.value = txt; safeNotesTextarea.focus(); }
    });
  }

  // ── Multi-Verdict view ──
  const mvBtnBulk = document.getElementById('mv-btn-bulk');
  const mvBtnIndividual = document.getElementById('mv-btn-individual');
  if (mvBtnBulk) {
    mvBtnBulk.addEventListener('click', () => {
      _mvMode = 'bulk';
      mvBtnBulk.classList.add('mv-toggle-active');
      if (mvBtnIndividual) mvBtnIndividual.classList.remove('mv-toggle-active');
      document.getElementById('mv-bulk-section')?.classList.remove('hidden');
      document.getElementById('mv-individual-section')?.classList.add('hidden');
      if (isInlineEmbed) { _inlineLastSentHeight = 0; scheduleInlineResize(); }
    });
  }
  if (mvBtnIndividual) {
    mvBtnIndividual.addEventListener('click', () => {
      _mvMode = 'individual';
      mvBtnIndividual.classList.add('mv-toggle-active');
      if (mvBtnBulk) mvBtnBulk.classList.remove('mv-toggle-active');
      document.getElementById('mv-bulk-section')?.classList.add('hidden');
      document.getElementById('mv-individual-section')?.classList.remove('hidden');
      _mvCursor = 0;
      _mvRenderStep();
      if (isInlineEmbed) { _inlineLastSentHeight = 0; scheduleInlineResize(); }
    });
  }

  const mvBtnConfirmAll = document.getElementById('mv-btn-confirm-all');
  if (mvBtnConfirmAll) mvBtnConfirmAll.addEventListener('click', () => openExpertConfirmForm());

  const mvBtnInvestigateAll = document.getElementById('mv-btn-investigate-all');
  if (mvBtnInvestigateAll) mvBtnInvestigateAll.addEventListener('click', () => handleInvestigateSubmit());

  const mvBtnSafeAll = document.getElementById('mv-btn-safe-all');
  if (mvBtnSafeAll) mvBtnSafeAll.addEventListener('click', () => openExpertSafeForm());

  const mvBtnConfirm = document.getElementById('mv-btn-confirm');
  if (mvBtnConfirm) mvBtnConfirm.addEventListener('click', () => {
    _mvSaveChoice('confirm_scam');
    const tpl = document.getElementById('mv-remediation-template');
    const plan = document.getElementById('mv-remediation-plan');
    if (tpl) tpl.value = 'Investment Scam';
    if (plan) plan.value = getRemediationTemplateText('Investment Scam');
    _mvRenderStep();
  });

  const mvBtnInvestigate = document.getElementById('mv-btn-investigate');
  if (mvBtnInvestigate) mvBtnInvestigate.addEventListener('click', () => {
    _mvSaveChoice('investigate');
    _mvRenderStep();
  });

  const mvBtnSafe = document.getElementById('mv-btn-safe');
  if (mvBtnSafe) mvBtnSafe.addEventListener('click', () => {
    _mvSaveChoice('verify_safe');
    const tpl = document.getElementById('mv-safe-template');
    const plan = document.getElementById('mv-safe-notes');
    if (tpl) tpl.value = 'Legitimate Business';
    if (plan) plan.value = getSafetyJustificationTemplateText('Legitimate Business');
    _mvRenderStep();
  });

  const mvBtnPrev = document.getElementById('mv-btn-prev');
  if (mvBtnPrev) mvBtnPrev.addEventListener('click', () => {
    if (_mvCursor > 0) {
      // Save current form state before moving back
      if (_mvChoices[_mvCursor]?.verdict === 'confirm_scam') {
        _mvChoices[_mvCursor].template = document.getElementById('mv-remediation-template')?.value || '';
        _mvChoices[_mvCursor].notes = document.getElementById('mv-remediation-plan')?.value || '';
      } else if (_mvChoices[_mvCursor]?.verdict === 'verify_safe') {
        _mvChoices[_mvCursor].template = document.getElementById('mv-safe-template')?.value || '';
        _mvChoices[_mvCursor].notes = document.getElementById('mv-safe-notes')?.value || '';
      }
      _mvCursor--;
      _mvRenderStep();
    }
  });

  const mvBtnNext = document.getElementById('mv-btn-next');
  if (mvBtnNext) mvBtnNext.addEventListener('click', () => {
    // Save current form state
    if (_mvChoices[_mvCursor]?.verdict === 'confirm_scam') {
      _mvChoices[_mvCursor].template = document.getElementById('mv-remediation-template')?.value || '';
      _mvChoices[_mvCursor].notes = document.getElementById('mv-remediation-plan')?.value || '';
    } else if (_mvChoices[_mvCursor]?.verdict === 'verify_safe') {
      _mvChoices[_mvCursor].template = document.getElementById('mv-safe-template')?.value || '';
      _mvChoices[_mvCursor].notes = document.getElementById('mv-safe-notes')?.value || '';
    }
    const isLast = _mvCursor === _mvItems.length - 1;
    if (isLast) {
      _mvSubmitAll();
    } else {
      _mvCursor++;
      _mvRenderStep();
    }
  });

  const mvBtnCloseSuccess = document.getElementById('mv-btn-close-success');
  if (mvBtnCloseSuccess) {
    mvBtnCloseSuccess.addEventListener('click', () => {
      if (isInlineEmbed) { requestInlineModalClose(); return; }
      window.close();
    });
  }
  const mvBtnReviewSuccess = document.getElementById('mv-btn-review-success');
  if (mvBtnReviewSuccess) mvBtnReviewSuccess.addEventListener('click', () => openExpertResolved());

  const btnBackFromMultiVerdict = document.getElementById('btn-back-from-multi-verdict');
  if (btnBackFromMultiVerdict) {
    btnBackFromMultiVerdict.addEventListener('click', () => {
      if (isInlineEmbed) { requestInlineModalClose(); return; }
      showView(viewResult);
    });
  }

  // Multi-verdict inline form template auto-fill
  const mvRemediationTpl = document.getElementById('mv-remediation-template');
  const mvRemediationPlan = document.getElementById('mv-remediation-plan');
  if (mvRemediationTpl && mvRemediationPlan) {
    mvRemediationTpl.addEventListener('change', () => {
      const txt = getRemediationTemplateText(mvRemediationTpl.value);
      if (txt) { mvRemediationPlan.value = txt; }
    });
  }
  const mvSafeTpl = document.getElementById('mv-safe-template');
  const mvSafeNotes = document.getElementById('mv-safe-notes');
  if (mvSafeTpl && mvSafeNotes) {
    mvSafeTpl.addEventListener('change', () => {
      const txt = getSafetyJustificationTemplateText(mvSafeTpl.value);
      if (txt) { mvSafeNotes.value = txt; }
    });
  }

  // ── Remediation Template Auto-Fill ──
  const remediationTemplateSelect = document.getElementById('expert-remediation-template');
  const remediationPlanTextarea = document.getElementById('expert-remediation-plan');
  if (remediationTemplateSelect && remediationPlanTextarea) {
    remediationTemplateSelect.addEventListener('change', () => {
      const templateValue = remediationTemplateSelect.value;
      const templateText = getRemediationTemplateText(templateValue);
      if (templateText) {
        remediationPlanTextarea.value = templateText;
        remediationPlanTextarea.focus();
      }
    });
  }

  // ── Notification Panel ──
  if (btnBackFromNotif) btnBackFromNotif.addEventListener('click', () => showView(viewMain));
  if (btnViewDashboard) {
    btnViewDashboard.addEventListener('click', () => {
      chrome.tabs.create({ url: WEB_APP_URL + getDashboardPathForRole(userRole) });
    });
  }
  if (btnMarkAllNotif) {
    btnMarkAllNotif.addEventListener('click', () => handleMarkAllNotificationsRead());
  }

  // ── Auto-Scan Consent Modal ──
  if (btnConsentAgree) btnConsentAgree.addEventListener('click', handleConsentAgree);
  if (btnConsentCancel) btnConsentCancel.addEventListener('click', handleConsentCancel);
}

// ── AUTH MONITORING ───────────────────────────────────────────────────────────

function listenForAuthChanges() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      // Handle authentication state changes
      if (STORAGE_KEY_IS_AUTHENTICATED in changes) {
        const newValue = changes[STORAGE_KEY_IS_AUTHENTICATED].newValue;
        const oldValue = changes[STORAGE_KEY_IS_AUTHENTICATED].oldValue;
        isAuthenticated = newValue === true;

        applyAuthStateToUI(isAuthenticated);

        if (isAuthenticated) {
          if (!isInlineEmbed) {
            if (isAdminRole(userRole) && viewAdminDiagnostics) {
              showView(viewAdminDiagnostics);
              initAdminDiagnosticsView();
            } else {
              showView(document.getElementById('main-state'));
              applyModeToUI(currentScanMode);
            }
          }
          checkNotificationBadge();

          // Re-fetch user role when auth state changes from false to true
          // (e.g., when switching accounts)
          if (!oldValue && newValue) {
            fetchAndUpdateUserRole();
          }
        } else {
          if (!isInlineEmbed) {
            if (viewAdminDiagnostics && !viewAdminDiagnostics.classList.contains('hidden')) {
              showView(document.getElementById('main-state'));
              applyModeToUI(currentScanMode);
            }
          }
        }
      }

      // Handle role changes from web app (content script updates sessionStorage → storage)
      if (STORAGE_KEY_USER_ROLE in changes) {
        const newRole = normalizeRole(changes[STORAGE_KEY_USER_ROLE].newValue || 'user');
        if (newRole !== userRole) {
          console.log(`[SuriinAI] Role changed from ${userRole} to ${newRole}`);
          userRole = newRole;
          if (!isInlineEmbed) {
            if (isAuthenticated && isAdminRole(userRole) && viewAdminDiagnostics) {
              showView(viewAdminDiagnostics);
              initAdminDiagnosticsView();
              return;
            }
            if (!isAdminRole(userRole) && viewAdminDiagnostics && !viewAdminDiagnostics.classList.contains('hidden')) {
              showView(document.getElementById('main-state'));
              applyModeToUI(currentScanMode);
            }
          }
          refreshRoleBasedUI();
        }
      }
    }
  });
}

/**
 * Fetches user role from Firestore and updates state.
 */
async function fetchAndUpdateUserRole() {
  try {
    const roleResponse = await chrome.runtime.sendMessage({ action: 'GET_USER_ROLE' });
    if (roleResponse?.success && roleResponse.role) {
      const _role = normalizeRole(roleResponse.role);
      if (_role !== userRole) {
        console.log(`[SuriinAI] Role updated from Firestore: ${userRole} → ${_role}`);
        userRole = _role;
        await chromeStorageLocalSet({ [STORAGE_KEY_USER_ROLE]: userRole });
        refreshRoleBasedUI();
      }
    }
  } catch (err) {
    console.log('[SuriinAI] Could not fetch user role:', err.message);
  }
}

async function initAdminDiagnosticsView() {
  if (!viewAdminDiagnostics || viewAdminDiagnostics.classList.contains('hidden')) return;
  // Populate signed-in admin email
  try {
    const stored = await chrome.storage.local.get(['suriin_user_email']);
    const emailEl = document.getElementById('admin-diag-email');
    if (emailEl && stored.suriin_user_email) {
      emailEl.textContent = `Signed in as ${stored.suriin_user_email}`;
    }
  } catch (e) {}
  await runAdminLiveChecks();
}

function setAdminDiagnosticsLine(el, text, state, dotEl) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('admin-diagnostics-ok', 'admin-diagnostics-bad', 'admin-diagnostics-checking');
  if (state) el.classList.add(state);
  if (dotEl) {
    dotEl.classList.remove('dot-ok', 'dot-bad', 'dot-warn');
    if (state === 'admin-diagnostics-ok')  dotEl.classList.add('dot-ok');
    if (state === 'admin-diagnostics-bad') dotEl.classList.add('dot-bad');
    if (state === 'admin-diagnostics-checking') { /* neutral grey */ }
  }
}

async function runAdminLiveChecks() {
  setAdminDiagnosticsLine(adminSystemStatusLine, 'System Status: Checking...', 'admin-diagnostics-checking', adminSystemDot);
  setAdminDiagnosticsLine(adminExtensionApiStatusLine, 'Extension API: Checking...', 'admin-diagnostics-checking', adminExtApiDot);
  setAdminDiagnosticsLine(adminScanEngineApiStatusLine, 'Scan Engine API: Checking...', 'admin-diagnostics-checking', adminScanApiDot);

  const nowLabel = (() => {
    try { return new Date().toLocaleString(); } catch { return String(new Date()); }
  })();

  const [systemOk, extensionOk, scanEngineOk] = await Promise.all([
    probeWebAppHealth(),
    probeExtensionApi(),
    probeScanEngineApi()
  ]);

  setAdminDiagnosticsLine(
    adminSystemStatusLine,
    systemOk ? 'System Status: Online' : 'System Status: Offline',
    systemOk ? 'admin-diagnostics-ok' : 'admin-diagnostics-bad',
    adminSystemDot
  );
  setAdminDiagnosticsLine(
    adminExtensionApiStatusLine,
    extensionOk ? 'Extension API: Connected' : 'Extension API: Disconnected',
    extensionOk ? 'admin-diagnostics-ok' : 'admin-diagnostics-bad',
    adminExtApiDot
  );
  setAdminDiagnosticsLine(
    adminScanEngineApiStatusLine,
    scanEngineOk ? 'Scan Engine API: Connected' : 'Scan Engine API: Disconnected',
    scanEngineOk ? 'admin-diagnostics-ok' : 'admin-diagnostics-bad',
    adminScanApiDot
  );

  if (adminLastCheckedLine) {
    adminLastCheckedLine.textContent = `Last checked: ${nowLabel}`;
  }
}

async function probeWebAppHealth() {
  try {
    const res = await fetch(`${WEB_APP_URL}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function probeExtensionApi() {
  try {
    const res = await fetch(`${WEB_APP_URL}/api/extension/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    const status = String(data?.status || '').trim().toLowerCase();
    return status === 'online';
  } catch {
    return false;
  }
}

async function probeScanEngineApi() {
  try {
    await fetch(API_ENDPOINT, {
      method: 'GET',
      mode: 'no-cors',
      signal: AbortSignal.timeout(3000)
    });
    return true;
  } catch {
    return false;
  }
}

async function extractViewportTextFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab found.');

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT_TEXT', mode: 'auto' });
    const text = response?.text ?? '';
    return { text, url: tab.url || '' };
  } catch {
    const extractionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (document.body?.innerText ?? '').trim()
    });
    const text = extractionResults?.[0]?.result ?? '';
    return { text, url: tab.url || '' };
  }
}

async function handleAdminRunScrapingTest() {
  if (adminScrapeTestCard) adminScrapeTestCard.classList.remove('hidden');
  if (adminScrapeTestSummary) adminScrapeTestSummary.textContent = 'Last scraping test: Running...';

  try {
    const { text: rawText } = await extractViewportTextFromActiveTab();
    const text = String(rawText || '').slice(0, 50000);
    if (!text || text.trim().length < 5) {
      throw new Error('Could not extract visible text from this page.');
    }

    const resp = await chrome.runtime.sendMessage({ action: 'MOCK_SCAN', text });
    if (!resp?.success) {
      throw new Error(resp?.error || 'Mock scan failed.');
    }

    const status = String(resp.status || resp.riskLevel || 'warning').trim().toLowerCase();
    const score = typeof resp.score === 'number' ? resp.score : null;
    const scoreLabel = score === null ? '' : ` (${Math.round(score)}%)`;

    if (adminScrapeTestSummary) {
      adminScrapeTestSummary.textContent = `Last scraping test: ${status}${scoreLabel}`;
    }
  } catch (err) {
    if (adminScrapeTestSummary) {
      adminScrapeTestSummary.textContent = `Last scraping test: Failed (${err.message})`;
    }
  }

  await runAdminLiveChecks();
}

/**
 * Refreshes UI elements that depend on user role.
 * Called when role changes or when needing to update button visibility.
 */
function refreshRoleBasedUI() {
  if (isAuthenticated && isAdminRole(userRole) && viewAdminDiagnostics) {
    showView(viewAdminDiagnostics);
    initAdminDiagnosticsView();
    return;
  }

  // If we're on the result view, update button visibility
  // But skip re-render if a success state is active — it would overwrite the success UI
  if (!inlineSuccessType && !viewResult.classList.contains('hidden')) {
    // Re-render the result to show correct buttons for current role
    // This uses the cached lastScanData
    if (lastScanData && lastScanData.status) {
      renderResult(
        {
          status: lastScanData.status,
          scorePct: Number.isFinite(lastScanData.scorePct) ? lastScanData.scorePct : undefined,
          watchlist: lastScanData.watchlist || null,
          ai_scan: lastScanData.ai_scan || null,
          message: lastScanData.message
        },
        lastScanData.text
      );
    }
  }

  // Update dashboard button destination
  const dashboardBtn = document.getElementById('btn-dashboard');
  if (dashboardBtn) {
    dashboardBtn.onclick = () => {
      if (!isAuthenticated) {
        showGuestLoginPrompt();
        return;
      }
      chrome.tabs.create({ url: WEB_APP_URL + getDashboardPathForRole(userRole) });
    };
  }
}

/**
 * Probes web app tabs for authentication state and user role.
 * Returns an object with isAuthenticated and role, or null if no web app tabs found.
 * @returns {Promise<{isAuthenticated: boolean, role: string} | null>}
 */
async function probeAuthenticationAndRoleFromWebAppTabs() {
  const urlPatterns = [
    'http://127.0.0.1:5000/*',
    'http://localhost:5000/*',
    'http://127.0.0.1:5500/*',
    'http://localhost:5500/*'
  ];

  const tabMap = new Map();
  for (const pattern of urlPatterns) {
    const tabs = await chrome.tabs.query({ url: pattern });
    tabs.forEach(tab => { if (tab?.id) tabMap.set(tab.id, tab); });
  }

  const webAppTabs = Array.from(tabMap.values());
  if (webAppTabs.length === 0) return null;

  // Check for dashboard URLs (quick path)
  const dashboardTab = webAppTabs.find(tab => {
    const url = tab.url || '';
    return url.includes('/user-dashboard') || url.includes('/admin-dashboard') || url.includes('/expert-dashboard');
  });
  if (dashboardTab) {
    // Try to get role from dashboard tab
    try {
      const response = await chrome.tabs.sendMessage(dashboardTab.id, { action: 'GET_WEBAPP_AUTH_STATE' });
      if (response?.success && response.isAuthenticated === true) {
        return { isAuthenticated: true, role: response.role || 'user' };
      }
    } catch (err) { /* ignore */ }
    return { isAuthenticated: true, role: 'user' };
  }

  // Probe each tab for auth state and role
  let sawExplicitFalse = false;
  for (const tab of webAppTabs) {
    if (!tab.id) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_WEBAPP_AUTH_STATE' });
      if (response?.success && response.isAuthenticated === true) {
        // Persist uid/email/role from web app tab
        if (response.uid) {
          chrome.storage.local.set({ 'suriin_user_uid': response.uid });
        }
        return { isAuthenticated: true, role: response.role || 'user' };
      }
      if (response?.success && response.isAuthenticated === false) sawExplicitFalse = true;
    } catch (err) { /* ignore */ }
  }

  return sawExplicitFalse ? { isAuthenticated: false, role: 'user' } : null;
}

async function handleRevoke() {
  await chromeStorageClear();
  // Also clear local storage consent flag
  await chromeStorageLocalSet({ [STORAGE_KEY_AUTO_SCAN_CONSENT]: false });
  isAuthenticated = false;
  userRole = 'user';
  await chromeStorageLocalSet({ [STORAGE_KEY_IS_AUTHENTICATED]: false, [STORAGE_KEY_USER_ROLE]: 'user' });
  await chrome.storage.local.remove([STORAGE_KEY_USER_ROLE, 'suriin_user_uid', 'suriin_user_email', 'suriin_id_token']);
  currentScanMode = DEFAULT_SCAN_MODE;
  syncRadioUI(currentScanMode);
  applyAuthStateToUI(false);
  showView(document.getElementById('main-state'));
}

// ── SETTINGS HANDLERS ─────────────────────────────────────────────────────────

async function selectMode(mode) {
  // Gate auto mode behind consent check
  if (mode === 'auto') {
    const consentGranted = await checkAutoScanConsent();
    if (!consentGranted) {
      // Consent not yet given — show modal, revert radio selection
      showAutoScanConsentModal();
      return;
    }
  }

  currentScanMode = mode;
  await chromeStorageSet({ [STORAGE_KEY_SCAN_MODE]: mode });
  syncRadioUI(mode);
  applyModeToUI(mode);

  if (mode !== 'manual') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([_t]) => {
      if (_t?.id) chrome.storage.local.remove([`suriin_last_scan_tab_${_t.id}`]);
    });
  }

  if (mode === 'auto') {
    chrome.runtime.sendMessage({ action: 'START_AUTO_SCAN' });
  } else {
    chrome.runtime.sendMessage({ action: 'STOP_AUTO_SCAN' });
  }

  // Proactively clear any existing overlays/icons in the active tab when
  // switching modes so the UI never shows stale highlights from a prior mode.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_SCAN_UI' }, () => { /* ignore errors */ });
    }
  } catch { }
}

function syncRadioUI(mode) {
  radioCards.forEach(card => card.classList.remove('selected'));
  radioInputs.forEach(input => { input.checked = (input.value === mode); });
  const selectedInput = document.querySelector(`input[value="${mode}"]`);
  if (selectedInput) selectedInput.closest('.radio-card').classList.add('selected');
}

function applyModeToUI(mode) {
  btnScan.classList.remove('hidden');
  autoActiveBanner.classList.add('hidden');

  switch (mode) {
    case 'highlight':
      modeLabel.textContent = 'Mode: Highlight Only';
      btnScanLabel.textContent = 'Scan Highlighted Text';
      mainInstruction.textContent = 'Select suspicious text on the page, then click Scan.';
      break;
    case 'manual':
      modeLabel.textContent = 'Mode: Scan Current Chat';
      btnScanLabel.textContent = 'Scan Current Chat';
      mainInstruction.textContent = 'Click Scan to analyze the current chat conversation only.';
      break;
    case 'auto':
      modeLabel.textContent = 'Mode: Auto Monitor';
      btnScan.classList.add('hidden');
      autoActiveBanner.classList.remove('hidden');
      mainInstruction.textContent = 'The extension is actively monitoring this page for scams.';
      break;
  }
}

// ── SCAN ORCHESTRATION ────────────────────────────────────────────────────────

async function handleScanTriggered() {
  if (isAuthenticated && isAdminRole(userRole) && viewAdminDiagnostics) {
    showView(viewAdminDiagnostics);
    initAdminDiagnosticsView();
    return;
  }

  try {
    showLoadingState(true);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab found.');

    if (currentScanMode === 'manual') {
      let resp;
      try {
        resp = await chrome.tabs.sendMessage(tab.id, { action: 'SCAN_CURRENT_CHAT' });
      } catch {
        throw new Error('Could not reach the page content script. Refresh the page and try again.');
      }

      if (!resp?.success) {
        throw new Error(resp?.error || 'Chat scan failed.');
      }

      const threatCount = Number(resp.threatCount || 0);
      const statusUpper = String(resp.overallStatus || '').toUpperCase();
      const status = statusUpper === 'CRITICAL' ? 'critical' : (statusUpper === 'WARNING' ? 'warning' : 'safe');
      const scorePct = Number.isFinite(resp.overallScore) ? Math.max(0, Math.min(100, Math.round(resp.overallScore))) : (status === 'critical' ? 100 : (status === 'warning' ? 75 : 0));
      const total = Number(resp.totalBubblesScanned || 0);

      const worstResult = resp.worstResult || null;
      const flaggedResults = Array.isArray(resp.flaggedResults) ? resp.flaggedResults : [];
      const threadBreakdown = Array.isArray(resp.threadBreakdown) ? resp.threadBreakdown : [];
      const breakdownText = formatThreadBreakdown(threadBreakdown, flaggedResults, total);
      const scanResult = {
        status,
        scorePct,
        confidence: scorePct / 100,
        watchlist: worstResult?.watchlist || null,
        ai_scan: worstResult?.ai_scan || null,
        breakdown: generateFallbackBreakdown(status),
        message: total === 0
          ? 'No chat messages detected to scan.'
          : (threatCount > 0
            ? `${threatCount} Threat${threatCount === 1 ? '' : 's'} Found in Current Chat.`
            : 'No threats found in the current chat.')
      };

      lastScanData = {
        text: breakdownText,
        rawText: String(worstResult?.text || flaggedResults[0]?.text || breakdownText).trim(),
        url: tab.url || '',
        confidence: scanResult.confidence,
        scorePct: scanResult.scorePct,
        status: scanResult.status,
        message: scanResult.message,
        watchlist: worstResult?.watchlist || null,
        ai_scan: worstResult?.ai_scan || null,
        matched_company: worstResult?.watchlist?.matched_company || null,
        ai_confidence:   typeof worstResult?.ai_scan?.ai_confidence === 'number' ? worstResult.ai_scan.ai_confidence : 0,
        trigger_tokens:  Array.isArray(worstResult?.ai_scan?.trigger_tokens) ? worstResult.ai_scan.trigger_tokens : [],
        flaggedResults: flaggedResults
      };

      showLoadingState(false);
      renderResult(scanResult, breakdownText, { threadBreakdown });

      if (isExpertRole() && flaggedResults.length >= 2) {
        openMultiVerdictView();
      } else {
        showView(viewResult);
      }

      // A6: persist last chat scan result for this tab
      try {
        chrome.storage.local.set({ [`suriin_last_scan_tab_${tab.id}`]: {
          ...lastScanData, _tabId: tab.id, _tabUrl: tab.url || '', _scanMode: currentScanMode
        }});
      } catch { }

      try {
        if (Array.isArray(resp.marks) && resp.marks.length > 0) {
          chrome.tabs.sendMessage(tab.id, { action: 'APPLY_CHAT_HIGHLIGHTS', marks: resp.marks });
        }
      } catch { }

      return;
    }

    const extractionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractTextFromPage,
      args: [currentScanMode]
    });

    const extractedText = extractionResults?.[0]?.result ?? '';

    const sanitizedText = sanitizeScanText(extractedText);

    if (!sanitizedText || sanitizedText.trim().length < 5) {
      showLoadingState(false);
      alert(
        currentScanMode === 'highlight'
          ? 'No text selected. Please highlight some text on the page first.'
          : 'Could not extract text from this page.'
      );
      return;
    }

    const scanResult = await callScanAPI(sanitizedText);

    // Store scan data for report pre-fill (no persistence for highlight/page mode)
    lastScanData = {
      text: sanitizedText,
      url: tab.url || '',
      confidence: scanResult.confidence,
      scorePct: scanResult.scorePct,
      status: scanResult.status,
      message: scanResult.message,
      watchlist: scanResult.watchlist || null,
      ai_scan: scanResult.ai_scan || null
    };

    showLoadingState(false);
    renderResult(scanResult, sanitizedText);
    showView(viewResult);

  } catch (err) {
    showLoadingState(false);
    console.error('[SuriinAI] Scan error:', err);
    
    // Show real error to user
    alert(`Scan Failed\n\n${err.message}\n\nPlease ensure:\n1. Flask backend is running (python app.py)\n2. Server is accessible at http://127.0.0.1:5000`);
  }
}

function extractTextFromPage(mode) {
  if (mode === 'highlight') {
    const selection = window.getSelection();
    return selection ? selection.toString() : '';
  } else {
    return '';
  }
}

// ── API CALL & MOCK FALLBACK ───────────────────────────────────────────────────

async function callScanAPI(text) {
  try {
    const sanitizedText = sanitizeScanText(text);
    const headers = { 'Content-Type': 'application/json' };
    const payload = { text: sanitizedText };

    // Authenticated mode: attach auth token + user_id
    if (isAuthenticated) {
      try {
        const stored = await chromeStorageLocalGet(['suriin_id_token', 'suriin_user_uid']);
        if (stored.suriin_id_token) {
          headers['Authorization'] = `Bearer ${stored.suriin_id_token}`;
        }
        if (stored.suriin_user_uid) {
          payload.user_id = stored.suriin_user_uid;
        }
      } catch { /* proceed without token */ }
    }
    // Guest mode: send statelessly (no user_id, no auth header)

    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) throw new Error(`API responded with status ${response.status}`);

    const data = await response.json();

    // Normalize overall status
    const overallStatusRaw = (data.overall_status ?? data.risk_status ?? data.status ?? '').toString().trim();
    const overallStatusUpper = overallStatusRaw.toUpperCase();
    let status = (data.status ?? '').toString().trim().toLowerCase();
    if (!status) {
      if (overallStatusUpper === 'CRITICAL') status = 'critical';
      else if (overallStatusUpper === 'WARNING') status = 'warning';
      else if (overallStatusUpper === 'SAFE') status = 'safe';
      else status = 'warning';
    }

    // Score used for the UI progress bar (0/75/100). Prefer new payload.
    let scorePct = null;
    if (typeof data.overall_score === 'number') scorePct = data.overall_score;
    else if (typeof data.score === 'number') scorePct = data.score;
    else if (typeof data.overall_score === 'string' && data.overall_score.trim() !== '') scorePct = Number(data.overall_score);
    else if (typeof data.score === 'string' && data.score.trim() !== '') scorePct = Number(data.score);

    if (!Number.isFinite(scorePct)) scorePct = null;
    if (scorePct === null) {
      // Backward compat: old endpoints may provide confidence as 0..1 or 0..100
      const confIn = data.confidence;
      if (typeof confIn === 'number') {
        scorePct = confIn <= 1 ? Math.round(confIn * 100) : Math.round(confIn);
      }
    }
    if (!Number.isFinite(scorePct)) scorePct = 50;
    scorePct = Math.max(0, Math.min(100, Math.round(scorePct)));

    // Dual-layer payload (preferred)
    const watchlist = data.watchlist && typeof data.watchlist === 'object' ? data.watchlist : null;
    const aiScan = data.ai_scan && typeof data.ai_scan === 'object' ? data.ai_scan : null;

    // Optional breakdown fallback (2 keys only)
    const breakdown = data.breakdown && typeof data.breakdown === 'object'
      ? data.breakdown
      : generateFallbackBreakdown(status);

    return {
      status,
      scorePct,
      confidence: scorePct / 100,
      watchlist,
      ai_scan: aiScan,
      breakdown,
      message: data.message ?? 'Analysis complete.'
    };
  } catch (fetchError) {
    console.error('[SuriinAI] API unreachable:', fetchError.message);
    throw new Error('Server offline or unreachable. Please ensure Flask backend is running.');
  }
}

/**
 * Generate a synthetic breakdown when API returns legacy format (no breakdown)
 * Used for backward compatibility with older API versions
 */
function generateFallbackBreakdown(status) {
  const breakdownMap = {
    safe: {
      ai_scam_result: { is_flagged: false, severity: 'safe', display_text: 'AI indicates no suspicious patterns.' },
      official_watchlist: { is_flagged: false, severity: 'safe', display_text: 'No watchlist match found.' }
    },
    warning: {
      ai_scam_result: { is_flagged: true, severity: 'warning', display_text: 'Suspicious language patterns detected.' },
      official_watchlist: { is_flagged: false, severity: 'safe', display_text: 'No watchlist match found.' }
    },
    critical: {
      ai_scam_result: { is_flagged: true, severity: 'warning', display_text: 'AI detected suspicious scam patterns.' },
      official_watchlist: { is_flagged: true, severity: 'critical', display_text: 'Matched an official SEC/DTI watchlist item.' }
    }
  };
  return breakdownMap[status] || breakdownMap.warning;
}

// ── RESULT RENDERING ──────────────────────────────────────────────────────────

function formatThreadBreakdown(threadBreakdown, flaggedResults, total) {
  if (Array.isArray(threadBreakdown) && threadBreakdown.length > 0) {
    return threadBreakdown.map((item) => {
      const snippets = Array.isArray(item.snippets) ? item.snippets : [];
      const labelPart = item.label ? `${item.label}` : 'Threat detected';
      const snippetPart = snippets.length ? `  "${snippets[0]}"` : '';
      return snippetPart ? `• ${labelPart}\n  ${snippetPart}` : `• ${labelPart}`;
    }).join('\n');
  }
  if (Array.isArray(flaggedResults) && flaggedResults.length > 0) {
    return flaggedResults.slice(0, 5).map((r) => {
      const icon = r.status === 'critical' ? '🔴' : '🟠';
      const text = String(r.text || '').trim();
      const snippet = text.length > 90 ? `${text.slice(0, 87).trim()}…` : text;
      return `• ${icon} ${snippet}`;
    }).join('\n');
  }
  return `Scanned current chat (${total} messages). No flagged items found.`;
}

function renderResult(result, originalText, opts = {}) {
  viewResult.classList.remove('result-safe', 'result-warning', 'result-critical');

  const labelEl = document.querySelector('.scanned-text-label');
  if (labelEl) {
    labelEl.textContent = Array.isArray(opts.threadBreakdown) && opts.threadBreakdown.length > 0
      ? '🛡️ Thread Threat Breakdown'
      : 'Analyzed text excerpt:';
  }

  const allowLongPreview = Array.isArray(opts.threadBreakdown) && opts.threadBreakdown.length > 0;
  const sourceText = String(originalText || '');
  const textPreview = allowLongPreview || sourceText.length <= 90
    ? sourceText
    : sourceText.substring(0, 87).trim() + '…';
  scannedTextPreview.textContent = textPreview || '—';

  // Hide all action buttons initially
  btnExpertReview.classList.add('hidden');
  btnReportEvidence.classList.add('hidden');
  btnConfirmScam.classList.add('hidden');
  btnInvestigateFurther.classList.add('hidden');
  if (btnVerifySafe) btnVerifySafe.classList.add('hidden');

  if (isAuthenticated && isAdminRole(userRole)) {
    return;
  }

  const confidencePct = Number.isFinite(result.scorePct) ? result.scorePct : 50;
  setTimeout(() => {
    confidenceBar.style.width = `${confidencePct}%`;
    confidenceValue.textContent = `${confidencePct}%`;
  }, 150);

  // Render the security scan results checklist
  renderSecurityScanResults(result);

  switch (result.status) {
    case 'safe':
      viewResult.classList.add('result-safe');
      resultIcon.innerHTML  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="38" height="38"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>';
      resultLabel.textContent = 'Low Risk';
      // No action buttons for safe results
      break;
    case 'warning':
      viewResult.classList.add('result-warning');
      resultIcon.innerHTML  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="38" height="38"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
      resultLabel.textContent = 'Review Needed';
      if (isExpertRole()) {
        btnConfirmScam.classList.remove('hidden');
        btnInvestigateFurther.classList.remove('hidden');
        if (btnVerifySafe) btnVerifySafe.classList.remove('hidden');
      } else {
        btnExpertReview.classList.remove('hidden');
      }
      break;
    case 'critical':
      viewResult.classList.add('result-critical');
      resultIcon.innerHTML  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="38" height="38"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
      resultLabel.textContent = 'CRITICAL RISK';
      if (isExpertRole()) {
        btnConfirmScam.classList.remove('hidden');
        btnInvestigateFurther.classList.remove('hidden');
        if (btnVerifySafe) btnVerifySafe.classList.remove('hidden');
      } else {
        btnReportEvidence.classList.remove('hidden');
      }
      break;
    default:
      viewResult.classList.add('result-warning');
      resultIcon.innerHTML  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="38" height="38"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
      resultLabel.textContent = 'Uncertain Result';
      if (isExpertRole()) {
        btnConfirmScam.classList.remove('hidden');
        btnInvestigateFurther.classList.remove('hidden');
        if (btnVerifySafe) btnVerifySafe.classList.remove('hidden');
      }
  }
}

/**
 * Render the Security Scan Results checklist (Explainable AI)
 * Updates the 3-layer breakdown display with severity badges and user-friendly text
 * @param {Object} result - Normalized result containing watchlist + ai_scan
 */
function renderSecurityScanResults(result) {
  const container = document.getElementById('security-scan-results');
  if (!container) return;

  const aiRow = container.querySelector('.scan-result-item[data-layer="message-tone"]');
  const watchRow = container.querySelector('.scan-result-item[data-layer="gov-records"]');
  if (!aiRow || !watchRow) return;

  // AI row
  {
    const aiScan = result?.ai_scan;
    const aiStatus = String(aiScan?.status || '').trim().toUpperCase();
    const isSuspicious = aiStatus === 'SUSPICIOUS';
    const severity = isSuspicious ? 'warning' : 'safe';
    const displayText = isSuspicious ? 'AI Flagged: Suspicious Pattern' : 'AI Scan: Clear';

    aiRow.setAttribute('data-severity', severity);
    const textEl = aiRow.querySelector('.scan-result-text');
    if (textEl) textEl.textContent = displayText;
  }

  // Watchlist row
  {
    const wl = result?.watchlist;
    const wlStatus = String(wl?.status || '').trim().toUpperCase();
    const isMatched = wlStatus === 'MATCHED';
    const severity = isMatched ? 'critical' : 'safe';
    const company = wl?.matched_company || null;
    const displayText = isMatched
      ? (company ? `SEC Watchlist: ${company}` : 'SEC/DTI Watchlist Match')
      : 'No Watchlist Match';

    watchRow.setAttribute('data-severity', severity);
    const textEl = watchRow.querySelector('.scan-result-text');
    if (textEl) textEl.textContent = displayText;
  }
}

/**
 * Get emoji badge based on severity
 * @param {string} severity - 'safe' | 'warning' | 'critical'
 * @returns {string} emoji
 */
function getEmojiForSeverity(severity) {
  const emojiMap = {
    safe: '🟢',
    warning: '🟡',
    critical: '🔴'
  };
  return emojiMap[severity] || '⚪';
}

// ══════════════════════════════════════════════════════════════════════════════
//  REPORT FORM LOGIC (Flows A & B)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Opens the appropriate report form and pre-fills fields from the last scan.
 * @param {'critical'|'moderate'} type
 */
function openReportForm(type) {
  const confidencePct = Math.round((lastScanData.confidence ?? 0) * 100);
  const truncatedUrl = lastScanData.url.length > 40
    ? lastScanData.url.substring(0, 37) + '…'
    : lastScanData.url || '—';
  const truncatedText = lastScanData.text.length > 200
    ? lastScanData.text.substring(0, 197) + '…'
    : lastScanData.text || '—';

  if (type === 'critical') {
    // Pre-fill Flow A form
    document.getElementById('report-prefill-url').textContent = truncatedUrl;
    document.getElementById('report-prefill-url').title = lastScanData.url;
    document.getElementById('report-prefill-score').textContent = `${confidencePct}%`;
    document.getElementById('report-prefill-text').textContent = truncatedText;
    // Reset form state
    document.getElementById('report-suspect-handle').value = '';
    document.getElementById('report-context').value = '';
    reportConsentCheckbox.checked = false;
    btnSubmitReport.disabled = true;
    reportSuccess.classList.add('hidden');
    // User role: relabel header to "Report to Expert"
    if (!isExpertRole()) {
      const hdrTitle = viewReportForm.querySelector('.header-title-centered');
      if (hdrTitle) hdrTitle.textContent = 'Report to Expert';
    }
    showView(viewReportForm);
    // A2: immediate direct measure so iframe grows to form height without scrollbar
    if (isInlineEmbed) { _inlineLastSentHeight = 0; postInlineResize((viewReportForm.scrollHeight || 0) + 24); }
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 60);
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 250);
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 600);
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 1000);

  } else {
    // Pre-fill Flow B form
    document.getElementById('review-prefill-url').textContent = truncatedUrl;
    document.getElementById('review-prefill-url').title = lastScanData.url;
    document.getElementById('review-prefill-score').textContent = `${confidencePct}%`;
    document.getElementById('review-prefill-text').textContent = truncatedText;
    // Reset form state
    document.getElementById('review-suspect-handle').value = '';
    document.getElementById('review-reason').value = '';
    reviewConsentCheckbox.checked = false;
    btnSubmitReview.disabled = true;
    reviewSuccess.classList.add('hidden');
    // User role: relabel header to "Report to Expert"
    if (!isExpertRole()) {
      const hdrTitle = viewExpertReview.querySelector('.header-title-centered');
      if (hdrTitle) hdrTitle.textContent = 'Report to Expert';
    }
    showView(viewExpertReview);
    // A2: immediate direct measure so iframe grows to form height without scrollbar
    if (isInlineEmbed) { _inlineLastSentHeight = 0; postInlineResize((viewExpertReview.scrollHeight || 0) + 24); }
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 60);
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 250);
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 600);
    setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 1000);
  }
}

/**
 * Handles form submission for both Flow A and Flow B.
 * Sends the report payload to the background script for async API delivery.
 * @param {'critical'|'moderate'} type
 */
async function handleReportSubmit(type) {
  const isCritical = type === 'critical';
  const submitBtn = isCritical ? btnSubmitReport : btnSubmitReview;
  const successEl = isCritical ? reportSuccess : reviewSuccess;
  const inlineSuccess = isCritical ? 'report' : 'expert_review';
  const userContext = isCritical
    ? document.getElementById('report-context').value.trim()
    : document.getElementById('review-reason').value.trim();
  const suspectHandle = isCritical
    ? document.getElementById('report-suspect-handle').value.trim()
    : document.getElementById('review-suspect-handle').value.trim();
  const finalSuspect = suspectHandle ? suspectHandle : 'Unknown suspect';

  // Disable button and show loading
  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = 'Submitting…';

  const _rawFlagged = Array.isArray(lastScanData.flaggedResults) ? lastScanData.flaggedResults : [];
  // B3: deduplicate by text hash so each unique scam message = one report item
  // Also skip near-duplicates (substring relationships)
  const _seenTextKeys = new Set();
  const _dedupedFlagged = _rawFlagged.filter((r) => {
    const k = String(r.text || '').trim();
    if (!k) return false;
    // Skip if exact match already seen
    if (_seenTextKeys.has(k)) return false;
    // Skip if this text is a substring of any already-seen text (or vice-versa)
    for (const existing of _seenTextKeys) {
      if (k.includes(existing) || existing.includes(k)) {
        return false;
      }
    }
    _seenTextKeys.add(k);
    return true;
  });
  const _hasFlagged = _dedupedFlagged.length > 0;
  const _aiVerdict = String(lastScanData.status || '').toUpperCase() || 'WARNING';
  const _threatSeverity = isCritical ? 'High' : 'Normal';
  const payload = _hasFlagged
    ? {
        action: 'SUBMIT_BULK_REPORT',
        data: {
          items: _dedupedFlagged.map((r) => ({
            text:           String(r.text || '').substring(0, 5000),
            riskScore:      Number(r.score ?? 0) / 100,
            aiStatus:       (() => { const s = String(r.ai_scan?.status || r.status || '').toUpperCase(); if (s === 'SUSPICIOUS') return 'WARNING'; if (s === 'MATCHED') return 'CRITICAL'; return s || 'WARNING'; })(),
            aiConfidence:   typeof r.ai_scan?.ai_confidence === 'number' ? r.ai_scan.ai_confidence : 0,
            matchedCompany: r.watchlist?.matched_company || null,
            triggerTokens:  Array.isArray(r.ai_scan?.trigger_tokens) ? r.ai_scan.trigger_tokens : []
          })),
          url:              lastScanData.url,
          aiVerdict:        _aiVerdict,
          threatSeverity:   _threatSeverity,
          userContext:      userContext,
          sourceIdentifier: finalSuspect
        }
      }
    : {
        action: 'SUBMIT_REPORT',
        data: {
          evidence:         (lastScanData.rawText || lastScanData.text).substring(0, 5000),
          url:              lastScanData.url,
          riskScore:        lastScanData.confidence,
          aiVerdict:        _aiVerdict,
          threatSeverity:   _threatSeverity,
          aiConfidence:     lastScanData.ai_confidence || 0,
          matchedCompany:   lastScanData.matched_company || null,
          triggerTokens:    Array.isArray(lastScanData.ai_scan?.trigger_tokens) ? lastScanData.ai_scan.trigger_tokens : [],
          userContext:      userContext,
          sourceIdentifier: finalSuspect
        }
      };

  try {
    const response = await chrome.runtime.sendMessage(payload);

    if (response?.success) {
      // Background acknowledged the job (may still be in-flight).
      // Show success UI immediately so the popup feels responsive.
      const formElements = (isCritical ? viewReportForm : viewExpertReview)
        .querySelectorAll('.form-prefill-group, .form-prefill, .form-group, .consent-row, .btn-danger, .btn-warning');
      formElements.forEach(el => el.style.display = 'none');
      successEl.classList.remove('hidden');
      _forceSuccessResize(successEl);

      if (isInlineEmbed && !response.pending) {
        notifyInlineSuccess(inlineSuccess);
      }

      // If pending, watch storage for the final result (catches auth/network errors)
      if (response.pending) {
        const checkResult = (changes) => {
          if (!('suriin_last_submit_result' in changes)) return;
          chrome.storage.onChanged.removeListener(checkResult);
          const r = changes.suriin_last_submit_result.newValue;
          if (r && r.success) {
            if (isInlineEmbed) notifyInlineSuccess(inlineSuccess);
            return;
          }
          if (r && !r.success) {
            successEl.classList.add('hidden');
            formElements.forEach(el => el.style.display = '');
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
            alert('Report submission failed: ' + (r.error || 'Unknown error'));
          }
        };
        chrome.storage.onChanged.addListener(checkResult);
        // Auto-remove listener after 35s (past the fetch timeout)
        setTimeout(() => chrome.storage.onChanged.removeListener(checkResult), 35000);
      }
    } else {
      alert('Failed to submit report: ' + (response?.error || 'Unknown error'));
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  } catch (err) {
    console.error('[SuriinAI] Report submission error:', err);
    alert('Failed to submit report. Please try again.');
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  EXPERT-SPECIFIC FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Returns the remediation plan text for a given template key.
 * Used to auto-fill the remediation plan textarea in the expert confirm form.
 * @param {string} key - The template key (e.g., 'Investment Scam', 'Phishing')
 * @returns {string} The template text to populate the remediation plan field
 */
function getRemediationTemplateText(key) {
  const templates = {
    'Investment Scam': `IMMEDIATE ACTIONS REQUIRED:

1. DO NOT send any money or cryptocurrency to the suspect.
2. Cease all communication with the suspect immediately.
3. If you already shared financial information, contact your bank/financial institution to freeze accounts and dispute transactions.
4. Change passwords for any accounts you may have shared.
5. Report this to the SEC or relevant financial regulatory authority.
6. Document all evidence (screenshots, transaction records, communications).
7. Report this incident to local law enforcement and cybercrime units.`,
    
    'Romance Scam': `IMMEDIATE ACTIONS REQUIRED:

1. STOP all communication with the suspect immediately - do not confront them.
2. DO NOT send any money, gift cards, or financial assistance.
3. If you already sent money, contact your bank/wire service immediately to attempt reversal.
4. If you shared intimate photos/videos, be aware they may be used for blackmail - do not pay extortion demands.
5. Change passwords for all dating apps, social media, and email accounts.
6. Review and tighten privacy settings on all social platforms.
7. Report to the dating platform/app where contact was made.
8. Seek support from trusted friends, family, or victim support services.`,
    
    'Phishing': `IMMEDIATE ACTIONS REQUIRED:

1. DO NOT click any links, download attachments, or reply to the phishing message.
2. If you already clicked a link or entered credentials on a fake site:
   - Change passwords immediately for the affected accounts
   - Enable two-factor authentication (2FA) on all accounts
   - Contact the legitimate organization to report the compromise
3. Run a full antivirus/anti-malware scan on your device.
4. Check for unauthorized transactions or account changes.
5. Forward the phishing email to your organization's IT security team or to reportphishing@apwg.org.
6. Report to the Anti-Phishing Working Group (APWG) and relevant authorities.`,
    
    'Identity Theft': `IMMEDIATE ACTIONS REQUIRED:

1. Place a fraud alert on your credit reports with all three major bureaus (Experian, Equifax, TransUnion).
2. Consider placing a credit freeze to prevent new accounts from being opened.
3. Change passwords for all critical accounts (banking, email, government services).
4. Enable 2FA on all accounts that support it.
5. Review your credit reports for unauthorized accounts or inquiries.
6. File a report with the FTC at IdentityTheft.gov or your country's equivalent.
7. File a police report with local law enforcement.
8. Contact banks and creditors to dispute fraudulent charges and close compromised accounts.
9. Document all fraudulent activity for investigation purposes.`,
    
    'Product Scam': `IMMEDIATE ACTIONS REQUIRED:

1. DO NOT make any additional payments or provide further personal information.
2. If you paid but haven't received the product:
   - Contact your bank/credit card company to dispute the charge
   - Request a chargeback if payment was recent
3. If you received a counterfeit or wrong product, document with photos.
4. Report the seller to the e-commerce platform (Amazon, eBay, Facebook Marketplace, etc.).
5. Leave honest reviews to warn other potential buyers.
6. Report to consumer protection agencies (BBB, FTC, or local equivalent).
7. If significant money was lost, report to law enforcement and provide all transaction evidence.`,
    
    'Job Scam': `IMMEDIATE ACTIONS REQUIRED:

1. DO NOT provide any more personal information (SSN, bank details, ID copies).
2. If you already provided sensitive information, monitor accounts closely and consider credit freeze.
3. If you paid any "fees" or "training costs", attempt to recover via bank dispute/chargeback.
4. Stop all communication with the fake employer immediately.
5. Report the fake job posting to the job board (LinkedIn, Indeed, etc.).
6. Report to your country's labor department or fraud reporting center.
7. Be vigilant for follow-up scams (fake recovery services, legal help, etc.).
8. Update your resume privacy settings to reduce visibility to scammers.`,
    
    'Custom': '' // Custom leaves the field empty for expert to type
  };
  
  return templates[key] || '';
}

/**
 * Opens the expert confirmation form and pre-fills fields.
 */
function openExpertConfirmForm() {
  const confidencePct = Math.round((lastScanData.confidence ?? 0) * 100);
  const truncatedUrl = lastScanData.url.length > 40
    ? lastScanData.url.substring(0, 37) + '…'
    : lastScanData.url || '—';
  const truncatedText = lastScanData.text.length > 200
    ? lastScanData.text.substring(0, 197) + '…'
    : lastScanData.text || '—';

  // Restore form elements in case a previous submission hid them
  const formElements = viewExpertConfirm.querySelectorAll(
    '.form-prefill-group, .form-prefill, .form-group, #btn-submit-expert-confirm'
  );
  formElements.forEach(el => el.style.display = '');
  if (btnSubmitExpertConfirm) {
    btnSubmitExpertConfirm.disabled = false;
    btnSubmitExpertConfirm.textContent = '🚨 Confirm Scam & Submit';
  }

  // Pre-fill expert confirmation form
  document.getElementById('expert-confirm-prefill-url').textContent = truncatedUrl;
  document.getElementById('expert-confirm-prefill-url').title = lastScanData.url;
  document.getElementById('expert-confirm-prefill-score').textContent = `${confidencePct}%`;
  document.getElementById('expert-confirm-prefill-text').textContent = truncatedText;

  // Reset form state
  document.getElementById('expert-confirm-suspect-handle').value = '';
  document.getElementById('expert-remediation-template').value = 'Investment Scam';
  document.getElementById('expert-remediation-plan').value = '';
  expertConfirmSuccess.classList.add('hidden');
  showView(viewExpertConfirm);
}

/**
 * Handles expert "Confirm Scam" submission.
 * Saves with status 'Reviewed' and expert_verdict 'Confirmed Threat'.
 */
async function handleExpertConfirmSubmit() {
  const submitBtn = btnSubmitExpertConfirm;
  const suspectHandle = document.getElementById('expert-confirm-suspect-handle').value.trim();
  const remediationTemplate = document.getElementById('expert-remediation-template').value;
  const remediationPlan = document.getElementById('expert-remediation-plan').value.trim();
  const finalSuspect = suspectHandle ? suspectHandle : 'Unknown suspect';

  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = 'Confirming…';

  const storage = await chrome.storage.local.get(['suriin_user_email']);
  const expertEmail = storage.suriin_user_email || 'unknown';
  const expertName = expertEmail.split('@')[0];
  const expertNotes = `Manual Field Discovery. Remediation applied: ${remediationTemplate}. Analyst: "@${expertName}".`;

  // Build one payload per unique flagged text (or fall back to single report)
  const _rawFlagged = Array.isArray(lastScanData.flaggedResults) ? lastScanData.flaggedResults : [];
  const _seenKeys = new Set();
  const _deduped = _rawFlagged.filter((r) => {
    const k = String(r.text || '').trim();
    if (!k || _seenKeys.has(k)) return false;
    _seenKeys.add(k);
    return true;
  });

  const payloads = _deduped.length > 0
    ? _deduped.map((r) => ({
        action: 'EXPERT_CONFIRM_SCAM',
        data: {
          text:                String(r.text || '').substring(0, 5000),
          url:                 lastScanData.url,
          riskScore:           Number(r.score ?? 0) / 100,
          riskMessage:         lastScanData.message,
          sourceIdentifier:    finalSuspect,
          remediationTemplate: remediationTemplate,
          remediationPlan:     remediationPlan,
          expertNotes:         expertNotes,
          userContext:         'Internal Expert Discovery',
          aiConfidence:        typeof r.ai_scan?.ai_confidence === 'number' ? r.ai_scan.ai_confidence : (lastScanData.ai_confidence || 0),
          triggerTokens:       Array.isArray(r.ai_scan?.trigger_tokens) ? r.ai_scan.trigger_tokens : (lastScanData.trigger_tokens || []),
          matchedCompany:      r.watchlist?.matched_company || lastScanData.matched_company || null
        }
      }))
    : [{
        action: 'EXPERT_CONFIRM_SCAM',
        data: {
          text:                lastScanData.text.substring(0, 5000),
          url:                 lastScanData.url,
          riskScore:           lastScanData.confidence,
          riskMessage:         lastScanData.message,
          sourceIdentifier:    finalSuspect,
          remediationTemplate: remediationTemplate,
          remediationPlan:     remediationPlan,
          expertNotes:         expertNotes,
          userContext:         'Internal Expert Discovery',
          aiConfidence:        lastScanData.ai_confidence || 0,
          triggerTokens:       lastScanData.trigger_tokens || [],
          matchedCompany:      lastScanData.matched_company || null
        }
      }];

  const formElements = viewExpertConfirm.querySelectorAll('.form-prefill-group, .form-prefill, .form-group, .btn-danger');

  try {
    const responses = await Promise.all(payloads.map((p) => chrome.runtime.sendMessage(p)));
    const allOk = responses.every((r) => r?.success);

    if (allOk) {
      formElements.forEach(el => el.style.display = 'none');
      expertConfirmSuccess.classList.remove('hidden');
      _forceSuccessResize(expertConfirmSuccess);
      if (isInlineEmbed) notifyInlineSuccess('confirm_scam');
    } else {
      const failed = responses.find((r) => !r?.success);
      alert('Failed to confirm scam: ' + (failed?.error || 'Unknown error'));
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  } catch (err) {
    console.error('[SuriinAI] Expert confirmation error:', err);
    alert('Failed to confirm scam. Please try again.');
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

/**
 * Returns safety justification template text for the given key.
 */
function getSafetyJustificationTemplateText(key) {
  const templates = {
    'Legitimate Business': `SAFETY ASSESSMENT: Legitimate Business Communication

This content has been reviewed and assessed as originating from a verified or credible business entity.

Justification:
1. The sender/source appears to be an established business or organization.
2. The communication follows standard business communication practices.
3. No deceptive elements, urgent financial requests, or suspicious links were identified.
4. The offer/information aligns with normal market expectations.
5. Identity markers (name, contact, website) are consistent and verifiable.

Verdict: SAFE — No action required. Monitor for any follow-up suspicious activity.`,

    'Personal Communication': `SAFETY ASSESSMENT: Personal Communication

This content has been reviewed and assessed as a legitimate personal communication between individuals.

Justification:
1. The message tone and context are consistent with normal personal interaction.
2. No unsolicited financial requests, credential harvesting, or high-pressure tactics detected.
3. The sender's identity and relationship context appear genuine.
4. Language patterns do not match known scam scripts or phishing templates.
5. No suspicious links, attachments, or third-party redirection attempts.

Verdict: SAFE — Consistent with normal personal communication. No action required.`,

    'Promotional': `SAFETY ASSESSMENT: Authorized Promotional Content

This content has been reviewed and assessed as authorized promotional or marketing material.

Justification:
1. The content originates from a recognizable brand, service, or official channel.
2. Promotional offers are realistic and do not promise guaranteed/unrealistic returns.
3. Contact details and opt-out mechanisms are clearly provided.
4. No personal data harvesting or deceptive sign-up flows detected.
5. Content complies with general advertising standards.

Verdict: SAFE — Legitimate promotional content. No action required.`,

    'Custom': ''
  };
  return templates[key] || '';
}

/**
 * Opens the expert verified-safe form and pre-fills fields.
 */
function openExpertSafeForm() {
  const confidencePct = Math.round((lastScanData.confidence ?? 0) * 100);
  const truncatedUrl = lastScanData.url.length > 40
    ? lastScanData.url.substring(0, 37) + '\u2026'
    : lastScanData.url || '\u2014';
  const truncatedText = lastScanData.text.length > 200
    ? lastScanData.text.substring(0, 197) + '\u2026'
    : lastScanData.text || '\u2014';

  const formElements = viewExpertSafe ? viewExpertSafe.querySelectorAll(
    '.form-prefill-group, .form-prefill, .form-group, #btn-submit-expert-safe'
  ) : [];
  formElements.forEach(el => el.style.display = '');
  if (btnSubmitExpertSafe) {
    btnSubmitExpertSafe.disabled = false;
    btnSubmitExpertSafe.textContent = '\u2713 Verified Safe & Submit';
  }

  const urlEl = document.getElementById('expert-safe-prefill-url');
  const scoreEl = document.getElementById('expert-safe-prefill-score');
  const textEl = document.getElementById('expert-safe-prefill-text');
  if (urlEl) { urlEl.textContent = truncatedUrl; urlEl.title = lastScanData.url; }
  if (scoreEl) scoreEl.textContent = `${confidencePct}%`;
  if (textEl) textEl.textContent = truncatedText;

  const handleEl = document.getElementById('expert-safe-suspect-handle');
  const templateEl = document.getElementById('expert-safe-template');
  const notesEl = document.getElementById('expert-safe-notes');
  if (handleEl) handleEl.value = '';
  if (templateEl) templateEl.value = 'Legitimate Business';
  if (notesEl) notesEl.value = getSafetyJustificationTemplateText('Legitimate Business');
  if (expertSafeSuccess) expertSafeSuccess.classList.add('hidden');
  showView(viewExpertSafe);
  if (isInlineEmbed) { _inlineLastSentHeight = 0; postInlineResize((viewExpertSafe.scrollHeight || 0) + 24); }
  setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 60);
  setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 250);
  setTimeout(() => { _inlineLastSentHeight = 0; scheduleInlineResize(); }, 600);
}

/**
 * Handles expert "Verified Safe" submission.
 */
async function handleExpertSafeSubmit() {
  const submitBtn = btnSubmitExpertSafe;
  const suspectHandle = (document.getElementById('expert-safe-suspect-handle')?.value || '').trim();
  const safeTemplate = document.getElementById('expert-safe-template')?.value || 'Legitimate Business';
  const safeNotes = (document.getElementById('expert-safe-notes')?.value || '').trim();
  const finalSuspect = suspectHandle || 'Unknown suspect';

  if (submitBtn) submitBtn.disabled = true;
  const originalText = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) submitBtn.textContent = 'Submitting\u2026';

  const storage = await chrome.storage.local.get(['suriin_user_email']);
  const expertEmail = storage.suriin_user_email || 'unknown';
  const expertName = expertEmail.split('@')[0];
  const expertNotes = `Verified Safe. Justification applied: ${safeTemplate}. Analyst: "@${expertName}".`;

  const _rawFlagged = Array.isArray(lastScanData.flaggedResults) ? lastScanData.flaggedResults : [];
  const _seenKeys = new Set();
  const _deduped = _rawFlagged.filter((r) => {
    const k = String(r.text || '').trim();
    if (!k || _seenKeys.has(k)) return false;
    _seenKeys.add(k);
    return true;
  });

  const payloads = _deduped.length > 0
    ? _deduped.map((r) => ({
        action: 'EXPERT_VERIFY_SAFE',
        data: {
          text:           String(r.text || '').substring(0, 5000),
          url:            lastScanData.url,
          riskScore:      Number(r.score ?? 0) / 100,
          riskMessage:    lastScanData.message,
          sourceIdentifier: finalSuspect,
          safetyTemplate: safeTemplate,
          safetyNotes:    safeNotes,
          expertNotes,
          aiConfidence:   typeof r.ai_scan?.ai_confidence === 'number' ? r.ai_scan.ai_confidence : (lastScanData.ai_confidence || 0),
          triggerTokens:  Array.isArray(r.ai_scan?.trigger_tokens) ? r.ai_scan.trigger_tokens : (lastScanData.trigger_tokens || []),
          matchedCompany: r.watchlist?.matched_company || lastScanData.matched_company || null
        }
      }))
    : [{
        action: 'EXPERT_VERIFY_SAFE',
        data: {
          text:           lastScanData.text.substring(0, 5000),
          url:            lastScanData.url,
          riskScore:      lastScanData.confidence,
          riskMessage:    lastScanData.message,
          sourceIdentifier: finalSuspect,
          safetyTemplate: safeTemplate,
          safetyNotes:    safeNotes,
          expertNotes,
          aiConfidence:   lastScanData.ai_confidence || 0,
          triggerTokens:  lastScanData.trigger_tokens || [],
          matchedCompany: lastScanData.matched_company || null
        }
      }];

  const formElements = viewExpertSafe ? viewExpertSafe.querySelectorAll('.form-prefill-group, .form-prefill, .form-group, #btn-submit-expert-safe') : [];

  try {
    const responses = await Promise.all(payloads.map((p) => chrome.runtime.sendMessage(p)));
    const allOk = responses.every((r) => r?.success);

    if (allOk) {
      formElements.forEach(el => el.style.display = 'none');
      if (expertSafeSuccess) expertSafeSuccess.classList.remove('hidden');
      _forceSuccessResize(expertSafeSuccess);
      if (isInlineEmbed) notifyInlineSuccess('verify_safe');
    } else {
      const failed = responses.find((r) => !r?.success);
      alert('Failed to mark as verified safe: ' + (failed?.error || 'Unknown error'));
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText; }
    }
  } catch (err) {
    console.error('[SuriinAI] Verified safe error:', err);
    alert('Failed to submit. Please try again.');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText; }
  }
}

// ── MULTI-VERDICT STATE ────────────────────────────────────────────────────────
let _mvItems = [];
let _mvCursor = 0;
let _mvChoices = [];
let _mvMode = 'bulk';

/**
 * Opens the multi-verdict view and initialises state.
 */
function openMultiVerdictView() {
  const _rawFlagged = Array.isArray(lastScanData.flaggedResults) ? lastScanData.flaggedResults : [];
  const _seenKeys = new Set();
  _mvItems = _rawFlagged.filter((r) => {
    const k = String(r.text || '').trim();
    if (!k || _seenKeys.has(k)) return false;
    for (const ex of _seenKeys) { if (k.includes(ex) || ex.includes(k)) return false; }
    _seenKeys.add(k);
    return true;
  });
  if (_mvItems.length === 0) {
    showView(viewResult);
    return;
  }
  _mvCursor = 0;
  _mvChoices = _mvItems.map(() => ({ verdict: null, template: '', notes: '' }));
  _mvMode = 'bulk';

  const countEl = document.getElementById('mv-count');
  if (countEl) countEl.textContent = String(_mvItems.length);

  const mvSuccess = document.getElementById('mv-success');
  if (mvSuccess) mvSuccess.classList.add('hidden');

  const toggleBar = document.querySelector('.mv-toggle-bar');
  const bulkSec = document.getElementById('mv-bulk-section');
  const indSec = document.getElementById('mv-individual-section');
  if (toggleBar) toggleBar.style.display = '';
  if (bulkSec) { bulkSec.classList.remove('hidden'); bulkSec.style.display = ''; }
  if (indSec) { indSec.classList.add('hidden'); }

  const btnBulk = document.getElementById('mv-btn-bulk');
  const btnInd = document.getElementById('mv-btn-individual');
  if (btnBulk) { btnBulk.classList.add('mv-toggle-active'); }
  if (btnInd) { btnInd.classList.remove('mv-toggle-active'); }

  showView(viewMultiVerdict);
  if (isInlineEmbed) { _inlineLastSentHeight = 0; scheduleInlineResize(); }
}

/**
 * Renders the current step in individual mode.
 */
function _mvRenderStep() {
  const item = _mvItems[_mvCursor];
  if (!item) return;
  const choice = _mvChoices[_mvCursor];
  const total = _mvItems.length;

  const progressText = document.getElementById('mv-progress-text');
  if (progressText) progressText.textContent = `Text ${_mvCursor + 1} of ${total}`;

  const dots = document.getElementById('mv-progress-dots');
  if (dots) {
    dots.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const d = document.createElement('span');
      d.className = 'mv-dot' + (i === _mvCursor ? ' mv-dot-active' : '') + (_mvChoices[i].verdict ? ' mv-dot-done' : '');
      dots.appendChild(d);
    }
  }

  const preview = document.getElementById('mv-text-preview');
  if (preview) preview.textContent = (item.text || '').substring(0, 120) + ((item.text || '').length > 120 ? '\u2026' : '');

  const scoreEl = document.getElementById('mv-text-score');
  if (scoreEl) {
    const s = typeof item.score === 'number' ? Math.round(item.score) : 0;
    scoreEl.textContent = `Risk: ${s}%`;
  }

  const verdictBtns = document.getElementById('mv-verdict-buttons');
  const inlineForm = document.getElementById('mv-inline-form');
  const chosenBadge = document.getElementById('mv-chosen-badge');
  const confirmInline = document.getElementById('mv-confirm-inline');
  const safeInline = document.getElementById('mv-safe-inline');

  if (choice.verdict) {
    if (verdictBtns) verdictBtns.classList.add('hidden');
    if (chosenBadge) {
      chosenBadge.classList.remove('hidden');
      const chosenText = document.getElementById('mv-chosen-text');
      const labels = { confirm_scam: 'Confirm Scam', investigate: 'Investigate Further', verify_safe: 'Verified Safe' };
      if (chosenText) chosenText.textContent = labels[choice.verdict] || choice.verdict;
      chosenBadge.dataset.verdict = choice.verdict;
    }
    if (inlineForm) {
      if (choice.verdict === 'confirm_scam') {
        inlineForm.classList.remove('hidden');
        if (confirmInline) confirmInline.classList.remove('hidden');
        if (safeInline) safeInline.classList.add('hidden');
        const tpl = document.getElementById('mv-remediation-template');
        const plan = document.getElementById('mv-remediation-plan');
        if (tpl) tpl.value = choice.template || 'Investment Scam';
        if (plan) plan.value = choice.notes || '';
      } else if (choice.verdict === 'verify_safe') {
        inlineForm.classList.remove('hidden');
        if (confirmInline) confirmInline.classList.add('hidden');
        if (safeInline) safeInline.classList.remove('hidden');
        const tpl = document.getElementById('mv-safe-template');
        const plan = document.getElementById('mv-safe-notes');
        if (tpl) tpl.value = choice.template || 'Legitimate Business';
        if (plan) plan.value = choice.notes || '';
      } else {
        inlineForm.classList.add('hidden');
      }
    }
  } else {
    if (verdictBtns) verdictBtns.classList.remove('hidden');
    if (chosenBadge) chosenBadge.classList.add('hidden');
    if (inlineForm) inlineForm.classList.add('hidden');
  }

  const nextBtn = document.getElementById('mv-btn-next');
  if (nextBtn) {
    const isLast = _mvCursor === total - 1;
    nextBtn.innerHTML = isLast
      ? 'Submit All <svg class="btn-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
      : 'Next <svg class="btn-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
  }

  const prevBtn = document.getElementById('mv-btn-prev');
  if (prevBtn) prevBtn.disabled = _mvCursor === 0;

  if (isInlineEmbed) { _inlineLastSentHeight = 0; scheduleInlineResize(); }
}

/**
 * Saves current choice from the inline form fields.
 */
function _mvSaveChoice(verdict) {
  if (!_mvChoices[_mvCursor]) return;
  _mvChoices[_mvCursor].verdict = verdict;
  if (verdict === 'confirm_scam') {
    _mvChoices[_mvCursor].template = document.getElementById('mv-remediation-template')?.value || 'Investment Scam';
    _mvChoices[_mvCursor].notes = document.getElementById('mv-remediation-plan')?.value || '';
  } else if (verdict === 'verify_safe') {
    _mvChoices[_mvCursor].template = document.getElementById('mv-safe-template')?.value || 'Legitimate Business';
    _mvChoices[_mvCursor].notes = document.getElementById('mv-safe-notes')?.value || '';
  }
}

/**
 * Submits all individual verdicts as separate reports.
 */
async function _mvSubmitAll() {
  const nextBtn = document.getElementById('mv-btn-next');
  if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = 'Submitting\u2026'; }

  const storage = await chrome.storage.local.get(['suriin_user_email']);
  const expertEmail = storage.suriin_user_email || 'unknown';
  const expertName = expertEmail.split('@')[0];
  const suspectHandle = (document.getElementById('mv-suspect-handle')?.value || '').trim() || 'Unknown suspect';

  const payloads = [];
  for (let i = 0; i < _mvItems.length; i++) {
    const item = _mvItems[i];
    const choice = _mvChoices[i];
    if (!choice.verdict) continue;
    const baseData = {
      text:           String(item.text || '').substring(0, 5000),
      url:            lastScanData.url,
      riskScore:      Number(item.score ?? 0) / 100,
      riskMessage:    lastScanData.message,
      sourceIdentifier: suspectHandle,
      aiConfidence:   typeof item.ai_scan?.ai_confidence === 'number' ? item.ai_scan.ai_confidence : (lastScanData.ai_confidence || 0),
      triggerTokens:  Array.isArray(item.ai_scan?.trigger_tokens) ? item.ai_scan.trigger_tokens : (lastScanData.trigger_tokens || []),
      matchedCompany: item.watchlist?.matched_company || lastScanData.matched_company || null
    };
    if (choice.verdict === 'confirm_scam') {
      payloads.push({
        action: 'EXPERT_CONFIRM_SCAM',
        data: { ...baseData, remediationTemplate: choice.template, remediationPlan: choice.notes,
          expertNotes: `Multi-verdict: Confirm Scam. Template: ${choice.template}. Analyst: "@${expertName}".` }
      });
    } else if (choice.verdict === 'verify_safe') {
      payloads.push({
        action: 'EXPERT_VERIFY_SAFE',
        data: { ...baseData, safetyTemplate: choice.template, safetyNotes: choice.notes,
          expertNotes: `Multi-verdict: Verified Safe. Template: ${choice.template}. Analyst: "@${expertName}".` }
      });
    } else if (choice.verdict === 'investigate') {
      payloads.push({
        action: 'EXPERT_INVESTIGATE',
        data: { ...baseData, investigationNotes: `Multi-verdict: Investigate Further. Analyst: "@${expertName}".` }
      });
    }
  }

  if (payloads.length === 0) {
    alert('Please choose a verdict for at least one text before submitting.');
    if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = 'Submit All'; }
    return;
  }

  try {
    const responses = await Promise.all(payloads.map((p) => chrome.runtime.sendMessage(p)));
    const allOk = responses.every((r) => r?.success);
    if (allOk) {
      const mvSuccess = document.getElementById('mv-success');
      const mvSuccessDesc = document.getElementById('mv-success-desc');
      const counts = { confirm_scam: 0, verify_safe: 0, investigate: 0 };
      _mvChoices.forEach(c => { if (c.verdict && counts[c.verdict] !== undefined) counts[c.verdict]++; });
      const parts = [];
      if (counts.confirm_scam) parts.push(`${counts.confirm_scam} Confirmed Scam`);
      if (counts.verify_safe) parts.push(`${counts.verify_safe} Verified Safe`);
      if (counts.investigate) parts.push(`${counts.investigate} Under Investigation`);
      if (mvSuccessDesc) mvSuccessDesc.textContent = parts.join(' · ');

      document.getElementById('mv-individual-section')?.classList.add('hidden');
      document.querySelector('.mv-toggle-bar')?.style.setProperty('display', 'none');
      if (mvSuccess) mvSuccess.classList.remove('hidden');
      _forceSuccessResize(mvSuccess);
      if (isInlineEmbed) notifyInlineSuccess('multi_verdict');
    } else {
      const failed = responses.find((r) => !r?.success);
      alert('Some reports failed: ' + (failed?.error || 'Unknown error'));
      if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = 'Submit All'; }
    }
  } catch (err) {
    console.error('[SuriinAI] Multi-verdict submit error:', err);
    alert('Failed to submit reports. Please try again.');
    if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = 'Submit All'; }
  }
}

/**
 * Opens the expert investigation form and pre-fills fields.
 */
function openInvestigateForm() {
  const confidencePct = Math.round((lastScanData.confidence ?? 0) * 100);
  const truncatedUrl = lastScanData.url.length > 40
    ? lastScanData.url.substring(0, 37) + '…'
    : lastScanData.url || '—';
  const truncatedText = lastScanData.text.length > 200
    ? lastScanData.text.substring(0, 197) + '…'
    : lastScanData.text || '—';

  // Restore form elements in case a previous submission hid them
  const formElements = viewExpertInvestigate.querySelectorAll(
    '.form-prefill-group, .form-prefill, .form-group, #btn-submit-expert-investigate'
  );
  formElements.forEach(el => el.style.display = '');
  if (btnSubmitExpertInvestigate) {
    btnSubmitExpertInvestigate.disabled = false;
    btnSubmitExpertInvestigate.textContent = '🔍 Start Investigation';
  }

  // Pre-fill investigation form
  document.getElementById('investigate-prefill-url').textContent = truncatedUrl;
  document.getElementById('investigate-prefill-url').title = lastScanData.url;
  document.getElementById('investigate-prefill-score').textContent = `${confidencePct}%`;
  document.getElementById('investigate-prefill-text').textContent = truncatedText;

  // Reset form state
  document.getElementById('investigate-suspect-handle').value = '';
  investigateSuccess.classList.add('hidden');
  showView(viewExpertInvestigate);
}

/**
 * Handles expert "Investigate Further" submission.
 * Creates report with status 'Investigating' and assigns to current expert.
 */
async function handleInvestigateSubmit() {
  showView(viewExpertInvestigate);
  const formElements = viewExpertInvestigate.querySelectorAll(
    '.form-prefill-group, .form-prefill, .form-group, #btn-submit-expert-investigate'
  );
  formElements.forEach(el => el.style.display = 'none');
  investigateSuccess.classList.add('hidden');

  const submitBtn = btnSubmitExpertInvestigate;
  const expertNotes = 'Initial discovery via extension. Deep-dive pending.';

  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = 'Starting Investigation…';

  // Build one payload per unique flagged text (or fall back to single report)
  const _rawFlagged = Array.isArray(lastScanData.flaggedResults) ? lastScanData.flaggedResults : [];
  const _seenKeys = new Set();
  const _deduped = _rawFlagged.filter((r) => {
    const k = String(r.text || '').trim();
    if (!k || _seenKeys.has(k)) return false;
    _seenKeys.add(k);
    return true;
  });

  const payloads = _deduped.length > 0
    ? _deduped.map((r) => ({
        action: 'EXPERT_INVESTIGATE',
        data: {
          text:               String(r.text || '').substring(0, 5000),
          url:                lastScanData.url,
          riskScore:          Number(r.score ?? 0) / 100,
          riskMessage:        lastScanData.message,
          sourceIdentifier:   'Unknown suspect',
          investigationNotes: expertNotes,
          userContext:        'Expert Investigation Started',
          aiConfidence:       typeof r.ai_scan?.ai_confidence === 'number' ? r.ai_scan.ai_confidence : (lastScanData.ai_confidence || 0),
          triggerTokens:      Array.isArray(r.ai_scan?.trigger_tokens) ? r.ai_scan.trigger_tokens : (lastScanData.trigger_tokens || []),
          matchedCompany:     r.watchlist?.matched_company || lastScanData.matched_company || null
        }
      }))
    : [{
        action: 'EXPERT_INVESTIGATE',
        data: {
          text:               lastScanData.text.substring(0, 5000),
          url:                lastScanData.url,
          riskScore:          lastScanData.confidence,
          riskMessage:        lastScanData.message,
          sourceIdentifier:   'Unknown suspect',
          investigationNotes: expertNotes,
          userContext:        'Expert Investigation Started',
          aiConfidence:       lastScanData.ai_confidence || 0,
          triggerTokens:      lastScanData.trigger_tokens || [],
          matchedCompany:     lastScanData.matched_company || null
        }
      }];

  try {
    const responses = await Promise.all(payloads.map((p) => chrome.runtime.sendMessage(p)));
    const allOk = responses.every((r) => r?.success);

    if (allOk) {
      investigateSuccess.classList.remove('hidden');
      _forceSuccessResize(investigateSuccess);
      if (isInlineEmbed) notifyInlineSuccess('investigate');
    } else {
      const failed = responses.find((r) => !r?.success);
      alert('Failed to start investigation: ' + (failed?.error || 'Unknown error'));
      formElements.forEach(el => el.style.display = '');
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  } catch (err) {
    console.error('[SuriinAI] Investigation start error:', err);
    alert('Failed to start investigation. Please try again.');
    formElements.forEach(el => el.style.display = '');
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

/**
 * Opens the appropriate dashboard based on user role.
 * Users → /user-dashboard
 * Experts → /expert-dashboard
 */
function openDashboardForRole() {
  chrome.tabs.create({ url: WEB_APP_URL + getDashboardPathForRole(userRole) });
}

function openExpertDashboard() {
  chrome.tabs.create({ url: WEB_APP_URL + getDashboardPathForRole('expert') });
}

function openExpertResolved() {
  chrome.tabs.create({ url: WEB_APP_URL + '/expert-resolved' });
}

// ══════════════════════════════════════════════════════════════════════════════
//  NOTIFICATION SYSTEM
// ══════════════════════════════════════════════════════════════════════════════

/** In-memory cache of the last-loaded notifications (used for mark-all) */
let _cachedNotifications = [];

/**
 * Checks for unread notifications via the background script
 * and updates the bell badge in the header.
 * Only counts notifications where isRead === false.
 */
async function checkNotificationBadge() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'CHECK_NOTIFICATIONS' });
    if (response?.success) {
      const all = response.notifications || [];
      // Apply same role filter so badge only counts role-relevant unread
      const filtered = _filterNotificationsByRole(all);
      const unread = filtered.filter(n => !n.isRead).length;
      _updateBadgeCount(unread);
    } else {
      _updateBadgeCount(0);
    }
  } catch (err) {
    console.log('[SuriinAI] Notification check skipped:', err.message);
  }
}

/**
 * Updates the bell badge DOM element.
 * @param {number} count - Number of unread notifications
 */
function _updateBadgeCount(count) {
  if (!notifBadge) return;
  if (count > 0) {
    notifBadge.textContent = count > 9 ? '9+' : String(count);
    notifBadge.classList.remove('hidden');
  } else {
    notifBadge.classList.add('hidden');
  }
}

/**
 * Filters notifications by current user role:
 * - expert/admin: only 'new_report' type
 * - user: everything except 'new_report'
 * @param {Array} notifications
 * @returns {Array}
 */
function _filterNotificationsByRole(notifications) {
  if (!Array.isArray(notifications)) return [];
  if (isExpertRole()) {
    return notifications.filter(n => n.type === 'new_report');
  }
  return notifications.filter(n => n.type !== 'new_report');
}

/**
 * Loads, role-filters, caps at 5, and renders notifications in the panel.
 */
async function loadNotifications() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'CHECK_NOTIFICATIONS' });
    const raw = response?.notifications || [];

    // Role filter + cap at 5 most recent
    const filtered = _filterNotificationsByRole(raw).slice(0, 5);
    _cachedNotifications = filtered;

    notifList.innerHTML = '';

    if (filtered.length === 0) {
      notifEmpty.style.display = 'flex';
      if (btnMarkAllNotif) btnMarkAllNotif.classList.add('hidden');
      return;
    }

    notifEmpty.style.display = 'none';

    // Show mark-all only if there are any unread
    const hasUnread = filtered.some(n => !n.isRead);
    if (btnMarkAllNotif) {
      btnMarkAllNotif.classList.toggle('hidden', !hasUnread);
    }

    filtered.forEach(notif => {
      const item = document.createElement('div');
      item.className = `notif-item${notif.isRead ? ' is-read' : ''}`;
      item.dataset.notifId = notif.id || '';

      item.innerHTML = `
        <div class="notif-item-msg">
          ${notif.isRead ? '' : '<span class="notif-item-dot"></span>'}
          <span class="notif-item-text">${escapeHtml(notif.message || 'Notification')}</span>
        </div>
        <div class="notif-item__footer">
          <span class="notif-item-time">${formatTimeAgo(notif.created_at)}</span>
          <button class="notif-item__mark-read" title="Mark as read" aria-label="Mark as read">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><polyline points="20 6 9 17 4 12"/></svg>
            Mark read
          </button>
        </div>
      `;

      // Individual mark-as-read button
      const markBtn = item.querySelector('.notif-item__mark-read');
      if (markBtn) {
        // Hide button for already read notifications
        if (notif.isRead) {
          markBtn.style.display = 'none';
        }
        markBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (notif.isRead) return;
          await _markOneRead(item, notif);
        });
      }

      // Click anywhere on item → mark as read + open dashboard with report_id
      item.addEventListener('click', async () => {
        const rid = notif.reportId || notif.report_id;
        if (!notif.isRead) {
          await _markOneRead(item, notif);
        }
        if (rid) {
          const dashPath = getDashboardPathForRole(userRole);
          chrome.tabs.create({ url: `${WEB_APP_URL}${dashPath}?report_id=${rid}` });
        }
      });

      notifList.appendChild(item);
    });

  } catch (err) {
    console.log('[SuriinAI] Notification load error:', err.message);
    notifEmpty.style.display = 'flex';
    if (btnMarkAllNotif) btnMarkAllNotif.classList.add('hidden');
  }
}

/**
 * Marks a single notification as read: updates DOM optimistically,
 * fires Firestore write via background, refreshes badge.
 */
async function _markOneRead(itemEl, notif) {
  // Optimistic DOM update
  itemEl.classList.add('is-read');
  const dot = itemEl.querySelector('.notif-item-dot');
  if (dot) dot.remove();
  notif.isRead = true;

  // Refresh badge immediately
  const unread = _cachedNotifications.filter(n => !n.isRead).length;
  _updateBadgeCount(unread);
  if (btnMarkAllNotif) btnMarkAllNotif.classList.toggle('hidden', unread === 0);

  // Write to Firestore via background
  if (notif.id) {
    try {
      await chrome.runtime.sendMessage({
        action: 'MARK_NOTIFICATION_READ',
        notificationId: notif.id
      });
    } catch (err) {
      console.log('[SuriinAI] Mark read failed:', err.message);
    }
  }
}

/**
 * Marks all unread notifications as read.
 */
async function handleMarkAllNotificationsRead() {
  const unread = _cachedNotifications.filter(n => !n.isRead);
  if (unread.length === 0) return;

  // Optimistic DOM update — mark every item as read
  unread.forEach(notif => {
    notif.isRead = true;
    const el = notifList.querySelector(`[data-notif-id="${notif.id}"]`);
    if (el) {
      el.classList.add('is-read');
      const dot = el.querySelector('.notif-item-dot');
      if (dot) dot.remove();
    }
  });

  _updateBadgeCount(0);
  if (btnMarkAllNotif) btnMarkAllNotif.classList.add('hidden');

  // Write all to Firestore via background
  const ids = unread.map(n => n.id).filter(Boolean);
  if (ids.length) {
    try {
      await chrome.runtime.sendMessage({
        action: 'MARK_ALL_NOTIFICATIONS_READ',
        notificationIds: ids
      });
    } catch (err) {
      console.log('[SuriinAI] Mark all read failed:', err.message);
    }
  }
}

function formatTimeAgo(isoString) {
  if (!isoString) return '';
  try {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch { return ''; }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ══════════════════════════════════════════════════════════════════════════════
//  HYBRID AUTHENTICATION — Guest vs. Authenticated UI
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Applies visual state to the UI based on authentication status.
 * Guest: shows banner, locks report/dashboard buttons, hides notif bell.
 * Authenticated: hides banner, unlocks everything, shows notif bell.
 * @param {boolean} authenticated
 */
function applyAuthStateToUI(authenticated) {
  const lockTargets = [btnExpertReview, btnReportEvidence];
  const lockIcons = document.querySelectorAll('.btn-lock-icon');

  if (authenticated) {
    // — Authenticated Mode —
    if (guestModeBanner) guestModeBanner.classList.add('hidden');
    if (guestLoginPrompt) guestLoginPrompt.classList.add('hidden');

    // Unlock buttons
    lockTargets.forEach(btn => {
      if (btn) btn.classList.remove('btn-locked');
    });
    lockIcons.forEach(icon => icon.classList.add('hidden'));
    if (btnDashboard) btnDashboard.classList.remove('btn-locked');

    // Show notification bell
    if (btnNotifBell) btnNotifBell.style.display = '';

  } else {
    // — Guest Mode —
    if (guestModeBanner) guestModeBanner.classList.remove('hidden');

    // Lock expert/report buttons
    lockTargets.forEach(btn => {
      if (btn) btn.classList.add('btn-locked');
    });
    lockIcons.forEach(icon => icon.classList.remove('hidden'));
    if (btnDashboard) btnDashboard.classList.add('btn-locked');

    // Hide notification bell (guests have no notifications)
    if (btnNotifBell) btnNotifBell.style.display = 'none';
  }
}

/**
 * Shows the guest login prompt card in the result view.
 */
function showGuestLoginPrompt() {
  if (guestLoginPrompt) {
    guestLoginPrompt.classList.remove('hidden');
    // Re-trigger the animation
    guestLoginPrompt.style.animation = 'none';
    void guestLoginPrompt.offsetWidth;
    guestLoginPrompt.style.animation = '';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-SCAN CONSENT MODAL
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Checks chrome.storage.local for the hasAgreedToAutoScan flag.
 * @returns {Promise<boolean>} true if consent has been given
 */
async function checkAutoScanConsent() {
  try {
    const stored = await chromeStorageLocalGet([STORAGE_KEY_AUTO_SCAN_CONSENT]);
    return stored[STORAGE_KEY_AUTO_SCAN_CONSENT] === true;
  } catch {
    return false;
  }
}

/**
 * Shows the one-time consent modal for Auto-Scan.
 * Does NOT change the radio selection — that happens only on consent.
 */
function showAutoScanConsentModal() {
  if (modalAutoScanConsent) {
    modalAutoScanConsent.classList.remove('hidden');
  }
}

/**
 * [Agree & Enable] handler:
 * Saves consent flag, closes modal, activates auto-scan mode.
 */
async function handleConsentAgree() {
  // Save consent permanently
  await chromeStorageLocalSet({ [STORAGE_KEY_AUTO_SCAN_CONSENT]: true });

  // Close modal
  if (modalAutoScanConsent) modalAutoScanConsent.classList.add('hidden');

  // Now activate auto mode (bypass the consent check since we just agreed)
  currentScanMode = 'auto';
  await chromeStorageSet({ [STORAGE_KEY_SCAN_MODE]: 'auto' });
  syncRadioUI('auto');
  applyModeToUI('auto');
  chrome.runtime.sendMessage({ action: 'START_AUTO_SCAN' });

  console.log('[SuriinAI] Auto-Scan consent granted, mode activated.');
}

/**
 * [Cancel] handler:
 * Closes modal, keeps the previous scan mode.
 */
function handleConsentCancel() {
  if (modalAutoScanConsent) modalAutoScanConsent.classList.add('hidden');

  // Revert radio UI back to whatever mode was active before
  syncRadioUI(currentScanMode);
  console.log('[SuriinAI] Auto-Scan consent declined.');
}

// ── UI HELPERS ────────────────────────────────────────────────────────────────

function showLoadingState(isLoading) {
  if (isLoading) {
    loadingState.classList.remove('hidden');
    btnScan.disabled = true;
    btnScan.style.opacity = '0.5';
  } else {
    loadingState.classList.add('hidden');
    btnScan.disabled = false;
    btnScan.style.opacity = '1';
  }
}

// ── CHROME STORAGE HELPERS ────────────────────────────────────────────────────

function chromeStorageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result);
    });
  });
}

function chromeStorageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(items, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

function chromeStorageClear() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.clear(() => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// ── CHROME STORAGE LOCAL HELPERS (for consent flags) ──────────────────────────

function chromeStorageLocalGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result);
    });
  });
}

function chromeStorageLocalSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}
