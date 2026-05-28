/**
 * expert-dashboard.js — Active triage workflow for expert users.
 */

'use strict';

let triageReports = [];
let selectedReportId = null;
let selectedReport = null;
let currentExpertId = null;
let resolvedTodayCount = 0;
let allReports = [];
let platformChart = null;
let pendingAction = null;

/**
 * formatReporterID — Anonymize user UID to #USR-<FIRST_6_CHARS>
 */
function formatReporterID(uid) {
  if (!uid) return '#USR-UNKNOWN';
  const first6 = String(uid).substring(0, 6).toUpperCase();
  return `#USR-${first6}`;
}

/**
 * formatDateForTimeline — Format date for resolution history timeline
 * Returns: MM/DD/YYYY<br>HH:MM AM/PM
 */
function formatDateForTimeline(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    // Format: MM/DD/YYYY with leading zeros
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const year = d.getFullYear();
    const date = `${month}/${day}/${year}`;
    // Time on next line: HH:MM AM/PM
    const time = d.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
    return `${date}<br>${time}`;
  } catch {
    return isoString;
  }
}

// ── Template helpers ─────────────────────────────────────────────────────────
function getSafetyTemplateText(key) {
  switch (key) {
    case 'verified_sender':
      return 'Headers, SPF/DKIM/DMARC, and domain reputation checks confirm legitimacy. No phishing indicators present.';
    case 'matches_pattern':
      return "Message structure, contact channels, and prior communications align with the user's trusted provider. No malicious payloads detected.";
    case 'benign_content':
      return 'No social engineering markers, suspicious links, or credential prompts. Content and metadata consistent with routine updates.';
    default:
      return '';
  }
}

function getRemediationTemplateText(key) {
  switch (key) {
    case 'account_security':
      return 'Change passwords, enable MFA, and review recent logins. Revoke suspicious sessions and update security questions.';
    case 'financial_device':
      return 'Contact your bank/fraud department, monitor statements, and run a reputable anti-malware scan.';
    case 'report_block':
      return 'Block the sender/domain, report the message on-platform, and avoid any links or attachments.';
    default:
      return '';
  }
}

window.addEventListener('suriin:auth-ready', async (e) => {
  const { role, user } = e.detail;

  if (role !== 'expert') {
    window.location.href = getRoleHome(role);
    return;
  }

  currentExpertId = user.uid;
  ensureOverlayHidden();

  setupModalControls();
  setupActions();

  await loadAllReports();
  await loadTriageReports();
  await loadResolvedTodayCount();
  await loadAnalytics();
  renderStats();

  // ── Open modal from URL param (if present) ──────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const targetReportId = params.get('report_id');
  if (targetReportId) {
    setTimeout(async () => {
      await openReviewModal(targetReportId);
      window.history.replaceState({}, document.title, window.location.pathname);
    }, 800);
  }
});

function setupActions() {
  const submitReviewBtn    = document.getElementById('submit-review-btn');
  const claimBtn           = document.getElementById('claim-investigation-btn');
  const dismissBtn         = document.getElementById('dismiss-btn');
  const sortSelect         = document.getElementById('sort-risk');
  const platformFilter     = document.getElementById('filter-platform');
  const statusFilter       = document.getElementById('filter-status');
  const remPlanEl          = document.getElementById('modal-remediation-plan');
  const verdictToggles     = document.querySelectorAll('.verdict-toggle');

  if (submitReviewBtn)    submitReviewBtn.addEventListener('click', submitReview);
  if (claimBtn)           claimBtn.addEventListener('click', claimInvestigation);
  if (sortSelect)         sortSelect.addEventListener('change', renderTriageTable);
  if (platformFilter)     platformFilter.addEventListener('change', renderTriageTable);
  if (statusFilter)       statusFilter.addEventListener('change', renderTriageTable);

  // ── Binary Verdict Toggle Buttons ──────────────────────────────────────────
  if (verdictToggles.length > 0) {
    verdictToggles.forEach(toggle => {
      toggle.addEventListener('click', () => {
        const verdict = toggle.dataset.verdict; // 'Verified Safe' or 'Confirmed Threat'
        const statusInput = document.getElementById('modal-status');
        const notesEl = document.getElementById('modal-expert-notes');
        const safetySection = document.getElementById('safety-justification-section');
        const safetyEl = document.getElementById('modal-safety-justification');
        const remPlanEl = document.getElementById('modal-remediation-plan');
        const remSection = document.getElementById('remediation-plan-section');
        const overrideBanner = document.getElementById('override-warning-banner');

        // Update hidden input
        if (statusInput) statusInput.value = verdict;

        // Update active state on buttons
        verdictToggles.forEach(t => t.classList.remove('active'));
        toggle.classList.add('active');


        if (verdict === 'Verified Safe') {
          // Show Safety Justification, hide and clear Remediation Plan
          if (safetySection) safetySection.style.display = 'block';
          if (remSection) remSection.style.display = 'none';
          if (remPlanEl) remPlanEl.value = '';

          // Show override warning if AI risk was critical
          const aiRiskLevel = selectedReport?.risk_level || selectedReport?.aiRiskLevel || '';
          const aiRiskScore = selectedReport?.risk_score || 0;
          const isCriticalAI = aiRiskLevel === 'critical' || aiRiskScore > 0.7;
          if (overrideBanner) overrideBanner.style.display = isCriticalAI ? 'block' : 'none';

        } else if (verdict === 'Confirmed Threat') {
          // Show Remediation Plan; hide and clear Safety Justification
          if (remSection) remSection.style.display = 'block';
          if (safetySection) safetySection.style.display = 'none';
          if (safetyEl) safetyEl.value = '';
          // Hide override warning for Confirmed Threat
          if (overrideBanner) overrideBanner.style.display = 'none';
        }

        // Update submit button state
        validateSubmitButton();
      });
    });
  }

  // ── Remediation Plan Validation ───────────────────────────────────────────
  if (remPlanEl) {
    remPlanEl.addEventListener('input', validateSubmitButton);
  }

  // ── Safety Justification Validation ───────────────────────────────────────
  const safetyEl = document.getElementById('modal-safety-justification');
  if (safetyEl) {
    safetyEl.addEventListener('input', validateSubmitButton);
  }

  // ── Quick Templates: Safety Justification ─────────────────────────────────
  const safetyTpl = document.getElementById('safety-templates');
  if (safetyTpl) {
    safetyTpl.addEventListener('change', () => {
      const val = safetyTpl.value;
      if (!val) return;
      const target = document.getElementById('modal-safety-justification');
      if (target) {
        target.value = getSafetyTemplateText(val);
        target.focus();
        validateSubmitButton();
      }
    });
  }

  // ── Quick Templates: Remediation Plan ─────────────────────────────────────
  const remTpl = document.getElementById('remediation-templates');
  if (remTpl) {
    remTpl.addEventListener('change', () => {
      const val = remTpl.value;
      if (!val) return;
      const target = document.getElementById('modal-remediation-plan');
      if (target) {
        target.value = getRemediationTemplateText(val);
        target.focus();
        validateSubmitButton();
      }
    });
  }

  function validateSubmitButton() {
    const statusInput = document.getElementById('modal-status');
    const remPlanEl = document.getElementById('modal-remediation-plan');
    const remSection = document.getElementById('remediation-plan-section');
    const safetyEl = document.getElementById('modal-safety-justification');
    const safetySection = document.getElementById('safety-justification-section');
    const submitBtn = document.getElementById('submit-review-btn');
    const hint = document.getElementById('remediation-required-hint');
    const safetyHint = document.getElementById('safety-required-hint');

    if (!submitBtn) return;

    const verdict = statusInput ? statusInput.value : '';
    const hasVerdict = ['Verified Safe', 'Confirmed Threat'].includes(verdict);
    const hasRemediation = remPlanEl ? remPlanEl.value.trim().length > 0 : false;
    const isRemVisible = remSection && remSection.style.display !== 'none';
    const hasSafety = safetyEl ? safetyEl.value.trim().length > 0 : false;
    const isSafetyVisible = safetySection && safetySection.style.display !== 'none';

    // Requirements
    const safeValid = verdict === 'Verified Safe' ? hasSafety : true;
    const threatValid = verdict === 'Confirmed Threat' ? (!isRemVisible || hasRemediation) : true;
    const resolveValid = hasVerdict && safeValid && threatValid;

    submitBtn.disabled = !resolveValid;
    if (hint) hint.style.display = (hasVerdict && verdict === 'Confirmed Threat' && isRemVisible && !hasRemediation) ? '' : 'none';
    if (safetyHint) safetyHint.style.display = (hasVerdict && verdict === 'Verified Safe' && isSafetyVisible && !hasSafety) ? '' : 'none';

    if (!resolveValid) {
      submitBtn.style.opacity = '0.5';
      submitBtn.style.cursor = 'not-allowed';
    } else {
      submitBtn.style.opacity = '1';
      submitBtn.style.cursor = 'pointer';
    }
  }

  // ── Tabs & Pagination ──────────────────────────────────────────────────────
  const tabAll = document.getElementById('tab-all-reports');
  const tabMine = document.getElementById('tab-my-investigations');
  const btnPrev = document.getElementById('pagination-prev');
  const btnNext = document.getElementById('pagination-next');

  if (tabAll && tabMine) {
    const statusFilterLabel = document.getElementById('status-filter-label');
    const statusFilter = document.getElementById('filter-status');

    function updateTabStyles() {
      const isAll = currentTab === 'all';
      tabAll.style.borderBottomColor = isAll ? 'var(--clr-accent)' : 'transparent';
      tabAll.style.color = isAll ? 'var(--clr-accent)' : 'var(--clr-text-secondary)';
      tabMine.style.borderBottomColor = !isAll ? 'var(--clr-accent)' : 'transparent';
      tabMine.style.color = !isAll ? 'var(--clr-accent)' : 'var(--clr-text-secondary)';

      // Hide status filter in "My Investigations" tab (all are investigating)
      if (statusFilterLabel) statusFilterLabel.style.display = isAll ? '' : 'none';
      if (statusFilter) statusFilter.style.display = isAll ? '' : 'none';
    }
    // Set initial styles
    updateTabStyles();
    tabAll.addEventListener('click', () => {
      currentTab = 'all';
      triageCurrentPage = 1;
      updateTabStyles();
      renderTriageTable();
    });
    tabMine.addEventListener('click', () => {
      currentTab = 'mine';
      triageCurrentPage = 1;
      updateTabStyles();
      renderTriageTable();
    });
  }

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (triageCurrentPage > 1) {
        triageCurrentPage--;
        renderTriageTable();
      }
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      triageCurrentPage++;
      renderTriageTable();
    });
  }

}

