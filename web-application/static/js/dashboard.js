/**
 * dashboard.js — Suriin AI Real-Time Dashboard Logic
 * ═══════════════════════════════════════════════════════════════════════════
 * Handles:
 *   1. Real-time Firestore listeners (onSnapshot) for the Reports collection
 *   2. User Dashboard: filtered to current user's reports only
 *   3. Expert Dashboard: all reports, with status filtering and update actions
 *   4. Stats card computation
 *   5. Toast notifications for status changes
 *   6. Report Details Modal (open/close/populate)
 *   7. PDF Evidence Download (print-based)
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

console.log('[Dashboard.js] File loaded successfully');

// Wait for auth event or check if already ready
function checkAuthAndInit() {
  console.log('[Dashboard.js] checkAuthAndInit called');
  console.log('[Dashboard.js] Auth ready?', window.__suriinAuthReady);
  console.log('[Dashboard.js] Auth data?', window.__suriinAuthData);
  
  if (window.__suriinAuthReady && window.__suriinAuthData) {
    const { user, role } = window.__suriinAuthData;
    console.log('[Dashboard.js] Initializing with stored auth data');
    initDashboard(user, role);
  }
}

// Check immediately
checkAuthAndInit();

// Also listen for event in case auth finishes after this script loads
window.addEventListener('suriin:auth-ready', (e) => {
  console.log('[Dashboard.js] Received suriin:auth-ready event');
  const { user, role } = e.detail;
  initDashboard(user, role);
});

// ── State ─────────────────────────────────────────────────────────────────────
let allReports         = [];
let currentFilter      = 'all';  // status filter
let currentVerdictFilter = 'all';  // verdict filter
let currentTab         = 'active'; // 'active' | 'resolved'
let snapshotUnsubscribe = null;
let dashboardInitialized = false; // guard against double-init
let renderCount        = 0;       // 0 = first render, animate rows; >0 = silent swap
let lastSnapshotHash   = null;    // deduplicate identical snapshot fires (null = never rendered)
let userCurrentPage    = 1;       // current page for pagination
const userReportsPerPage = 10;    // items per page

// ── Page detection ────────────────────────────────────────────────────────────
const isDashboardExpertPage = window.location.pathname.includes('admin-dashboard');

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN INIT
// ═══════════════════════════════════════════════════════════════════════════════

function initDashboard(user, role) {
  if (dashboardInitialized) return; // prevent double-init from both checkAuthAndInit + event

  const db = window.__suriinFirestore;
  if (!db) {
    console.error('[Dashboard.js] Firestore not available. Will retry on next auth event.');
    // Don't set dashboardInitialized = true here - allow retry when Firestore is ready
    return;
  }
  
  // Initialize dashboard for user
  dashboardInitialized = true; // Set to true only after Firestore check passes

  setupFilterChips();
  setupModal();
  // Notification bell is now handled by notification-bell.js
  // setupNotificationBell(user, db);

  // ── Set up the real-time listener ────────────────────────────────────────
  const reportsRef = db.collection('Reports');

  // Query without orderBy to avoid composite-index requirement while the index
  // may still be building, and to handle mixed created_at types (Firestore
  // Timestamp vs ISO string). Sorting is done client-side after fetch.
  let query;
  if (isDashboardExpertPage) {
    query = reportsRef;
    // Expert query: all reports
  } else {
    query = reportsRef.where('user_id', '==', user.uid);
    // User query: filtered by user_id
  }

  // Normalise a created_at value (Firestore Timestamp or ISO string) to ms.
  function toMs(val) {
    if (!val) return 0;
    if (typeof val === 'object' && typeof val.toMillis === 'function') return val.toMillis();
    if (typeof val === 'object' && val.seconds) return val.seconds * 1000;
    return new Date(val).getTime() || 0;
  }

  snapshotUnsubscribe = query.onSnapshot(
    (snapshot) => {
      // Build a lightweight hash of doc-ids + statuses to detect real changes
      const hash = snapshot.docs.map(d => d.id + (d.data().status || '')).join(',');
      if (lastSnapshotHash !== null && hash === lastSnapshotHash) {
        return; // identical to last render — skip
      }
      lastSnapshotHash = hash;

      allReports = [];
      snapshot.forEach((doc) => {
        allReports.push({ id: doc.id, ...doc.data() });
      });
      // Populate allReports array
      // Sort newest-first client-side (handles mixed Timestamp / ISO string types)
      allReports.sort((a, b) => toMs(b.created_at) - toMs(a.created_at));

      updateStats();
      renderTable();
    },
    (error) => {
      console.error('[SuriinAI Dashboard] Snapshot error:', error);
      showToast('Failed to load reports. Check Firestore rules.', 'error');
    }
  );

  // ── Open modal from URL param (if present) ──────────────────────────────
  const params = new URLSearchParams(window.location.search);
  const targetReportId = params.get('report_id');
  if (targetReportId) {
    setTimeout(() => {
      openReportModal(targetReportId);
      window.history.replaceState({}, document.title, window.location.pathname);
    }, 800);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════════════════════════

function updateStats() {
  if (isDashboardExpertPage) {
    updateExpertStats();
  } else {
    updateUserStats();
  }
}

function updateUserStats() {
  const notDismissed = allReports.filter(r => r.status !== 'Dismissed');

  const total = notDismissed.length;
  const underReview = notDismissed.filter(r =>
    r.status === 'Unassigned' || r.status === 'Pending' ||
    r.status === 'Under Review' || r.status === 'Investigating' || r.status === 'Under Investigation'
  ).length;
  const confirmed = notDismissed.filter(r => (r.expert_verdict || r.expertVerdict) === 'Confirmed Threat').length;
  const verifiedSafe = notDismissed.filter(r => (r.expert_verdict || r.expertVerdict) === 'Safe').length;

  animateCounter('stat-total', total);
  animateCounter('stat-under-review', underReview);
  animateCounter('stat-confirmed', confirmed);
  animateCounter('stat-verified-safe', verifiedSafe);
}

function updateExpertStats() {
  const total         = allReports.length;
  const pending       = allReports.filter(r => r.status === 'Unassigned' || r.status === 'Pending').length;
  const investigating = allReports.filter(r => r.status === 'Under Review' || r.status === 'Under Investigation').length;
  const resolved      = allReports.filter(r => r.status === 'Resolved' || r.status === 'Reviewed').length;

  animateCounter('stat-total', total);
  animateCounter('stat-pending', pending);
  animateCounter('stat-investigating', investigating);
  animateCounter('stat-resolved', resolved);
}

/** Smoothly animates a counter from its current value to the target.
 *  On the very first render (renderCount === 0) we set the value directly
 *  to avoid a rAF animation loop causing stat-card layout shifts on load. */