// (Deprecated) getVerdictTemplates removed in favor of explicit Quick Templates

// Mark for dismissal without writing to Firestore; prefill notes and enable submit
function prepareDismiss() {
  if (!selectedReportId || !selectedReport) return;
  pendingAction = 'dismiss';

  const statusInput = document.getElementById('modal-status');
  const notesEl = document.getElementById('modal-expert-notes');
  const remPlanEl = document.getElementById('modal-remediation-plan');
  const remSection = document.getElementById('remediation-plan-section');
  const verdictToggles = document.querySelectorAll('.verdict-toggle');

  // Clear verdict selection since this is a dismissal
  if (statusInput) statusInput.value = '';
  if (verdictToggles && verdictToggles.length) verdictToggles.forEach(t => t.classList.remove('active'));

  // Replace notes content with dismissal template on every click
  if (notesEl) {
    notesEl.value = 'Dismissed as Invalid. Reason: ';
    notesEl.focus();
  }

  // Hide remediation plan area for dismissals
  if (remSection) remSection.style.display = 'none';
  if (remPlanEl) remPlanEl.value = '';

  // Enable submit button since a decision (dismiss) is selected
  const submitBtn = document.getElementById('submit-review-btn');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.style.opacity = '1';
    submitBtn.style.cursor = 'pointer';
  }
  try { (function(){
    const statusInput = document.getElementById('modal-status');
    const remPlanEl = document.getElementById('modal-remediation-plan');
    const remSection = document.getElementById('remediation-plan-section');
    const submitBtn = document.getElementById('submit-review-btn');
    const hint = document.getElementById('remediation-required-hint');

    if (!submitBtn) return;

    const verdict = statusInput ? statusInput.value : '';
    const hasVerdict = ['Verified Safe', 'Confirmed Threat'].includes(verdict);
    const hasRemediation = remPlanEl ? remPlanEl.value.trim().length > 0 : false;
    const isRemVisible = remSection && remSection.style.display !== 'none';

    const resolveValid = hasVerdict && (verdict === 'Verified Safe' || (isRemVisible ? hasRemediation : true));

    submitBtn.disabled = !resolveValid;
    if (hint) hint.style.display = (hasVerdict && verdict === 'Confirmed Threat' && isRemVisible && !hasRemediation) ? '' : 'none';

    submitBtn.style.opacity = resolveValid ? '1' : '0.5';
    submitBtn.style.cursor = resolveValid ? 'pointer' : 'not-allowed';
  })(); } catch(_) {}
}

/**
 * dismissReport — dismisses the report as a false positive
 * Sets status to 'Dismissed', verdict to 'False Positive'
 * Does not require remediation plan
 */
async function dismissReport() {
  // New unified flow: this button only marks intent and pre-fills notes.
  prepareDismiss();
}

function setupModalControls() {
  const overlay = document.getElementById('review-modal-overlay');
  const closeBtn = document.getElementById('review-modal-close-btn');
  const cancelBtn = document.getElementById('review-modal-cancel-btn');

  if (closeBtn) closeBtn.addEventListener('click', closeReviewModalUI);
  if (cancelBtn) cancelBtn.addEventListener('click', closeReviewModalUI);

  if (overlay) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        closeReviewModalUI();
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isReviewModalOpen()) {
      closeReviewModalUI();
    }
  });
}

function openReviewModalUI() {
  const overlay = document.getElementById('review-modal-overlay');
  if (!overlay) return;

  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeReviewModalUI() {
  const overlay = document.getElementById('review-modal-overlay');
  if (!overlay) return;

  overlay.style.display = 'none';
  document.body.style.overflow = '';
}

function isReviewModalOpen() {
  const overlay = document.getElementById('review-modal-overlay');
  return Boolean(overlay && overlay.style.display !== 'none');
}

async function loadTriageReports() {
  const db = window.__suriinFirestore;
  if (!db) {
    console.error('[SuriinAI Expert] Firestore not available.');
    return;
  }

  try {
    const querySnapshot = await db.collection('Reports')
      .where('status', 'in', ['Unassigned', 'Pending', 'Under Review', 'Investigating', 'Under Investigation'])
      .get();

    triageReports = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.warn('[SuriinAI Expert] Compound status query unavailable, using fallback filter:', err);

    const fallbackSnapshot = await db.collection('Reports').get();
    triageReports = fallbackSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((report) => ['Unassigned', 'Pending', 'Under Review', 'Investigating', 'Under Investigation'].includes(report.status));
  }

  updatePlatformFilterOptions();
  renderTriageTable();
}

async function loadResolvedTodayCount() {
  const db = window.__suriinFirestore;
  if (!db || !currentExpertId) return;

  try {
    const snapshot = await db.collection('Reports')
      .where('reviewedBy', '==', currentExpertId)
      .get();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const seenIds = new Set();
    resolvedTodayCount = 0;

    snapshot.docs.forEach((doc) => {
      const report = doc.data() || {};
      if (report.status !== 'Resolved' && report.status !== 'Reviewed' && report.status !== 'Dismissed') return;
      const reviewedDate = new Date(report.reviewedAt || 0);
      if (Number.isNaN(reviewedDate.getTime()) || reviewedDate < today) return;
      if (!seenIds.has(doc.id)) {
        seenIds.add(doc.id);
        resolvedTodayCount++;
      }
    });
  } catch (err) {
    console.warn('[SuriinAI Expert] Unable to calculate resolved today count:', err);
    resolvedTodayCount = 0;
  }
}

function renderStats() {
  const pending = triageReports.filter((report) => report.status === 'Unassigned' || report.status === 'Pending').length;
  const myInvestigations = triageReports.filter((report) => (
    (report.status === 'Under Review' || report.status === 'Investigating' || report.status === 'Under Investigation') && report.assigned_to === currentExpertId
  )).length;

  setText('stat-pending', String(pending));
  setText('stat-my-investigating', String(myInvestigations));
  setText('stat-resolved-today', String(resolvedTodayCount));
}

function updatePlatformFilterOptions() {
  const filter = document.getElementById('filter-platform');
  if (!filter) return;

  const platforms = [...new Set(triageReports.map((report) => extractPlatform(report.url)))].sort();
  filter.innerHTML = '<option value="all">All Platforms</option>';

  platforms.forEach((platform) => {
    const opt = document.createElement('option');
    opt.value = platform;
    opt.textContent = platform;
    filter.appendChild(opt);
  });
}

let currentTab = 'all';
let triageCurrentPage = 1;
const reportsPerPage = 10;

// ── Helper function for validation ───────────────────────────────────────────
function validateSubmitButtonState() {
  const statusInput = document.getElementById('modal-status');
  const remPlanEl = document.getElementById('modal-remediation-plan');
  const remSection = document.getElementById('remediation-plan-section');
  const safetyEl = document.getElementById('modal-safety-justification');
  const safetySection = document.getElementById('safety-justification-section');
  const submitBtn = document.getElementById('submit-review-btn');
  const hint = document.getElementById('remediation-required-hint');
  const safetyHint = document.getElementById('safety-required-hint');

  if (!submitBtn) return;

  const verdict = statusInput ? statusInput.value : '';
  const hasVerdict = ['Verified Safe', 'Confirmed Threat'].includes(verdict);
  const hasRemediation = remPlanEl ? remPlanEl.value.trim().length > 0 : false;
  const isRemVisible = remSection && remSection.style.display !== 'none';

  const hasSafety = safetyEl ? safetyEl.value.trim().length > 0 : false;
  const isSafetyVisible = safetySection && safetySection.style.display !== 'none';

  const safeValid = verdict === 'Verified Safe' ? hasSafety : true;
  const threatValid = verdict === 'Confirmed Threat' ? (!isRemVisible || hasRemediation) : true;
  const isValid = hasVerdict && safeValid && threatValid;

  submitBtn.disabled = !isValid;
  if (hint) hint.style.display = (hasVerdict && verdict === 'Confirmed Threat' && isRemVisible && !hasRemediation) ? '' : 'none';
  if (safetyHint) safetyHint.style.display = (hasVerdict && verdict === 'Verified Safe' && isSafetyVisible && !hasSafety) ? '' : 'none';

  if (!isValid) {
    submitBtn.style.opacity = '0.5';
    submitBtn.style.cursor = 'not-allowed';
  } else {
    submitBtn.style.opacity = '1';
    submitBtn.style.cursor = 'pointer';
  }
}

function getVisibleReports() {
  const sortMode = document.getElementById('sort-risk')?.value || 'risk-desc';
  const platform = document.getElementById('filter-platform')?.value || 'all';
  const statusFilter = document.getElementById('filter-status')?.value || 'all';
  const auth = window.__suriinAuth;

  const filtered = triageReports.filter((report) => {
    if (platform !== 'all' && extractPlatform(report.url) !== platform) return false;
    if (statusFilter !== 'all' && normalizeStatus(report.status) !== statusFilter) return false;
    
    if (currentTab === 'mine') {
      if (!auth || !auth.user) return false;
      return report.assigned_to === auth.user.uid;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (sortMode === 'risk-asc') {
      return normalizeRisk(a.risk_score) - normalizeRisk(b.risk_score);
    }

    if (sortMode === 'newest') {
      return toMillis(b.created_at) - toMillis(a.created_at);
    }

    if (sortMode === 'oldest') {
      return toMillis(a.created_at) - toMillis(b.created_at);
    }

    return normalizeRisk(b.risk_score) - normalizeRisk(a.risk_score);
  });

  return filtered;
}

function renderTriageTable() {
  const tbody = document.getElementById('triage-tbody');
  const emptyState = document.getElementById('triage-empty');
  const countEl = document.getElementById('triage-count');
  const table = document.getElementById('triage-table');

  if (!tbody) return;

  const visibleReports = getVisibleReports();
  tbody.innerHTML = '';

  if (countEl) {
    countEl.textContent = `${visibleReports.length} case${visibleReports.length !== 1 ? 's' : ''}`;
  }

  if (!visibleReports.length) {
    if (table) table.style.display = 'none';
    if (emptyState) emptyState.style.display = '';
    const paginationContainer = document.getElementById('triage-pagination');
    if (paginationContainer) paginationContainer.style.display = 'none';
    return;
  }

  if (table) table.style.display = '';
  if (emptyState) emptyState.style.display = 'none';

  // --- Pagination Logic ---
  const totalPages = Math.ceil(visibleReports.length / reportsPerPage);
  if (triageCurrentPage > totalPages) triageCurrentPage = totalPages;
  if (triageCurrentPage < 1) triageCurrentPage = 1;

  const startIndex = (triageCurrentPage - 1) * reportsPerPage;
  const paginatedReports = visibleReports.slice(startIndex, startIndex + reportsPerPage);

  // Update Pagination UI
  const paginationContainer = document.getElementById('triage-pagination');
  const btnPrev = document.getElementById('pagination-prev');
  const btnNext = document.getElementById('pagination-next');
  const pageNumbersContainer = document.getElementById('pagination-numbers');

  if (paginationContainer) {
    paginationContainer.style.display = totalPages > 1 ? 'flex' : 'none';

    // Show/hide Previous button (hidden on page 1)
    if (btnPrev) btnPrev.style.display = triageCurrentPage > 1 ? 'inline-flex' : 'none';

    // Show/hide Next button (hidden on last page)
    if (btnNext) btnNext.style.display = triageCurrentPage < totalPages ? 'inline-flex' : 'none';

    // Generate page number buttons
    if (pageNumbersContainer) {
      pageNumbersContainer.innerHTML = '';
      for (let i = 1; i <= totalPages; i++) {
        const pageBtn = document.createElement('button');
        pageBtn.className = 'btn btn--sm';
        pageBtn.textContent = i;
        pageBtn.style.minWidth = '32px';
        pageBtn.style.padding = '4px 8px';
        pageBtn.style.borderRadius = '4px';
        pageBtn.style.fontSize = 'var(--font-xs)';
        pageBtn.style.fontWeight = '500';

        if (i === triageCurrentPage) {
          // Active page styling
          pageBtn.style.background = 'var(--clr-accent, #6C63FF)';
          pageBtn.style.color = '#fff';
          pageBtn.style.border = '1px solid var(--clr-accent, #6C63FF)';
        } else {
          // Inactive page styling
          pageBtn.style.background = 'transparent';
          pageBtn.style.color = 'var(--clr-text-secondary)';
          pageBtn.style.border = '1px solid var(--clr-border)';
          pageBtn.style.cursor = 'pointer';
          pageBtn.addEventListener('click', () => {
            triageCurrentPage = i;
            renderTriageTable();
          });
        }
        pageNumbersContainer.appendChild(pageBtn);
      }
    }
  }

  paginatedReports.forEach((report) => {
    const tr = document.createElement('tr');

    const risk = normalizeRisk(report.risk_score);
    const platform = extractPlatform(report.url);
    const rawStatusStr = report.status || 'Unassigned';
    const status = (rawStatusStr === 'Pending') ? 'Unassigned'
      : (rawStatusStr === 'Under Review' || rawStatusStr === 'Investigating') ? 'Under Investigation'
      : (rawStatusStr === 'Reviewed') ? 'Resolved'
      : rawStatusStr;
    // Construct row with requested column order:
    // Date | Platform | Threat Level | Risk Factors | Reporter | Assigned To | Status
    const platformDomain = report.url ? new URL(report.url).hostname.replace(/^www\./, '') : platform;
    const threatHtml = buildThreatBadge(risk);
    const factorsHtml = buildRiskFactorPills(report);
    const reporter = formatReporterID(report.user_id || report.reporter_email || report.reporter || 'anonymous');

    tr.dataset.reportId = report.id;
    tr.style.cursor = 'pointer';

    const assignedEmail = report.assigned_email || '';
    const assignedShort = assignedEmail ? '@' + String(assignedEmail).split('@')[0] : '—';

    tr.innerHTML = `
      <td>${escapeHtml(formatDate(report.created_at))}</td>
      <td style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;" title="${escapeHtml(platformDomain)}">${escapeHtml(platformDomain)}</td>
      <td>${threatHtml}</td>
      <td style="word-break: break-word; overflow-wrap: break-word;">${factorsHtml}</td>
      <td class="text-preview" title="${formatReporterID(report.user_id || report.reporter_email || '')}">${reporter}</td>
      <td>${escapeHtml(assignedShort)}</td>
      <td>${buildStatusBadge(status)}</td>
    `;

    tbody.appendChild(tr);
  });

  // Delegate row click -> open modal (preserve single-click behavior for row open)
  tbody.removeEventListener('click', rowClickHandler);
  tbody.addEventListener('click', rowClickHandler);

  renderStats();
}

async function rowClickHandler(event) {
  const tr = event.target.closest('tr');
  if (!tr || !tr.dataset || !tr.dataset.reportId) return;
  await openReviewModal(tr.dataset.reportId);
}

async function openReviewModal(reportId) {
  // Reset pending action state on each open
  pendingAction = null;
  // Try triageReports first
  let report = triageReports.find((item) => item.id === reportId);
  
  // If not found, try allReports
  if (!report) {
    report = allReports.find((item) => item.id === reportId);
  }
  
  // If still not found, fetch from Firestore
  if (!report) {
    try {
      const db = window.__suriinFirestore;
      if (db) {
        const doc = await db.collection('Reports').doc(reportId).get();
        if (doc.exists) {
          report = { id: doc.id, ...doc.data() };
          // Add to arrays for future use
          triageReports.push(report);
          allReports.push(report);
          // Re-render table to show the new report
          renderTriageTable();
        }
      }
    } catch (err) {
      console.error('[SuriinAI Expert] Failed to fetch report from Firestore:', err);
    }
  }
  
  if (!report) {
    showDashboardToast('Report not found. Please refresh the page.', 'error');
    return;
  }

  selectedReportId = reportId;
  selectedReport = report;

  const auth = window.__suriinAuth;
  const riskEl        = document.getElementById('modal-risk-score');
  const factorsEl     = document.getElementById('modal-risk-factors');
  const evidenceEl    = document.getElementById('modal-raw-evidence');
  const evidenceLinkEl = document.getElementById('modal-evidence-link');
  const imageWrapper  = document.getElementById('modal-image-wrapper');
  const imageEl       = document.getElementById('modal-image');
  const statusEl      = document.getElementById('modal-status');
  const notesEl       = document.getElementById('modal-expert-notes');
  const remPlanEl     = document.getElementById('modal-remediation-plan');
  const safetyEl      = document.getElementById('modal-safety-justification');
  const submitBtn     = document.getElementById('submit-review-btn');
  const claimBtn      = document.getElementById('claim-investigation-btn');
  const dismissBtn    = document.getElementById('dismiss-btn');

  const riskPercent  = Math.round(normalizeRisk(report.risk_score) * 100);
  const evidenceLink = String(report.url || report.link || '').trim();
  const imageSource  = String(report.imageUrl || report.image_url || '').trim();

  // ── Platform & Source Identifier ───────────────────────────────────────────
  const platformName = report.platform || normalizePlatform(report);
  const sourceIdentifier = report.source_identifier || 'Unknown suspect';
  const userContext = report.user_context || '';

  // ── Metadata Header ────────────────────────────────────────────────────────
  const modalTitle = document.getElementById('review-modal-title');
  const reportedByEl = document.getElementById('modal-reported-by');
  const assignedToEl = document.getElementById('modal-assigned-to');
  const statusBadgeEl = document.getElementById('modal-status-badge');
  const aiRiskBadgeEl = document.getElementById('modal-ai-risk-badge');

  // Dynamic title with Report ID
  if (modalTitle) modalTitle.textContent = `Case Review: #${reportId.slice(-6).toUpperCase()}`;

  // Date Submitted
  const dateSubmittedEl = document.getElementById('modal-date-submitted');
  if (dateSubmittedEl) dateSubmittedEl.textContent = report.created_at ? formatDate(report.created_at) : '—';

  // Reported by (anonymized)
  if (reportedByEl) {
    const reporterUID = report.user_id || 'unknown';
    const anonymizedID = formatReporterID(reporterUID);
    reportedByEl.textContent = `Reported by: ${anonymizedID}`;
  }

  // Assigned To (show if claimed, hide if not)
  if (assignedToEl) {
    if (report.assigned_to && report.assigned_email) {
      const assignedShort = '@' + String(report.assigned_email).split('@')[0];
      assignedToEl.textContent = `Assigned To: ${assignedShort}`;
      assignedToEl.style.display = '';
    } else {
      assignedToEl.style.display = 'none';
    }
  }

  // Status badge
  const statusForBadge = normalizeStatus(report.status);
  if (statusBadgeEl) {
    statusBadgeEl.textContent = statusForBadge;
    // Update badge color based on status
    statusBadgeEl.className = 'badge';
    if (statusForBadge === 'Under Investigation') {
      statusBadgeEl.style.background = 'rgba(108,99,255,0.15)';
      statusBadgeEl.style.color = '#6C63FF';
      statusBadgeEl.style.border = '1px solid rgba(108,99,255,0.3)';
    } else if (statusForBadge === 'Unassigned') {
      statusBadgeEl.style.background = 'rgba(245,158,11,0.15)';
      statusBadgeEl.style.color = '#f59e0b';
      statusBadgeEl.style.border = '1px solid rgba(245,158,11,0.3)';
    } else {
      statusBadgeEl.style.background = 'var(--clr-bg-secondary)';
      statusBadgeEl.style.color = 'var(--clr-text-secondary)';
    }
  }

  // AI Risk badge
  if (aiRiskBadgeEl) {
    let riskLabel = 'Safe';
    let riskColor = '#22c55e';
    let riskBg = 'rgba(34,197,94,0.15)';
    if (riskPercent >= 85) {
      riskLabel = 'Critical';
      riskColor = '#ef4444';
      riskBg = 'rgba(239,68,68,0.15)';
    } else if (riskPercent >= 40) {
      riskLabel = 'Warning';
      riskColor = '#f59e0b';
      riskBg = 'rgba(245,158,11,0.15)';
    }
    aiRiskBadgeEl.textContent = riskLabel;
    aiRiskBadgeEl.style.background = riskBg;
    aiRiskBadgeEl.style.color = riskColor;
    aiRiskBadgeEl.style.border = `1px solid ${riskColor}40`;
  }

  // Risk Threat badge (replaces risk score)
  const riskThreatEl = document.getElementById('modal-risk-threat');
  if (riskThreatEl) {
    const threatHtml = buildThreatBadge(normalizeRisk(report.risk_score));
    riskThreatEl.innerHTML = threatHtml;
  }

  if (factorsEl) factorsEl.innerHTML = buildRiskFactorHtml(report);
  if (evidenceEl) evidenceEl.textContent = report.evidence || report.text || 'No raw evidence provided.';

  // ── AI Confidence ──────────────────────────────────────────────────────────
  const aiConfEl = document.getElementById('modal-ai-confidence');
  if (aiConfEl) {
    const rawConf = typeof report.ai_confidence === 'number' ? report.ai_confidence : (report.risk_score ? Math.min(report.risk_score, 1) : 0);
    const confPct = Math.round(rawConf * 100);
    const confLabel = confPct >= 40 ? `${confPct}% Scam Probability` : `${confPct}% Safe`;
    const confColor = confPct >= 85 ? '#ef4444' : confPct >= 40 ? '#fb923c' : '#22c55e';
    aiConfEl.textContent = confLabel;
    aiConfEl.style.color = confColor;
  }

  // ── Platform & Source Display ──────────────────────────────────────────────
  const platformNameEl = document.getElementById('modal-platform-name');
  const sourceIdentifierEl = document.getElementById('modal-source-identifier');
  const userContextSectionEl = document.getElementById('modal-user-context-section');
  const userContextEl = document.getElementById('modal-user-context');
  if (platformNameEl) platformNameEl.textContent = platformName;
  if (sourceIdentifierEl) sourceIdentifierEl.textContent = sourceIdentifier;

  // Display user context section only if it has content (styled like raw evidence)
  if (userContextSectionEl) {
    if (userContext) {
      if (userContextEl) userContextEl.textContent = userContext;
      userContextSectionEl.style.display = '';
    } else {
      userContextSectionEl.style.display = 'none';
    }
  }

  if (imageWrapper && imageEl) {
    if (imageSource) {
      imageEl.src = imageSource;
      imageWrapper.style.display = '';
    } else {
      imageEl.removeAttribute('src');
      imageWrapper.style.display = 'none';
    }
  }

  // Reset verdict toggle buttons
  const verdictToggles = document.querySelectorAll('.verdict-toggle');
  verdictToggles.forEach(t => t.classList.remove('active'));

  // Always reset button labels/icons to defaults to avoid stuck loading
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      Submit Review
    `;
  }
  if (claimBtn) {
    claimBtn.disabled = false;
    claimBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
      Claim Investigation
    `;
  }

  // Hide override warning banner by default
  const overrideBanner = document.getElementById('override-warning-banner');
  if (overrideBanner) overrideBanner.style.display = 'none';

  // Get existing verdict (map old verdicts to new binary system)
  let existingVerdict = report.expert_verdict || report.expertVerdict || '';
  // Map old verdicts to binary: Safe -> Safe, Warning/Critical -> Confirmed Threat
  if (existingVerdict === 'Warning' || existingVerdict === 'Critical') {
    existingVerdict = 'Confirmed Threat';
  }

  const remSection    = document.getElementById('remediation-plan-section');
  const safetySection = document.getElementById('safety-justification-section');

  if (statusEl) {
    if (['Safe', 'Confirmed Threat'].includes(existingVerdict)) {
      statusEl.value = existingVerdict;
      // Activate corresponding toggle
      const matchingToggle = document.querySelector(`.verdict-toggle[data-verdict="${existingVerdict}"]`);
      if (matchingToggle) matchingToggle.classList.add('active');

      // Show/hide remediation plan based on verdict
      if (remSection) {
        remSection.style.display = existingVerdict === 'Confirmed Threat' ? 'block' : 'none';
      }
      if (safetySection) {
        safetySection.style.display = (existingVerdict === 'Safe' || existingVerdict === 'Verified Safe') ? 'block' : 'none';
      }

      // Show override warning if Safe but AI was critical
      if ((existingVerdict === 'Safe' || existingVerdict === 'Verified Safe') && overrideBanner) {
        const aiRiskLevel = report?.risk_level || report?.aiRiskLevel || '';
        const aiRiskScore = report?.risk_score || 0;
        const isCriticalAI = aiRiskLevel === 'critical' || aiRiskScore > 0.7;
        overrideBanner.style.display = isCriticalAI ? 'block' : 'none';
      }
    } else {
      statusEl.value = '';
      // Hide sections by default for new unreviewed reports
      if (remSection) remSection.style.display = 'none';
      if (safetySection) safetySection.style.display = 'none';
    }
  }

  if (notesEl)  notesEl.value  = report.expert_notes || report.expertNotes || '';

  // Restore remediation plan field from any previously saved value
  if (remPlanEl) remPlanEl.value = report.remediation_plan || report.remediationPlan || '';
  // Restore safety justification from any previously saved value
  if (safetyEl) safetyEl.value = report.safety_justification || report.safetyJustification || '';

  // Validate submit button state
  validateSubmitButtonState();

  // --- TICKET LOCKING LOGIC ---
  const lockedBanner = document.getElementById('modal-locked-banner');

  const currentStatus = normalizeStatus(report.status);
  const assignedTo = report.assigned_to;
  const currentUid = auth?.user?.uid;

  // Default: enabled state (claimed by me)
  if (lockedBanner) lockedBanner.style.display = 'none';
  if (claimBtn) claimBtn.style.display = 'none';
  if (submitBtn) submitBtn.style.display = 'inline-flex';
  if (notesEl) notesEl.disabled = false;
  if (remPlanEl) remPlanEl.disabled = false;
  verdictToggles.forEach(t => t.disabled = false);

  if (currentStatus === 'Unassigned' || currentStatus === 'Pending' || (currentStatus === 'Under Investigation' && !assignedTo) || (currentStatus === 'Investigating' && !assignedTo)) {
    // STATE 1: Unclaimed - Disable all inputs, show claim button
    if (notesEl) notesEl.disabled = true;
    if (remPlanEl) remPlanEl.disabled = true;
    if (submitBtn) submitBtn.style.display = 'none';
    if (claimBtn) claimBtn.style.display = 'inline-flex';
    if (remSection) remSection.style.display = 'none';
    verdictToggles.forEach(t => {
      t.disabled = true;
      t.classList.remove('active');
    });
  } else if ((currentStatus === 'Under Investigation' || currentStatus === 'Investigating') && assignedTo && assignedTo !== currentUid) {
    // STATE 2: Locked by another analyst
    if (notesEl) notesEl.disabled = true;
    if (remPlanEl) remPlanEl.disabled = true;
    if (submitBtn) submitBtn.style.display = 'none';
    if (claimBtn) {
      claimBtn.style.display = 'inline-flex';
      claimBtn.disabled = true;
      claimBtn.title = 'This case is already claimed by another analyst.';
    }
    if (lockedBanner) lockedBanner.style.display = 'block';
    if (remSection) remSection.style.display = 'none';
    verdictToggles.forEach(t => t.disabled = true);
  }
  // STATE 3: Claimed by me -> fallthrough to default enabled state

  openReviewModalUI();
}

/**
 * claimInvestigation — locks the ticket to the current expert using a Firestore transaction
 */
async function claimInvestigation() {
  if (!selectedReportId) return;

  const db = window.__suriinFirestore;
  const auth = window.__suriinAuth;
  if (!db || !auth?.user) return;

  const claimBtn = document.getElementById('claim-investigation-btn');
  if (claimBtn) {
    claimBtn.disabled = true;
    claimBtn.innerHTML = `
      <span style="display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 6px; vertical-align: -2px;"></span>
      Claiming...
    `;
  }

  const docRef = db.collection('Reports').doc(selectedReportId);

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) throw "Report does not exist!";
      
      const data = doc.data();
      const currentStatus = normalizeStatus(data.status);
      
      if (currentStatus === 'Under Investigation' && data.assigned_to && data.assigned_to !== auth.user.uid) {
        throw "LOCKED";
      }

      const ts = new Date().toISOString();
      transaction.update(docRef, {
        status: 'Under Investigation',
        assigned_to: auth.user.uid,
        assigned_email: auth.user.email,
        claimedAt: ts
      });
    });

    console.log('[SuriinAI Expert] Successfully claimed report:', selectedReportId);

    // Log audit event
    if (typeof window.logAuditEvent === 'function') {
      await window.logAuditEvent({
        action: 'CLAIM_REPORT',
        targetId: selectedReportId,
        targetType: 'report',
        details: `Claimed report #${selectedReportId.slice(-4)} for investigation`
      });
    }

    // Update local cache
    if (selectedReport) {
      selectedReport.status = 'Under Investigation';
      selectedReport.assigned_to = auth.user.uid;
      selectedReport.assigned_email = auth.user.email;
    }

    // ── Send notification to the user who submitted the report ─────────────
    if (selectedReport && selectedReport.user_id) {
      try {
        await db.collection('user_notifications').add({
          user_id: selectedReport.user_id,
          reportId: selectedReportId,
          type: 'status_update',
          status: 'Under Investigation',
          message: `Your report (ID: #${selectedReportId.slice(-4)}) has been assigned to a security analyst and is now under investigation.`,
          isRead: false,
          created_at: new Date().toISOString(),
          sentBy: auth.user.uid,
          sentByEmail: auth.user.email || ''
        });
        console.log('[SuriinAI Expert] User notification sent for claimed report:', selectedReportId);
      } catch (notifErr) {
        console.warn('[SuriinAI Expert] Failed to send user notification (non-blocking):', notifErr);
      }
    }

    // Close modal, show toast, then refresh table
    closeReviewModalUI();
    showDashboardToast('Case Claimed: Assigned to your queue.', 'success');
    await loadTriageReports();

    // Firestore propagation guard: reapply local cache if assigned_to not yet reflected
    const claimedInCache = triageReports.find(r => r.id === selectedReportId);
    if (claimedInCache && claimedInCache.assigned_to !== auth.user.uid) {
      claimedInCache.status = 'Under Investigation';
      claimedInCache.assigned_to = auth.user.uid;
      claimedInCache.assigned_email = auth.user.email;
      renderTriageTable();
    }

  } catch (err) {
    console.error('[SuriinAI Expert] Transaction failed:', err);
    if (err === "LOCKED") {
      showModalToast('This case was just claimed by another analyst.', 'error');
      await openReviewModal(selectedReportId); // Re-render to show locked banner
    } else {
      showModalToast('Failed to claim investigation. Please try again.', 'error');
    }
  } finally {
    if (claimBtn) {
      claimBtn.disabled = false;
      claimBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
        Claim Investigation
      `;
    }
  }
}

/**
 * submitReview — persists the expert's verdict, notes, remediation plan,
 * and a reviewedAt timestamp to the Firestore report document.
 *
 * Also calls the Flask /api/update-report-status endpoint when the
 * status is set to 'Resolved' so the server can send an email + push
 * notification to the reporting user.
 */
async function submitReview() {
  if (!selectedReportId || !selectedReport) return;

  const db   = window.__suriinFirestore;
  const auth = window.__suriinAuth;
  if (!db || !auth?.user) return;

  const statusEl       = document.getElementById('modal-status');
  const notesEl        = document.getElementById('modal-expert-notes');
  const remPlanEl      = document.getElementById('modal-remediation-plan');
  const safetyEl       = document.getElementById('modal-safety-justification');
  const remSection     = document.getElementById('remediation-plan-section');
  const submitBtn      = document.getElementById('submit-review-btn');

  const rawSelection    = statusEl ? statusEl.value : '';
  const expertNotes     = notesEl ? notesEl.value.trim() : '';
  const remediationPlan = remPlanEl ? remPlanEl.value.trim() : '';
  const safetyJust      = safetyEl ? safetyEl.value.trim() : '';
  const reviewedAt      = new Date().toISOString();

  // Resolve: Verified Safe or Confirmed Threat
  let expertVerdict = '';
  let status = 'Resolved';

  if (rawSelection === 'Verified Safe') {
    expertVerdict = 'Verified Safe';
  } else if (rawSelection === 'Confirmed Threat') {
    expertVerdict = 'Confirmed Threat';
  } else {
    showModalToast('Please select a verdict: \uD83D\uDFE2 Verified Safe or \uD83D\uDD34 Confirmed Threat', 'error');
    return;
  }

  // Remediation plan required only for Confirmed Threat verdict when visible
  const isRemVisible = remSection && remSection.style.display !== 'none';
  if (rawSelection === 'Confirmed Threat' && isRemVisible && !remediationPlan) {
    showModalToast('Please add a Remediation Plan before submitting the review.', 'error');
    document.getElementById('modal-remediation-plan')?.focus();
    return;
  }
  // Safety justification required for Verified Safe verdict
  if (rawSelection === 'Verified Safe' && !safetyJust) {
    showModalToast('Please add a Safety Justification before submitting the review.', 'error');
    document.getElementById('modal-safety-justification')?.focus();
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `
        <span style="display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 6px; vertical-align: -2px;"></span>
        Submitting...
      `;
    }

    // ── Write verdict, notes, remediation plan and timestamps to Firestore ──
    const docRef = db.collection('Reports').doc(selectedReportId);
    const snap = await docRef.get();
    const updatePayload = {
      status,
      expert_notes: expertNotes,
      reviewedBy:      auth.user.uid,
      reviewedByEmail: auth.user.email || '',
      reviewedAt
    };
    if (expertVerdict) updatePayload.expert_verdict = expertVerdict;
    if (status === 'Resolved') {
      updatePayload.resolvedAt = reviewedAt;
      if (remediationPlan) updatePayload.remediation_plan = remediationPlan;
      if (safetyJust) { updatePayload.safety_justification = safetyJust; updatePayload.safetyJustification = safetyJust; }
    }

    await docRef.update(updatePayload);
    console.log('[SuriinAI Expert] Review submitted for report:', selectedReportId);

    // Log audit event
    if (typeof window.logAuditEvent === 'function') {
      await window.logAuditEvent({
        action: 'REVIEW_REPORT',
        targetId: selectedReportId,
        targetType: 'report',
        details: `Resolved report #${selectedReportId.slice(-4)}${expertVerdict ? ` with verdict: ${expertVerdict}` : ''}`,
        metadata: { status, expertVerdict, expertNotes: expertNotes.substring(0, 100) }
      });
    }

    // ── Trigger server-side email + in-app notification ──────────────────
    try {
        const token = await auth.user.getIdToken();
        const res = await fetch('/api/update-report-status', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            report_id:    selectedReportId,
            status:       'Resolved',
            expert_notes: expertNotes,
            expert_verdict: expertVerdict
          })
        });
        if (res.ok) {
          console.log('[SuriinAI Expert] Server-side resolution notification triggered.');
        } else {
          console.warn('[SuriinAI Expert] Server returned non-OK for notification:', res.status);
        }
      } catch (apiErr) {
        // Non-blocking — Firestore already saved; email is best-effort
        console.warn('[SuriinAI Expert] Server notification failed (non-blocking):', apiErr);
    }

    // ── If remediation plan was entered: push it as a Notification doc ─────
    if (remediationPlan && selectedReport.user_id) {
      try {
        await db.collection('user_notifications').add({
          user_id:        selectedReport.user_id,
          reportId:       selectedReportId,
          type:           'remediation_plan',
          status,
          message:        'An expert has sent you a remediation plan for your report. Log in to view it.',
          remediationPlan,
          isRead:         false,
          created_at:     reviewedAt,
          sentBy:         auth.user.uid,
          sentByEmail:    auth.user.email || ''
        });
        console.log('[SuriinAI Expert] Remediation plan notification sent.');
      } catch (notifErr) {
        console.warn('[SuriinAI Expert] Remediation notification failed (non-blocking):', notifErr);
      }
    }


    // ── Update local cache so the table re-renders correctly ───────────────
    selectedReport.status             = status;
    selectedReport.expert_notes       = expertNotes;
    selectedReport.expertNotes        = expertNotes; // fallback for any remaining readers
    selectedReport.expert_verdict     = expertVerdict;
    selectedReport.expertVerdict      = expertVerdict;
    selectedReport.reviewedAt         = reviewedAt;
    if (status === 'Resolved') {
      selectedReport.resolvedAt      = reviewedAt;
      if (!selectedReport.firstResolvedAt) selectedReport.firstResolvedAt = reviewedAt;
    }
    const histLocal = Array.isArray(selectedReport.resolutionHistory) ? selectedReport.resolutionHistory : [];
    histLocal.push({ expertId: auth.user.uid, status, timestamp: reviewedAt, verdict: expertVerdict, notes: expertNotes, assigned_to: selectedReport.assigned_to || '', assigned_email: selectedReport.assigned_email || '' });
    selectedReport.resolutionHistory = histLocal;
    if (status === 'Resolved' && remediationPlan) selectedReport.remediationPlan = remediationPlan;
    if (status === 'Resolved' && safetyJust) {
      selectedReport.safety_justification = safetyJust;
      selectedReport.safetyJustification  = safetyJust;
    }

    showDashboardToast('Verdict Submitted: Case resolved.', 'success');
    closeReviewModalUI();

    // Refresh data in background to keep UI snappy
    loadTriageReports();
    loadResolvedTodayCount();
    setTimeout(renderStats, 0);
  } catch (err) {
    console.error('[SuriinAI Expert] Failed to submit review:', err);
    showModalToast('Failed to submit review. Check Firestore permissions.', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        Submit Review
      `;
    }
  }
}


function buildRiskBadge(score) {
  const pct = Math.round(score * 100);
  let cls = 'badge--safe';

  if (pct >= 85) cls = 'badge--critical';
  else if (pct >= 40) cls = 'badge--warning';

  return `<span class="badge ${cls}">${pct}%</span>`;
}

function buildThreatBadge(score) {
  const pct = Math.round(score * 100);
  let label = 'Safe';
  let cls = 'risk-score-badge--safe';

  if (pct >= 85) {
    label = 'Critical';
    cls = 'risk-score-badge--critical';
  } else if (pct >= 40) {
    label = 'Warning';
    cls = 'risk-score-badge--warning';
  }

  return `<span class="badge ${cls}" title="Threat level: ${label}">${label} (${pct}%)</span>`;
}

function buildRiskFactorHtml(report) {
  const rows = [];
  if (report.matched_company) {
    rows.push(
      `<div class="risk-factor-row">` +
      `<span class="risk-factor-badge risk-factor-badge--watchlist">SEC Watchlist</span>` +
      `<span class="risk-factor-value">${escapeHtml(String(report.matched_company))}</span>` +
      `</div>`
    );
  }
  if (Array.isArray(report.trigger_tokens) && report.trigger_tokens.length) {
    const tokens = report.trigger_tokens.filter(Boolean);
    if (tokens.length) {
      rows.push(
        `<div class="risk-factor-row">` +
        `<span class="risk-factor-badge risk-factor-badge--ai">AI Flagged</span>` +
        `<span class="risk-factor-value">${escapeHtml(tokens.join(', '))}</span>` +
        `</div>`
      );
    }
  }
  if (!rows.length) {
    const aiVerdict = String(report.ai_verdict || '').toUpperCase();
    const aiConf = report.ai_confidence ? `${Math.round(report.ai_confidence * 100)}%` : null;
    if (aiVerdict === 'WARNING' || aiVerdict === 'SUSPICIOUS' || aiVerdict === 'CRITICAL') {
      const detail = aiConf ? `Suspicious Pattern (${aiConf})` : 'Suspicious Pattern';
      rows.push(
        `<div class="risk-factor-row">` +
        `<span class="risk-factor-badge risk-factor-badge--ai">AI Flagged</span>` +
        `<span class="risk-factor-value">${escapeHtml(detail)}</span>` +
        `</div>`
      );
    } else if (report.heuristics || report.risk_factors) {
      rows.push(`<div class="risk-factor-row"><span class="risk-factor-value">${escapeHtml(report.heuristics || report.risk_factors)}</span></div>`);
    }
  }
  if (!rows.length) return 'No risk factors provided.';
  return `<div class="risk-factor-list">${rows.join('')}</div>`;
}

function buildRiskFactorPills(report) {
  let arr = [];

  if (report.matched_company) arr.push('SEC Watchlist');
  if (Array.isArray(report.trigger_tokens) && report.trigger_tokens.length) {
    arr.push('AI Flagged');
  }
  if (!arr.length) {
    const raw = report.risk_factors || report.riskFactors || report.heuristics || report.factors || '';
    if (Array.isArray(raw)) arr = raw.slice();
    else if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) arr = parsed;
        else arr = raw.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
      } catch (_) {
        arr = raw.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
      }
    }
  }

  if (!arr.length) return '<span class="text-muted">No factors</span>';

  const visible = arr.slice(0, 2).map((f) => `<span class="pill" title="${escapeHtml(f)}">${escapeHtml(f)}</span>`).join('');
  const remaining = arr.length - 2;
  if (remaining > 0) {
    const moreList = arr.slice(2).join(', ');
    return `${visible}<span class="pill pill--more" title="${escapeHtml(moreList)}">+${remaining} more</span>`;
  }

  return visible;
}

function capitalizePlatform(value) {
  const text = String(value || 'Unknown').trim();
  if (!text) return 'Unknown';
  // Keep known camel/brand forms like YouTube
  if (/^youtube$/i.test(text)) return 'YouTube';
  if (/^facebook$/i.test(text) || /^fb$/i.test(text)) return 'Facebook';
  if (/^instagram$/i.test(text)) return 'Instagram';
  if (/^tiktok$/i.test(text)) return 'TikTok';
  if (/^x|twitter$/i.test(text)) return 'X';
  return text.split(/[-_.\s]+/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

function buildStatusBadge(status) {
  const normalized = normalizeStatus(status);

  if (normalized === 'Under Investigation') {
    return '<span class="badge badge--investigating">Under Investigation</span>';
  }

  if (normalized === 'Resolved') {
    return '<span class="badge badge--reviewed">Resolved</span>';
  }

  return '<span class="badge badge--pending">Unassigned</span>';
}

function normalizeStatus(status) {
  const s = String(status || 'Unassigned');
  if (s === 'Pending') return 'Unassigned';
  if (s === 'Under Review' || s === 'Investigating') return 'Under Investigation';
  if (s === 'Reviewed') return 'Resolved';
  return s;
}

function extractPlatform(url) {
  if (!url) return '—';
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname;
  } catch {
    return '—';
  }
}

function getPlatformIcon(platformName) {
  if (!platformName) return '🔗';
  
  const name = String(platformName).toLowerCase();
  
  // Map platform names to icons
  if (name.includes('facebook') || name.includes('messenger')) return '📘';
  if (name.includes('instagram')) return '📷';
  if (name.includes('whatsapp')) return '💬';
  if (name.includes('sms') || name.includes('text')) return '📱';
  if (name.includes('email') || name.includes('gmail')) return '✉️';
  if (name.includes('twitter') || name.includes('x.com')) return '𝕏';
  if (name.includes('tiktok')) return '🎵';
  if (name.includes('dating') || name.includes('bumble') || name.includes('hinge')) return '💕';
  if (name.includes('telegram')) return '✈️';
  if (name.includes('discord')) return '🎮';
  if (name.includes('reddit')) return '🔴';
  if (name.includes('linkedin')) return '💼';
  if (name.includes('snapchat')) return '👻';
  
  return '🔗'; // Default link icon
}

function isRootDomainUrl(url) {
  if (!url) return false;
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    return path === '/' || path === '';
  } catch {
    return false;
  }
}

function normalizeRisk(score) {
  const n = Number(score || 0);
  if (Number.isNaN(n)) return 0;
  return n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
}

function formatDate(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return isoString;
  }
}

function toMillis(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getRoleHome(role) {
  if (role === 'admin') return '/admin-dashboard';
  if (role === 'expert') return '/expert-dashboard';
  return '/user-dashboard';
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function ensureOverlayHidden() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function escapeHtml(input) {
  return String(input || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderResolutionHistory(_entries) {
}

/**
 * showModalToast — shows a transient feedback message inside the review
 * modal footer area so the expert sees it without the modal closing.
 * Falls back to showDashboardToast if the modal anchor is not present.
 */
function showModalToast(message, type = 'info') {
  // Try to inject into the modal footer so it's visible while the modal is open
  const footer = document.querySelector('#review-modal .modal-footer');
  if (footer) {
    // Remove any existing inline toast first
    const existing = footer.querySelector('.modal-inline-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `modal-inline-toast toast toast--${type}`;
    toast.style.cssText = 'flex: 1 1 100%; order: -1; margin-bottom: var(--space-sm); text-align: center;';
    toast.textContent = message;
    footer.prepend(toast);

    setTimeout(() => {
      toast.classList.add('removing');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, 4000);
    return;
  }
  // Fallback to page-level toast
  showDashboardToast(message, type);
}

/**
 * showDashboardToast — page-level toast using #toast-container.
 * Creates the container on-the-fly if it doesn't exist in the DOM.
 */
function showDashboardToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  const bgColor = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#6C63FF';
  toast.style.cssText = `
    background: ${bgColor};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    opacity: 0;
    transform: translateX(100%);
    transition: all 0.3s ease;
    max-width: 400px;
    word-wrap: break-word;
  `;
  toast.textContent = message;
  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    });
  });

  // Remove after 3 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function loadAllReports() {
  const db = window.__suriinFirestore;
  if (!db) {
    console.error('[SuriinAI Expert] Firestore not available.');
    return;
  }

  try {
    const querySnapshot = await db.collection('Reports').get();
    allReports = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.warn('[SuriinAI Expert] Failed to load all reports for analytics:', err);
    allReports = [];
  }
}

function normalizePlatform(report) {
  if (report.platform) return String(report.platform);

  const url = String(report.url || '').trim();
  if (!url) return 'Unknown';

  try {
    const host = new URL(url).hostname.toLowerCase();

    if (host.includes('facebook')) return 'Facebook';
    if (host.includes('messenger')) return 'Messenger';
    if (host.includes('instagram')) return 'Instagram';
    if (host.includes('tiktok')) return 'TikTok';
    if (host.includes('sms') || host.includes('message')) return 'SMS';
    if (host.includes('whatsapp')) return 'WhatsApp';
    if (host.includes('mail') || host.includes('gmail')) return 'Email';

    return host.replace(/^www\./, '') || 'Unknown';
  } catch (_) {
    return 'Unknown';
  }
}

async function loadAnalytics() {
  const db = window.__suriinFirestore;
  if (!db) {
    console.error('[SuriinAI Expert] Firestore not available.');
    return;
  }

  try {
    const platformCounts = {};
    allReports.forEach((report) => {
      const platform = normalizePlatform(report);
      platformCounts[platform] = (platformCounts[platform] || 0) + 1;
    });

    renderAnalyticsStats();
    renderAnalyticsChart(platformCounts);
  } catch (err) {
    console.error('[SuriinAI Expert] Failed to load analytics:', err);
  }
}

function renderAnalyticsStats() {
  const totalScams = allReports.length;
  const pending = allReports.filter((r) => r.status === 'Pending').length;
  const resolved = allReports.filter((r) => r.status === 'Resolved').length;

  setText('stat-analytics-total-scams', String(totalScams));
  setText('stat-analytics-pending', String(pending));
  setText('stat-analytics-resolved', String(resolved));
}

function renderAnalyticsChart(platformCounts) {
  const canvas = document.getElementById('analytics-platform-pie-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const labels = Object.keys(platformCounts).sort();
  const values = labels.map((label) => platformCounts[label]);

  if (!labels.length) {
    labels.push('No Data');
    values.push(1);
  }

  if (platformChart) {
    platformChart.destroy();
  }

  platformChart = new Chart(canvas, {
    type: 'pie',
    data: {
      labels,
      datasets: [{
        label: 'Reports',
        data: values,
        backgroundColor: [
          '#3B82F6', '#F59E0B', '#10B981', '#EF4444',
          '#06B6D4', '#8B5CF6', '#EC4899', '#64748B'
        ],
        borderColor: '#0B0E17',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#F3F4F6',
            padding: 16,
            boxWidth: 14
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          titleColor: '#F3F4F6',
          bodyColor: '#D1D5DB',
          borderColor: 'rgba(255, 255, 255, 0.2)',
          borderWidth: 1
        }
      }
    }
  });
}