function animateCounter(elementId, target) {
  const el = document.getElementById(elementId);
  if (!el) return;

  // Strip skeleton state the first time real data arrives
  if (el.classList.contains('is-skeleton')) {
    el.classList.remove('is-skeleton');
    const label = el.parentElement && el.parentElement.querySelector('.stat-card__label');
    if (label) label.classList.remove('is-skeleton');
  }

  const current = parseInt(el.textContent) || 0;
  if (current === target) return;

  // First ever render: instant set — no animation to cause layout bounce
  if (renderCount === 0) {
    el.textContent = target;
    return;
  }

  const duration = 400;
  const start    = performance.now();

  function tick(now) {
    const elapsed  = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);
    const value    = Math.round(current + (target - current) * eased);
    el.textContent = value;
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TABLE RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function renderTable() {
  const tbody      = document.getElementById('reports-tbody');
  const emptyState = document.getElementById('empty-state');
  const countEl    = document.getElementById('report-count');
  const reportsSection = document.querySelector('.reports-section');
  
  // Render table with current reports data
  
  if (!tbody) return;

  // Apply tab + status/verdict filters
  const filtered = allReports.filter(r => {
    const rawSt = r.status || 'Unassigned';
    const isActive = ['Unassigned', 'Pending', 'Under Investigation', 'Investigating', 'Under Review'].includes(rawSt);
    const isResolved = ['Resolved', 'Reviewed', 'Dismissed'].includes(rawSt);

    if (currentTab === 'active' && !isActive) return false;
    if (currentTab === 'resolved' && !isResolved) return false;

    if (currentTab === 'active') {
      if (currentFilter === 'all') return true;
      if (currentFilter === 'Pending') return rawSt === 'Unassigned' || rawSt === 'Pending';
      if (currentFilter === 'Investigating') return rawSt === 'Under Investigation' || rawSt === 'Investigating' || rawSt === 'Under Review';
      return true;
    }

    if (currentTab === 'resolved') {
      if (currentVerdictFilter === 'all') return true;
      const v = String(r.expert_verdict || r.expertVerdict || '').toLowerCase();
      if (currentVerdictFilter === 'safe') return v === 'safe';
      if (currentVerdictFilter === 'threat') return v === 'confirmed threat' || v === 'scam';
      return true;
    }

    return true;
  });

  // Show empty state inside table when no reports
  // Keep the table structure and filters visible
  if (allReports.length === 0) {
    if (emptyState) emptyState.style.display = 'none'; // Hide standalone empty state
    // Show empty message inside table body
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 48px 24px;">
          <div style="color: var(--clr-text-muted);">
            <div style="font-size: 2.5rem; margin-bottom: 16px;">📭</div>
            <div style="font-weight: 600; font-size: var(--font-md); margin-bottom: 8px; color: var(--clr-text-secondary);">No reports submitted yet</div>
            <div style="font-size: var(--font-sm); max-width: 400px; margin: 0 auto; line-height: 1.5;">
              You haven't submitted any scam reports yet. Install the <strong>Suriin AI Chrome Extension</strong> and browse normally — it will automatically detect and submit suspicious content for analysis.
            </div>
          </div>
        </td>
      </tr>
    `;
  } else {
    if (emptyState) emptyState.style.display = 'none';
  }

  // Update count (reflects filtered subset)
  if (countEl) {
    countEl.textContent = `${filtered.length} report${filtered.length !== 1 ? 's' : ''}`;
  }

  // If no reports at all, empty message was already set above - skip row building
  if (allReports.length === 0) {
    return;
  }

  // Build all row HTML in memory first, then swap atomically (no bounce)
  // Only apply entrance animation on the very first render; subsequent
  // onSnapshot updates (status changes, new reports) swap silently.
  const isFirstRender = renderCount === 0;
  renderCount++;

  let rowsHtml = '';
  if (filtered.length === 0 && allReports.length > 0) {
    // Filters active but no matches — full styled empty state (table never collapses)
    const cols = isDashboardExpertPage ? 8 : 6;
    rowsHtml = `
      <tr class="filter-empty-row">
        <td colspan="${cols}">
          <div class="filter-empty-state">
            <svg class="filter-empty-state__icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p class="filter-empty-state__title">No reports match these filters</p>
            <span class="filter-empty-state__hint">Try adjusting the Status or Type filter above.</span>
          </div>
        </td>
      </tr>`;
  } else {
    // ── Pagination Logic ───────────────────────────────────────────────────
    const totalPages = Math.ceil(filtered.length / userReportsPerPage);
    if (userCurrentPage > totalPages) userCurrentPage = totalPages;
    if (userCurrentPage < 1) userCurrentPage = 1;

    const startIndex = (userCurrentPage - 1) * userReportsPerPage;
    const paginatedReports = filtered.slice(startIndex, startIndex + userReportsPerPage);

    // Update Pagination UI
    const paginationContainer = document.getElementById('user-pagination');
    const btnPrev = document.getElementById('user-pagination-prev');
    const btnNext = document.getElementById('user-pagination-next');
    const pageNumbersContainer = document.getElementById('user-pagination-numbers');

    if (paginationContainer) {
      paginationContainer.style.display = totalPages > 1 ? 'flex' : 'none';

      // Show/hide Previous button (hidden on page 1)
      if (btnPrev) btnPrev.style.display = userCurrentPage > 1 ? 'inline-flex' : 'none';

      // Show/hide Next button (hidden on last page)
      if (btnNext) btnNext.style.display = userCurrentPage < totalPages ? 'inline-flex' : 'none';

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

          if (i === userCurrentPage) {
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
              userCurrentPage = i;
              renderTable();
            });
          }
          pageNumbersContainer.appendChild(pageBtn);
        }
      }
    }

    paginatedReports.forEach((report, index) => {
      const delay    = isFirstRender ? `animation-delay:${index * 0.04}s` : 'animation:none';
      const cells    = isDashboardExpertPage ? buildExpertRow(report) : buildUserRow(report);
      const rowClass = !isDashboardExpertPage ? ' class="row-clickable"' : '';
      const rowData  = !isDashboardExpertPage ? ` data-report-id="${report.id}"` : '';
      rowsHtml += `<tr style="${delay}"${rowClass}${rowData}>${cells}</tr>`;
    });
  }
  // Swap content and trigger fade-in animation
  tbody.classList.remove('tbody--fade');
  // Force reflow so the animation restarts on re-filter
  void tbody.offsetHeight; // eslint-disable-line no-void
  tbody.innerHTML = rowsHtml;
  tbody.classList.add('tbody--fade');

  // Attach event listeners for status dropdowns (Expert only)
  if (isDashboardExpertPage) {
    tbody.querySelectorAll('.status-select').forEach((select) => {
      select.addEventListener('change', handleStatusChange);
    });
  }

  // Attach click listener on each row (User dashboard — row replaces View button)
  if (!isDashboardExpertPage) {
    tbody.querySelectorAll('tr[data-report-id]').forEach((row) => {
      row.addEventListener('click', () => {
        openReportModal(row.dataset.reportId);
      });
    });
  }
}

// ── Risk Factor structured HTML ───────────────────────────────────────────────
function buildRiskFactorHtml(report, riskScore) {
  const rows = [];
  if (report.matched_company) {
    rows.push(
      `<div class="risk-factor-row">` +
      `<span class="risk-factor-badge risk-factor-badge--watchlist">SEC Watchlist</span>` +
      `<span class="risk-factor-value">${escapeHtml(report.matched_company)}</span>` +
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
    const normRisk = typeof riskScore === 'number' ? riskScore : 0;
    const aiConf = report.ai_confidence ? `${Math.round(report.ai_confidence * 100)}%` : null;
    const aiVerdict = String(report.ai_verdict || '').toUpperCase();
    if (normRisk >= 0.40 || aiVerdict === 'WARNING' || aiVerdict === 'SUSPICIOUS' || aiVerdict === 'CRITICAL') {
      const detail = aiConf ? `Suspicious Pattern (${aiConf})` : 'Suspicious Pattern';
      rows.push(
        `<div class="risk-factor-row">` +
        `<span class="risk-factor-badge risk-factor-badge--ai">AI Flagged</span>` +
        `<span class="risk-factor-value">${escapeHtml(detail)}</span>` +
        `</div>`
      );
    } else if (report.heuristics) {
      rows.push(`<div class="risk-factor-row"><span class="risk-factor-value">${escapeHtml(report.heuristics)}</span></div>`);
    }
  }
  if (!rows.length) return '<p class="text-muted">No risk factors available.</p>';
  return `<div class="risk-factor-list">${rows.join('')}</div>`;
}

// ── AI Verdict Badge ──────────────────────────────────────────────────────────
function buildAiVerdictBadge(report) {
  const v = String(report.ai_verdict || report.report_type || report.request_type || '').toUpperCase();
  if (v === 'CRITICAL' || v === 'CRITICAL_REPORT') {
    return '<span class="badge badge--critical">Critical</span>';
  }
  if (v === 'WARNING' || v === 'SUSPICIOUS' || v === 'EXPERT_REVIEW_REQUEST') {
    return '<span class="badge badge--warning">Warning</span>';
  }
  if (v === 'SAFE' || v === 'CLEAN') {
    return '<span class="badge" style="background:rgba(34,197,94,0.12);color:#22c55e;border:1px solid rgba(34,197,94,0.3);">Safe</span>';
  }
  return '<span class="badge">' + (v || '—') + '</span>';
}

// ── Expert Verdict Badge ───────────────────────────────────────────────────────
function buildExpertVerdictBadge(report) {
  const status = report.status || 'Unassigned';
  const verdict = report.expert_verdict || report.expertVerdict || '';

  if (status === 'Unassigned' || status === 'Pending') {
    return '<span class="badge" style="background: var(--clr-bg-secondary); color: var(--clr-text-muted); border: 1px solid var(--clr-border);">Awaiting Expert</span>';
  }
  if (status === 'Under Review' || status === 'Investigating' || status === 'Under Investigation') {
    return '<span class="badge" style="background: rgba(108,99,255,0.15); color: #6C63FF; border: 1px solid rgba(108,99,255,0.3);">Investigating</span>';
  }
  if (status === 'Resolved' || status === 'Reviewed') {
    const v = String(verdict).toLowerCase();
    if (v === 'safe') {
      return '<span class="badge" style="background: rgba(34,197,94,0.15); color:#22c55e; border:1px solid rgba(34,197,94,0.35);">Verified Safe</span>';
    } else if (v === 'confirmed threat' || v === 'scam') {
      return '<span class="badge" style="background: rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.35);">Confirmed Threat</span>';
    } else if (verdict) {
      return `<span class="badge">${escapeHtml(verdict)}</span>`;
    }
  }
  return '<span class="badge" style="background: var(--clr-bg-secondary); color: var(--clr-text-muted); border: 1px solid var(--clr-border);">—</span>';
}

function buildAiScoreBadge(report) {
  const rawConf = typeof report.ai_confidence === 'number' ? report.ai_confidence : normalizeRisk(report.risk_score ?? 0);
  const pct = Math.round(rawConf * 100);
  const label = pct >= 40 ? `${pct}% Scam` : `${pct}% Safe`;
  let cls = 'badge--safe';
  if (pct >= 85) cls = 'badge--critical';
  else if (pct >= 40) cls = 'badge--warning';
  return `<span class="badge ${cls}">${label}</span>`;
}

// ── User Dashboard Row ────────────────────────────────────────────────────────
function buildUserRow(report) {
  const date        = formatDateSingleLine(report.created_at);
  const platform    = extractPlatform(report.url);
  const riskScore   = report.risk_score ?? 0;
  const normalizedRisk = normalizeRisk(riskScore);
  const statusRaw   = report.status || 'Unassigned';

  return `
    <td class="col-nowrap">${date}</td>
    <td class="url-cell" title="${escapeHtml(report.url || '')}">${platform}</td>
    <td class="col-nowrap">${buildThreatBadge(normalizedRisk)}</td>
    <td class="col-nowrap">${buildExpertVerdictBadge(report)}</td>
    <td class="col-nowrap">${buildStatusBadge(statusRaw)}</td>
    <td class="col-nowrap" style="padding-right:1.75rem;">${buildAiScoreBadge(report)}</td>
  `;
}

// ── Expert Dashboard Row ──────────────────────────────────────────────────────
function buildExpertRow(report) {
  const date      = formatDate(report.created_at);
  const userId    = escapeHtml(report.user_id || 'anonymous');
  const url       = escapeHtml(report.url || '—');
  const evidenceRaw = report.evidence || report.text || '';
  const text      = escapeHtml(evidenceRaw.substring(0, 80));
  const riskScore = report.risk_score ?? 0;
  const riskLevel = classifyRisk(riskScore);
  const heuristic = escapeHtml(report.heuristics || '—');
  const rawSt     = report.status || 'Unassigned';
  const status    = (rawSt === 'Under Investigation') ? 'Under Review'
    : (rawSt === 'Pending') ? 'Unassigned'
    : (rawSt === 'Reviewed') ? 'Resolved'
    : rawSt;

  return `
    <td>${date}</td>
    <td class="text-preview" title="${userId}">${userId}</td>
    <td class="url-cell" title="${url}">${url}</td>
    <td class="text-preview" title="${escapeHtml(evidenceRaw)}">${text || '—'}</td>
    <td>${buildRiskBar(riskScore, riskLevel)}</td>
    <td class="text-preview" title="${heuristic}">${heuristic}</td>
    <td>${buildStatusBadge(status)}</td>
    <td>${buildStatusDropdown(report.id, status)}</td>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REPORT DETAILS MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function setupModal() {
  const overlay    = document.getElementById('report-modal-overlay');
  const closeBtn   = document.getElementById('modal-close-btn');
  const cancelBtn  = document.getElementById('modal-cancel-btn');
  const downloadBtn = document.getElementById('modal-download-pdf');

  if (!overlay) return; // Not on a page with a modal

  // Close handlers
  if (closeBtn)  closeBtn.addEventListener('click', closeReportModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeReportModal);

  // Close on overlay click (outside modal)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeReportModal();
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') {
      closeReportModal();
    }
  });

  // PDF download
  if (downloadBtn) {
    downloadBtn.addEventListener('click', downloadPdfEvidence);
  }
}

function openReportModal(reportId) {
  const report = allReports.find(r => r.id === reportId);
  if (!report) {
    showToast('Report not found.', 'error');
    return;
  }

  const overlay = document.getElementById('report-modal-overlay');
  if (!overlay) return;

  // ── Populate modal fields ──────────────────────────────────────────────
  // Date
  const dateEl = document.getElementById('modal-date');
  if (dateEl) dateEl.innerHTML = formatDate(report.created_at);

  // Discovery Context: Platform (text only)
  const discoveryPlatformEl = document.getElementById('modal-discovery-platform');
  if (discoveryPlatformEl) discoveryPlatformEl.textContent = extractPlatform(report.url);

  // Discovery Context: Source Identifier
  const srcIdEl = document.getElementById('modal-source-identifier');
  if (srcIdEl) srcIdEl.textContent = report.source_identifier || report.sourceIdentifier || '—';

  // Discovery Context: User Context (same style as extracted text)
  const userCtxContainer = document.getElementById('modal-user-context-container');
  const userCtxEl = document.getElementById('modal-user-context');
  if (userCtxEl && userCtxContainer) {
    const uctx = report.user_context || report.userContext || '';
    if (uctx) {
      userCtxEl.textContent = uctx;
      userCtxContainer.style.display = '';
    } else {
      userCtxContainer.style.display = 'none';
    }
  }

  // Status
  const statusEl = document.getElementById('modal-status');
  if (statusEl) statusEl.innerHTML = buildStatusBadge(report.status || 'Unassigned');

  // F: AI Confidence Score
  const aiConfEl = document.getElementById('modal-ai-confidence');
  if (aiConfEl) {
    const rawConf = typeof report.ai_confidence === 'number' ? report.ai_confidence : normalizeRisk(report.risk_score ?? 0);
    const confPct = Math.round(rawConf * 100);
    const confLabel = confPct >= 40 ? `${confPct}% Scam Probability` : `${confPct}% Safe`;
    const confColor = confPct >= 85 ? '#ef4444' : confPct >= 40 ? '#fb923c' : '#22c55e';
    aiConfEl.textContent = confLabel;
    aiConfEl.style.color = confColor;
  }

  // Risk Score (normalise stored value to 0-1 fraction)
  const riskScore   = normalizeRisk(report.risk_score ?? 0);
  const riskPercent = Math.round(riskScore * 100);
  const riskLevel   = classifyRisk(riskScore);

  const riskNumberEl = document.getElementById('modal-risk-number');
  if (riskNumberEl) riskNumberEl.textContent = `${riskPercent}%`;

  const riskLevelEl = document.getElementById('modal-risk-level');
  if (riskLevelEl) {
    const levelLabels = { safe: 'Safe', warning: 'Warning', critical: 'Critical' };
    riskLevelEl.textContent = levelLabels[riskLevel] || 'Unknown';
    riskLevelEl.style.color = `var(--clr-${riskLevel})`;
  }

  // Risk circle styling
  const circleEl = document.getElementById('modal-risk-circle');
  if (circleEl) {
    circleEl.className = `risk-breakdown__circle risk-breakdown__circle--${riskLevel}`;
  }

  // Risk bar
  const barFillEl = document.getElementById('modal-risk-bar-fill');
  if (barFillEl) {
    barFillEl.style.width = `${riskPercent}%`;
    barFillEl.className = `risk-breakdown__bar-fill risk-breakdown__bar-fill--${riskLevel}`;
  }

  // Risk Factors — structured badge layout
  const factorsEl = document.getElementById('modal-risk-factors');
  if (factorsEl) factorsEl.innerHTML = buildRiskFactorHtml(report, riskScore);

  // Extracted Text
  const textEl = document.getElementById('modal-extracted-text');
  if (textEl) {
    const rawText = report.evidence || report.text || '';
    if (rawText) {
      textEl.textContent = rawText;
    } else {
      textEl.innerHTML = '<p class="text-muted">No extracted text available.</p>';
    }
  }

  // Forensic Review Section (visible if status != Pending)
  const expertSection = document.getElementById('modal-expert-review-section');
  if (expertSection) {
    const rawStatus = report.status || 'Unassigned';
    const showExpert = rawStatus !== 'Unassigned' && rawStatus !== 'Pending';
    expertSection.style.display = showExpert ? 'block' : 'none';

    const _verdictHeaderEl = document.getElementById('modal-expert-verdict-header');
    if (!showExpert && _verdictHeaderEl) _verdictHeaderEl.innerHTML = buildExpertVerdictBadge(report);

    if (showExpert) {
      // Verdict normalization
      function normalizeVerdict(v, status) {
        const s = String(v || '').trim().toLowerCase();
        if (!s && status === 'Dismissed') return 'Invalid';
        if (s.includes('scam') || s.includes('threat') || s.includes('confirm')) return 'Confirmed Threat';
        if (s === 'critical' || s === 'malicious') return 'Confirmed Threat';
        if (s === 'invalid' || s === 'dismissed') return 'Invalid';
        if (s === 'safe' || s === 'benign') return 'Safe';
        return v || 'Unknown';
      }

      const isUnderInvestigation = rawStatus === 'Under Investigation' || rawStatus === 'Investigating';
      const rawVerdictLabel = normalizeVerdict(report.expert_verdict || report.expertVerdict, rawStatus);
      const verdictLabel = isUnderInvestigation ? 'Investigating' : rawVerdictLabel;
      const verdictBadgeEl = document.getElementById('modal-expert-verdict-badge');
      const verdictHeaderEl = document.getElementById('modal-expert-verdict-header');
      const verdictClass = verdictLabel === 'Confirmed Threat' ? 'badge--verdict-threat'
                        : verdictLabel === 'Invalid'          ? 'badge--verdict-invalid'
                        : verdictLabel === 'Safe'             ? 'badge--verdict-safe'
                        : verdictLabel === 'Investigating'    ? 'badge--status-investigating'
                        : '';
      const verdictHtml = `<span class="badge ${verdictClass}">${escapeHtml(verdictLabel)}</span>`;
      if (verdictBadgeEl) verdictBadgeEl.innerHTML = verdictHtml;
      if (verdictHeaderEl) verdictHeaderEl.innerHTML = verdictHtml;

      // Safe alert vs notes visibility (+ Safety Justification)
      const safeAlertEl = document.getElementById('modal-safe-alert');
      const notesWrapperEl = document.getElementById('modal-expert-notes');
      const notesLabelEl = document.getElementById('modal-expert-notes-label');
      const safeJustWrapper = document.getElementById('modal-safety-justification-wrapper');
      const safeJustEl = document.getElementById('modal-safety-justification');

      if (verdictLabel === 'Safe') {
        if (safeAlertEl) safeAlertEl.style.display = '';
        if (notesWrapperEl) notesWrapperEl.style.display = 'none';
        if (notesLabelEl) notesLabelEl.style.display = 'none';
        if (safeJustWrapper) safeJustWrapper.style.display = '';
        if (safeJustEl) {
          const sj = report.safety_justification || report.safetyJustification || '';
          safeJustEl.innerHTML = sj ? escapeHtml(sj).replace(/\n/g, '<br>') : '<p class="text-muted">No justification provided.</p>';
        }
      } else {
        if (safeAlertEl) safeAlertEl.style.display = 'none';
        if (notesWrapperEl) notesWrapperEl.style.display = '';
        if (notesLabelEl) notesLabelEl.style.display = '';
        if (safeJustWrapper) safeJustWrapper.style.display = 'none';
      }

      // Change label for Dismissed status
      if (notesLabelEl) {
        notesLabelEl.textContent = (rawStatus === 'Dismissed') ? 'Dismissal Note' : 'Reasoning & Analysis';
      }

      // Assigned To (only if Under Investigation)
      const assignedItem = document.getElementById('modal-assigned-to-item');
      const assignedEl   = document.getElementById('modal-assigned-to');
      if (assignedItem && assignedEl) {
        const assigned = report.assigned_email || report.assignedEmail || report.assigned_to || '';
        if (isUnderInvestigation && assigned) {
          assignedEl.textContent = assigned;
          assignedItem.style.display = '';
        } else {
          assignedItem.style.display = 'none';
        }
      }

      // Expert Notes → Reasoning & Analysis (hidden when Under Investigation)
      if (isUnderInvestigation) {
        if (notesWrapperEl) notesWrapperEl.style.display = 'none';
        if (notesLabelEl) notesLabelEl.style.display = 'none';
      } else if (notesWrapperEl) {
        const notes = report.expert_notes || report.expertNotes || '';
        const verdictLabelLower = (verdictLabel || '').toLowerCase();
        const shouldHideNotes = verdictLabelLower === 'safe' || verdictLabelLower === 'confirmed threat';
        if (!shouldHideNotes) {
          if (notes) {
            notesWrapperEl.innerHTML = escapeHtml(notes).replace(/\n/g, '<br>');
          } else {
            notesWrapperEl.innerHTML = '<p class="text-muted">No notes available.</p>';
          }
        }
      }
    }
  }

  // Actionable Intelligence / Dismissal Rationale
  const actionSection = document.getElementById('modal-actionable-section');
  const actionTitleEl = document.getElementById('modal-actionable-title');
  const actionBodyEl  = document.getElementById('modal-actionable-content');
  if (actionSection && actionTitleEl && actionBodyEl) {
    const rawStatus = report.status || 'Pending';
    const verdictRaw = report.expert_verdict || report.expertVerdict || '';
    const verdictNorm = (function(v) {
      const s = String(v || '').trim().toLowerCase();
      if (s.includes('scam') || s.includes('threat') || s.includes('confirm') || s === 'critical' || s === 'malicious') return 'Confirmed Threat';
      if (s === 'invalid' || s === 'dismissed') return 'Invalid';
      if (s === 'safe' || s === 'benign') return 'Safe';
      return '';
    })(verdictRaw);

    // Determine visibility and content
    let showAction = false;
    if (verdictNorm === 'Confirmed Threat') {
      const plan = report.remediation_plan || report.remediationPlan || '';
      actionTitleEl.textContent = 'How to Protect Yourself';
      actionBodyEl.innerHTML = plan
        ? escapeHtml(plan).replace(/\n/g, '<br>')
        : 'Please contact your local authorities or your bank immediately to secure your accounts.';
      showAction = true;
    } else if (rawStatus === 'Dismissed') {
      // No separate dismissal rationale — show nothing; use Dismissal Note in Forensic Review instead
      showAction = false;
    }
    actionSection.style.display = showAction ? 'block' : 'none';
  }

  // ── Show modal ────────────────────────────────────────────────────────
  overlay.style.display = '';
  overlay.classList.remove('closing');
  document.body.style.overflow = 'hidden';

  // Store current report ID for PDF download
  overlay.dataset.currentReportId = reportId;

  // Configure PDF download button based on status
  const downloadBtn = document.getElementById('modal-download-pdf');
  if (downloadBtn) {
    const status = report.status || 'Pending';
    const isDisabled = status === 'Pending' || status === 'Investigating' || status === 'Under Investigation';
    
    downloadBtn.disabled = isDisabled;
    
    if (isDisabled) {
      downloadBtn.title = 'Forensic report available after expert review completion';
      downloadBtn.style.opacity = '0.5';
      downloadBtn.style.cursor = 'not-allowed';
    } else {
      downloadBtn.title = 'Download forensic report as PDF';
      downloadBtn.style.opacity = '1';
      downloadBtn.style.cursor = 'pointer';
    }
  }

  console.log(`[SuriinAI Dashboard] Modal opened for report: ${reportId}`);
}

function closeReportModal() {
  const overlay = document.getElementById('report-modal-overlay');
  if (!overlay || overlay.style.display === 'none') return;

  overlay.classList.add('closing');

  // Wait for animation to complete before hiding
  setTimeout(() => {
    overlay.style.display = 'none';
    overlay.classList.remove('closing');
    document.body.style.overflow = '';
  }, 220);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PDF EVIDENCE DOWNLOAD (Print-based)
// ═══════════════════════════════════════════════════════════════════════════════

function downloadPdfEvidence() {
  const overlay = document.getElementById('report-modal-overlay');
  if (!overlay) return;

  const reportId = overlay.dataset.currentReportId;
  const report   = allReports.find(r => r.id === reportId);
  if (!report) { showToast('Report data not found.', 'error'); return; }

  // ── Loading state ──────────────────────────────────────────────────────────
  const btn     = document.getElementById('modal-download-pdf');
  const btnText = btn && btn.querySelector('.btn-text');
  const origLabel = btnText ? btnText.textContent : null;
  if (btn)     btn.disabled = true;
  if (btnText) btnText.textContent = '⏳ Generating...';

  // Defer to next tick so the button update paints before PDF build blocks the thread
  // Additional delay to ensure jsPDF plugins are fully loaded
  setTimeout(() => {
    try {
      // Check if jsPDF is available
      if (!window.jspdf) {
        throw new Error('jsPDF library not loaded');
      }
      
      const { jsPDF } = window.jspdf;
      
      // Try to manually attach AutoTable plugin if it's available globally
      if (window.jspdf && window.jspdf.autoTable) {
        jsPDF.autoTable = window.jspdf.autoTable;
      } else if (window.jspdfAutotable) {
        jsPDF.autoTable = window.jspdfAutotable;
      }
      
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      
      // Check if AutoTable plugin is available
      if (typeof doc.autoTable !== 'function') {
        console.error('[PDF] AutoTable plugin not found:', {
          jspdfLoaded: !!window.jspdf,
          autoTableLoaded: !!window.jspdf?.autoTable,
          jspdfAutotableLoaded: !!window.jspdfAutotable,
          docAutoTable: typeof doc.autoTable
        });
        throw new Error('jsPDF AutoTable plugin not loaded. Please check script loading order.');
      }
      
      console.log('[PDF] jsPDF and AutoTable initialized successfully');

      // ── Constants ───────────────────────────────────────────────────────────
      const PAGE_W    = doc.internal.pageSize.getWidth();
      const PAGE_H    = doc.internal.pageSize.getHeight();
      const MARGIN    = 48;
      const USABLE_W  = PAGE_W - MARGIN * 2;
      const ACCENT    = [108, 99, 255];   // purple
      const DARK      = [15, 15, 25];
      const MUTED     = [120, 120, 140];
      const WHITE     = [255, 255, 255];

      // Risk level colours
      const riskScore = report.risk_score ?? 0;
      const riskLevel = classifyRisk(riskScore);
      const riskPct   = Math.round(riskScore * 100);
      const VERDICT_COLOR = riskLevel === 'critical' ? [220, 38, 38]
                          : riskLevel === 'warning'  ? [234, 88, 12]
                          :                            [22, 163, 74];
      const VERDICT_LABEL = riskLevel === 'critical' ? 'CRITICAL'
                          : riskLevel === 'warning'  ? 'WARNING'
                          :                            'SAFE';
      
      // Status variable for conditional sections
      const status = report.status || '';

      let y = MARGIN;

      // ── Header band ─────────────────────────────────────────────────────────
      doc.setFillColor(...ACCENT);
      doc.rect(0, 0, PAGE_W, 64, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.setTextColor(...WHITE);
      doc.text('Suriin AI', MARGIN, 36);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(...WHITE);
      let headerText = 'Forensic Evidence Report';
      if (report.status === 'Reviewed') {
        headerText = 'Suriin AI Certified - Forensic Evidence Report';
      } else if (report.status === 'Dismissed') {
        headerText = 'DISMISSAL RECORD';
        // Use gray accent for dismissed state (matching Invalid/Dismissed badge)
        doc.setFillColor(107, 114, 128);
        doc.rect(0, 0, PAGE_W, 64, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(20);
        doc.setTextColor(...WHITE);
        doc.text('Suriin AI', MARGIN, 36);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text(headerText, MARGIN, 48);
      } else {
        doc.text(headerText, MARGIN, 48);
      }

      // Generated timestamp (right-aligned in header)
      const genDate = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
      doc.setFontSize(8);
      doc.setTextColor(200, 200, 255);
      doc.text(`Generated: ${genDate}`, PAGE_W - MARGIN, 52, { align: 'right' });

      y = 88;

      // ── Section helper ───────────────────────────────────────────────────────
      // Returns the y position where content should start (after label + rule + gap)
      function sectionTitle(label) {
        if (y + 40 > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...ACCENT);
        doc.text(label.toUpperCase(), MARGIN, y);
        y += 5;
        doc.setDrawColor(...ACCENT);
        doc.setLineWidth(0.4);
        doc.line(MARGIN, y, MARGIN + USABLE_W, y);
        y += 14; // generous gap so content doesn't crowd the rule
      }

      function bodyText(text, size = 9.5, color = [40, 40, 55]) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(size);
        doc.setTextColor(...color);
        const lines = doc.splitTextToSize(String(text), USABLE_W);
        lines.forEach(line => {
          if (y + 16 > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
          doc.text(line, MARGIN, y);
          y += 14;
        });
      }

      // ── Metadata table ───────────────────────────────────────────────────────
      sectionTitle('Report Details');

      const reqType = (report.report_type || report.request_type || report.requestType || '').toLowerCase();
      const reqLabel = (reqType === 'expert_review' || reqType === 'expert_review_request')
        ? 'Expert Review' : (reqType === 'evidence' || reqType === 'critical_report')
        ? 'Evidence' : reqType || '—';

      // Prepare reporter information
      const reporterInfo = report.user_email || report.user_id || 'Anonymous';
      const sourceIdentifier = report.source_identifier || report.sourceIdentifier || '—';

      doc.autoTable({
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        tableWidth: USABLE_W,
        head: [],
        body: [
          ['Report ID',       report.id || '—'],
          ['Date Submitted',  formatDatePlain(report.created_at)],
          ['Reporter',        reporterInfo],
          ['Source Identifier', sourceIdentifier],
          ['Platform',        extractPlatform(report.url)],
          ['Scanned URL',     report.url || '—'],
          ['Status',          report.status || 'Pending'],
          ['Request Type',    reqLabel],
        ],
        columnStyles: {
          0: { fontStyle: 'bold', cellWidth: 120, fillColor: [237, 237, 247], textColor: [55, 55, 90] },
          1: { fillColor: [255, 255, 255], textColor: [30, 30, 50] },
        },
        styles: {
          fontSize: 9,
          cellPadding: { top: 6, bottom: 6, left: 8, right: 8 },
          lineColor: [210, 210, 225],
          lineWidth: 0.4,
          overflow: 'linebreak',
        },
        theme: 'grid',
      });

      y = (doc.lastAutoTable.finalY || y) + 22;

      // ── Verdict ──────────────────────────────────────────────────────────────
      sectionTitle('Risk Verdict');
      y += 20; // Larger gap between section title and verdict label

      if (y + 120 > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }

      // Verdict label (large, own line) with proper spacing
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(32);
      doc.setTextColor(...VERDICT_COLOR);
      doc.text(VERDICT_LABEL, MARGIN, y);
      y += 28; // Balanced spacing after large verdict label

      // Risk score sub-label on its own line
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(...MUTED);
      doc.text(`Risk Score: ${riskPct}%`, MARGIN, y);
      y += 20; // Spacing before bar

      // Risk bar track with better sizing
      if (y + 20 > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
      doc.setFillColor(218, 218, 228);
      doc.roundedRect(MARGIN, y, USABLE_W, 12, 3, 3, 'F');
      // Risk bar fill
      doc.setFillColor(...VERDICT_COLOR);
      const fillW = Math.max(8, (riskPct / 100) * USABLE_W);
      doc.roundedRect(MARGIN, y, fillW, 12, 3, 3, 'F');
      y += 36; // Spacing after bar

      // ── Risk Factors ─────────────────────────────────────────────────────────
      sectionTitle('Risk Factors');
      const factors = report.heuristics || 'No risk factors recorded.';
      bodyText(factors);
      y += 10;

      // ── User Statement Section ───────────────────────────────────────────────────
      const userContext = report.user_context || report.userContext || '';
      if (userContext) {
        sectionTitle('User Statement');
        bodyText(userContext);
        y += 10;
      }

      // ── Expert Review Section (only if reviewed or dismissed) ───────────────────────
      if (status === 'Reviewed' || status === 'Dismissed') {
        sectionTitle('Expert Review');
        
        // Expert Verdict
        const verdict = report.expert_verdict || report.expertVerdict || '';
        let verdictDisplay = 'Unknown';
        let verdictColor = MUTED;
        
        if (status === 'Dismissed') {
          verdictDisplay = 'Invalid';
          verdictColor = [148, 163, 184];
        } else if (verdict) {
          const v = String(verdict).toLowerCase();
          if (v === 'safe') {
            verdictDisplay = 'Verified Safe';
            verdictColor = [34, 197, 94];
          } else if (v === 'confirmed threat' || v === 'scam') {
            verdictDisplay = 'Confirmed Threat';
            verdictColor = [239, 68, 68];
          } else if (v === 'false positive') {
            verdictDisplay = 'False Positive';
            verdictColor = [148, 163, 184];
          }
        }
        
        // Verdict display
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.setTextColor(...verdictColor);
        doc.text(`Expert Verdict: ${verdictDisplay}`, MARGIN, y);
        y += 20;
        
        // Verified/Dismissed By (get last reviewing expert)
        const history = Array.isArray(report.resolutionHistory) ? report.resolutionHistory : [];
        // Find last expert entry by checking assigned_email (expert identity) and relevant statuses
        const lastExpertEntry = history.filter(h => 
          h.assigned_email && 
          (h.status === 'Reviewed' || h.status === 'Dismissed' || h.status === 'Resolved')
        ).pop();
        if (lastExpertEntry && lastExpertEntry.assigned_email) {
          const expertName = '@' + lastExpertEntry.assigned_email.split('@')[0];
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(10);
          doc.setTextColor(...MUTED);
          const attributionLabel = status === 'Dismissed' ? 'Dismissed by' : 'Verified By';
          doc.text(`${attributionLabel}: ${expertName}`, MARGIN, y);
          y += 18;
        }
        
        // Dismissal Reason (for dismissed reports)
        if (status === 'Dismissed') {
          const expertNotes = report.expert_notes || report.expertNotes || '';
          if (expertNotes) {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(12);
            doc.setTextColor(107, 114, 128); // Gray color matching dismissed badge
            doc.text('Dismissal Reason:', MARGIN, y);
            y += 16;
            
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            doc.setTextColor(...DARK);
            const noteLines = doc.splitTextToSize(expertNotes, USABLE_W);
            noteLines.forEach(line => {
              if (y + 14 > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
              doc.text(line, MARGIN, y);
              y += 12;
            });
            y += 10;
          }
        }
        
        // Remediation Plan or Safety Justification
        if (status === 'Reviewed') {
          if (verdictDisplay === 'Verified Safe') {
            const safety = report.safety_justification || report.safetyJustification || '';
            if (safety) {
              doc.setFont('helvetica', 'bold');
              doc.setFontSize(11);
              doc.setTextColor(...DARK);
              doc.text('Safety Justification:', MARGIN, y);
              y += 14;
              bodyText(safety);
              y += 10;
            }
          } else if (verdictDisplay === 'Confirmed Threat') {
            const remediation = report.remediationPlan || report.remediation_plan || '';
            if (remediation) {
              doc.setFont('helvetica', 'bold');
              doc.setFontSize(11);
              doc.setTextColor(...DARK);
              doc.text('Remediation Plan:', MARGIN, y);
              y += 14;
              bodyText(remediation);
              y += 10;
            }
          }
        }
        
        y += 10;
      }

      // ── Scanned Evidence Text ────────────────────────────────────────────────
      sectionTitle('Scanned Evidence Text');
      const evidence = report.text || 'No extracted text available.';
      bodyText(evidence);
      y += 10;

      // ── Resolution History Table ───────────────────────────────────────────────
      const history = Array.isArray(report.resolutionHistory) ? report.resolutionHistory 
                     : Array.isArray(report.resolution_history) ? report.resolution_history 
                     : [];
      
      if (history.length > 0) {
        sectionTitle('Resolution History');
        
        // Prepare history data for table
        const historyData = history.map(h => {
          const date = formatDatePlain(h.timestamp || h.date || h.time || h.updated_at || h.created_at);
          const status = h.status || '—';
          // Format expert name as @username from email, fallback to role
          let performedBy = 'User';
          if (h.assigned_email) {
            performedBy = '@' + h.assigned_email.split('@')[0];
          } else if (h.by === 'System') {
            performedBy = 'System';
          } else if (h.expertId) {
            performedBy = 'Expert';
          }
          return [date, status, performedBy];
        }); // Show oldest first (chronological order)
        
        if (y + 80 > PAGE_H - MARGIN - 80) { doc.addPage(); y = MARGIN; }
        
        doc.autoTable({
          startY: y,
          margin: { left: MARGIN, right: MARGIN },
          tableWidth: USABLE_W,
          head: [['Date', 'Action', 'Performed by']],
          body: historyData,
          columnStyles: {
            0: { fontStyle: 'bold', cellWidth: 120, fillColor: [237, 237, 247], textColor: [55, 55, 90] },
            1: { fillColor: [255, 255, 255], textColor: [30, 30, 50] },
            2: { fillColor: [255, 255, 255], textColor: [30, 30, 50], fontStyle: 'italic' }
          },
          styles: {
            fontSize: 8,
            cellPadding: { top: 4, bottom: 4, left: 6, right: 6 },
            lineColor: [210, 210, 225],
            lineWidth: 0.4,
            overflow: 'linebreak',
          },
          theme: 'grid',
        });
        
        y = (doc.lastAutoTable.finalY || y) + 22;
      }

      // ── Certification Footer ─────────────────────────────────────────────────────
      const FOOTER_H = 85;
      // If content is too close to bottom, push footer to a new page
      if (y + FOOTER_H > PAGE_H - MARGIN) { doc.addPage(); }

      const footerY = PAGE_H - MARGIN - FOOTER_H;
      doc.setDrawColor(...MUTED);
      doc.setLineWidth(0.4);
      doc.line(MARGIN, footerY, MARGIN + USABLE_W, footerY);

      // Generate report hash for authenticity
      const reportHash = generateReportHash(report);
      const certDate = new Date().toLocaleString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      // Certification text
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...ACCENT);
      doc.text('Certified by Suriin AI', MARGIN, footerY + 15);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      doc.text(`Report Hash: ${reportHash}`, MARGIN, footerY + 25);
      doc.text(`Generated: ${certDate}`, MARGIN, footerY + 35);

      // Right-aligned verification info
      doc.text('Verification: suriin.ai/verify', PAGE_W - MARGIN, footerY + 25, { align: 'right' });
      
      if (status === 'Reviewed') {
        doc.setTextColor(34, 197, 94);
        doc.text('✓ Authenticated Report', PAGE_W - MARGIN, footerY + 35, { align: 'right' });
      } else if (status === 'Dismissed') {
        doc.setTextColor(220, 38, 38);
        doc.text('✗ Dismissed Report', PAGE_W - MARGIN, footerY + 35, { align: 'right' });
      } else {
        doc.setTextColor(251, 146, 60);
        doc.text('⚠ Pending Review', PAGE_W - MARGIN, footerY + 35, { align: 'right' });
      }

      // Disclaimer text
      const disclaimerText =
        'DISCLAIMER: This report is generated based on data captured from the user\'s browser session. ' +
        'It is intended for informational and threat-awareness purposes only. Because client-side data ' +
        'can be modified prior to scanning, this report should be used as a primary triage tool rather ' +
        'than a certified forensic proof.';

      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7.5);
      doc.setTextColor(...MUTED);
      const dLines = doc.splitTextToSize(disclaimerText, USABLE_W);
      let dy = footerY + 50;
      dLines.forEach(line => {
        doc.text(line, MARGIN, dy);
        dy += 10;
      });

      // ── Build preview overlay ──────────────────────────────────────────────
      const pdfBlob = doc.output('blob');
      const blobUrl = URL.createObjectURL(pdfBlob);
      const fileName = `Suriin_Report_${report.id}.pdf`;

      // Overlay backdrop
      const overlayEl = document.createElement('div');
      overlayEl.className = 'pdf-preview-overlay';

      // Card
      const cardEl = document.createElement('div');
      cardEl.className = 'pdf-preview-card';

      // Header
      const headerEl = document.createElement('div');
      headerEl.className = 'pdf-preview-header';

      const titleEl = document.createElement('span');
      titleEl.className = 'pdf-preview-header__title';
      titleEl.textContent = `📄 ${fileName}`;

      const dlBtn = document.createElement('a');
      dlBtn.className = 'pdf-preview-header__btn pdf-preview-header__btn--download';
      dlBtn.href = blobUrl;
      dlBtn.download = fileName;
      dlBtn.textContent = '⬇ Download';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'pdf-preview-header__btn pdf-preview-header__btn--close';
      closeBtn.textContent = '✕ Close';

      headerEl.appendChild(titleEl);
      headerEl.appendChild(dlBtn);
      headerEl.appendChild(closeBtn);

      // iframe
      const frameEl = document.createElement('iframe');
      frameEl.className = 'pdf-preview-frame';
      frameEl.src = blobUrl;
      frameEl.title = 'PDF Preview';

      cardEl.appendChild(headerEl);
      cardEl.appendChild(frameEl);
      overlayEl.appendChild(cardEl);
      document.body.appendChild(overlayEl);

      // Close handlers
      function closePdfPreview() {
        overlayEl.remove();
        URL.revokeObjectURL(blobUrl);
        document.removeEventListener('keydown', onEsc);
      }
      function onEsc(e) { if (e.key === 'Escape') closePdfPreview(); }

      closeBtn.addEventListener('click', closePdfPreview);
      overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closePdfPreview(); });
      document.addEventListener('keydown', onEsc);

      showToast('PDF ready — preview opened.', 'success');

    } catch (err) {
      console.error('[SuriinAI] PDF generation error:', err);
      showToast('Failed to generate PDF. Please try again.', 'error');
    } finally {
      if (btn)     btn.disabled = false;
      if (btnText) btnText.textContent = origLabel;
    }
  }, 200);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STATUS UPDATE (Expert only)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleStatusChange(e) {
  const select   = e.target;
  const reportId = select.dataset.reportId;
  const newStatus = select.value;

  try {
    const token = await window.__suriinGetIdToken();

    const res = await fetch('/api/update-report-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ report_id: reportId, status: newStatus })
    });

    const data = await res.json();

    if (data.success) {
      showToast(`Report updated to "${newStatus}"`, 'success');
    } else {
      showToast(`Update failed: ${data.error}`, 'error');
      // Revert the dropdown
      const original = allReports.find(r => r.id === reportId);
      if (original) select.value = original.status;
    }
  } catch (err) {
    console.error('[SuriinAI Dashboard] Status update error:', err);
    showToast('Failed to update status. Please try again.', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FILTER CHIPS (Expert only)
// ═══════════════════════════════════════════════════════════════════════════════

function setupFilterChips() {
  // ── Expert dashboard: chip buttons ────────────────────────────────────────
  const filterBar = document.getElementById('filter-bar');
  if (filterBar) {
    filterBar.addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      filterBar.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      userCurrentPage = 1; // Reset to first page on filter change
      renderTable();
    });
  }

  // ── User dashboard: tab switching ─────────────────────────────────────────
  const tabActive = document.getElementById('tab-active');
  const tabResolved = document.getElementById('tab-resolved');
  const filterBarActive = document.getElementById('user-filter-bar-active');
  const filterBarResolved = document.getElementById('user-filter-bar-resolved');

  function switchTab(tab) {
    currentTab = tab;
    currentFilter = 'all';
    currentVerdictFilter = 'all';
    userCurrentPage = 1;
    const isActive = tab === 'active';
    if (tabActive) {
      tabActive.style.borderBottomColor = isActive ? 'var(--clr-accent)' : 'transparent';
      tabActive.style.color = isActive ? 'var(--clr-accent)' : 'var(--clr-text-secondary)';
    }
    if (tabResolved) {
      tabResolved.style.borderBottomColor = !isActive ? 'var(--clr-accent)' : 'transparent';
      tabResolved.style.color = !isActive ? 'var(--clr-accent)' : 'var(--clr-text-secondary)';
    }
    if (filterBarActive) filterBarActive.style.display = isActive ? '' : 'none';
    if (filterBarResolved) filterBarResolved.style.display = !isActive ? '' : 'none';
    // reset selects
    const statusSel = document.getElementById('filter-status');
    const verdictSel = document.getElementById('filter-verdict');
    if (statusSel) statusSel.value = 'all';
    if (verdictSel) verdictSel.value = 'all';
    renderTable();
  }

  if (tabActive) tabActive.addEventListener('click', () => switchTab('active'));
  if (tabResolved) tabResolved.addEventListener('click', () => switchTab('resolved'));

  // ── User dashboard: select dropdowns ──────────────────────────────────────
  const statusSel = document.getElementById('filter-status');
  const verdictSel = document.getElementById('filter-verdict');

  if (statusSel) {
    statusSel.addEventListener('change', () => {
      currentFilter = statusSel.value;
      userCurrentPage = 1;
      renderTable();
    });
  }

  if (verdictSel) {
    verdictSel.addEventListener('change', () => {
      currentVerdictFilter = verdictSel.value;
      userCurrentPage = 1;
      renderTable();
    });
  }

  // ── Pagination Button Listeners ───────────────────────────────────────────
  const btnPrev = document.getElementById('user-pagination-prev');
  const btnNext = document.getElementById('user-pagination-next');

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (userCurrentPage > 1) {
        userCurrentPage--;
        renderTable();
      }
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      userCurrentPage++;
      renderTable();
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UI BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function buildRiskBar(score, level) {
  const percent = Math.round(score * 100);
  return `
    <div class="risk-bar">
      <div class="risk-bar__track">
        <div class="risk-bar__fill risk-bar__fill--${level}" style="width: ${percent}%"></div>
      </div>
      <span class="risk-bar__label" style="color: var(--clr-${level})">${percent}%</span>
    </div>
  `;
}

function normalizeRisk(score) {
  const n = Number(score || 0);
  if (Number.isNaN(n)) return 0;
  return n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
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

function buildStatusBadge(status) {
  const classMap = {
    'Unassigned':          'badge--pending',
    'Pending':             'badge--pending',
    'Under Review':        'badge--investigating',
    'Under Investigation': 'badge--investigating',
    'Investigating':       'badge--investigating',
    'Resolved':            'badge--reviewed',
    'Reviewed':            'badge--reviewed',
    'Dismissed':           'badge--dismissed',
  };
  const cls = classMap[status] || 'badge--pending';
  const displayMap = {
    'Pending':             'Pending',
    'Unassigned':          'Pending',
    'Under Investigation': 'Investigating',
    'Investigating':       'Investigating',
    'Under Review':        'Investigating',
    'Reviewed':            'Resolved',
  };
  const displayStatus = displayMap[status] || status;
  return `<span class="badge ${cls}">${escapeHtml(displayStatus)}</span>`;
}

function buildStatusDropdown(reportId, currentStatus) {
  const options = ['Unassigned', 'Under Review', 'Resolved'];
  const normCurrent = currentStatus === 'Pending' ? 'Unassigned'
    : (currentStatus === 'Under Investigation' || currentStatus === 'Investigating') ? 'Under Review'
    : (currentStatus === 'Reviewed') ? 'Resolved'
    : currentStatus;
  const optionsHtml = options.map(opt =>
    `<option value="${opt}" ${opt === normCurrent ? 'selected' : ''}>${opt}</option>`
  ).join('');
  return `<select class="status-select" data-report-id="${reportId}">${optionsHtml}</select>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function classifyRisk(score) {
  if (score >= 0.85) return 'critical';
  if (score >= 0.40) return 'warning';
  return 'safe';
}

/**
 * Extracts a readable platform name from a URL.
 * "https://www.facebook.com/scam-page" → "facebook.com"
 * Falls back to the raw URL or "—" if empty.
 */
function extractPlatform(url) {
  if (!url) return '—';
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname || url;
  } catch {
    // Not a valid URL — just show it truncated
    return url.length > 30 ? url.substring(0, 30) + '…' : url;
  }
}

function formatDate(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `${date}<br><small style="color: var(--clr-text-muted);">${time}</small>`;
  } catch {
    return isoString;
  }
}

function formatDateSingleLine(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day:   'numeric',
      year:  'numeric',
      hour:  '2-digit',
      minute:'2-digit'
    });
  } catch {
    return isoString;
  }
}

function formatDatePlain(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
  } catch {
    return isoString;
  }
}

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
    return `${date}<br>${time}`; // HTML line break for UI display
  } catch {
    return isoString;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function generateReportHash(report) {
  // Simple hash function for authenticity
  const data = `${report.id}${report.created_at}${report.user_id || ''}${Date.now()}`;
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).toUpperCase().padStart(8, '0');
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

// ── Cleanup on page unload ────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  if (snapshotUnsubscribe) snapshotUnsubscribe();
});
