/**
 * dashboard.js â€” Suriin AI Real-Time Dashboard Logic
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * Handles:
 *   1. Real-time Firestore listeners (onSnapshot) for the Reports collection
 *   2. User Dashboard: filtered to current user's reports only
 *   3. Expert Dashboard: all reports, with status filtering and update actions
 *   4. Stats card computation
 *   5. Toast notifications for status changes
 *   6. Report Details Modal (open/close/populate)
 *   7. PDF Evidence Download (print-based)
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

// â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Page detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const isDashboardExpertPage = window.location.pathname.includes('admin-dashboard');

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  MAIN INIT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

  initFilterChips();
  initTabs();
  setupModal();
  // Notification bell is now handled by notification-bell.js
  // setupNotificationBell(user, db);

  // â”€â”€ Set up the real-time listener â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        return; // identical to last render â€” skip
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

  // â”€â”€ Open modal from URL param (if present) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const params = new URLSearchParams(window.location.search);
  const targetReportId = params.get('report_id');
  if (targetReportId) {
    setTimeout(() => {
      openReportModal(targetReportId);
      window.history.replaceState({}, document.title, window.location.pathname);
    }, 800);
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STATS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function updateStats() {
  if (isDashboardExpertPage) {
    updateExpertStats();
  } else {
    updateUserStats();
  }
}

function updateUserStats() {
  // Total Reports: count ALL reports for this user (including Dismissed)
  const total = allReports.length;

  // Under Investigation: only active investigation statuses (backward compatible)
  const underInvestigation = allReports.filter(r =>
    r.status === 'Under Investigation' || r.status === 'Investigating' || r.status === 'Under Review'
  ).length;

  // Confirmed Threat: only Resolved/Reviewed reports with threat verdict (backward compatible)
  // Excludes Dismissed reports
  const notDismissed = allReports.filter(r => r.status !== 'Dismissed');
  const confirmed = notDismissed.filter(r => {
    const verdict = (r.expert_verdict || r.expertVerdict || '').toLowerCase();
    const isResolved = r.status === 'Resolved' || r.status === 'Reviewed';
    return isResolved && (verdict.includes('threat') || verdict === 'confirmed threat');
  }).length;

  // Verified Safe: only Resolved/Reviewed reports with safe verdict (backward compatible)
  const verifiedSafe = notDismissed.filter(r => {
    const verdict = (r.expert_verdict || r.expertVerdict || '').toLowerCase();
    const isResolved = r.status === 'Resolved' || r.status === 'Reviewed';
    return isResolved && verdict.includes('safe');
  }).length;

  animateCounter('stat-total', total);
  animateCounter('stat-under-investigation', underInvestigation);
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

  // First ever render: instant set â€” no animation to cause layout bounce
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  TABLE RENDERING
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
            <div style="font-size: 2.5rem; margin-bottom: 16px;">ðŸ“­</div>
            <div style="font-weight: 600; font-size: var(--font-md); margin-bottom: 8px; color: var(--clr-text-secondary);">No reports submitted yet</div>
            <div style="font-size: var(--font-sm); max-width: 400px; margin: 0 auto; line-height: 1.5;">
              You haven't submitted any scam reports yet. Install the <strong>Suriin AI Chrome Extension</strong> and browse normally â€” it will automatically detect and submit suspicious content for analysis.
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
    // Filters active but no matches â€” full styled empty state (table never collapses)
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
    // â”€â”€ Pagination Logic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // Attach click listener on each row (User dashboard â€” row replaces View button)
  if (!isDashboardExpertPage) {
    tbody.querySelectorAll('tr[data-report-id]').forEach((row) => {
      row.addEventListener('click', () => {
        openReportModal(row.dataset.reportId);
      });
    });
  }
}

// â”€â”€ Risk Factor structured HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ AI Verdict Badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  return '<span class="badge">' + (v || 'â€”') + '</span>';
}

// â”€â”€ Expert Verdict Badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    if (v.includes('safe')) {
      return '<span class="badge badge--safe">Verified Safe</span>';
    } else if (v === 'confirmed threat' || v === 'scam') {
      return '<span class="badge" style="background: rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.35);">Confirmed Threat</span>';
    } else if (verdict) {
      return `<span class="badge">${escapeHtml(verdict)}</span>`;
    }
  }
  return '<span class="badge" style="background: var(--clr-bg-secondary); color: var(--clr-text-muted); border: 1px solid var(--clr-border);">â€”</span>';
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

// â”€â”€ User Dashboard Row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Expert Dashboard Row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildExpertRow(report) {
  const date      = formatDate(report.created_at);
  const userId    = escapeHtml(report.user_id || 'anonymous');
  const url       = escapeHtml(report.url || 'â€”');
  const evidenceRaw = report.evidence || report.text || '';
  const text      = escapeHtml(evidenceRaw.substring(0, 80));
  const riskScore = report.risk_score ?? 0;
  const riskLevel = classifyRisk(riskScore);
  const heuristic = escapeHtml(report.heuristics || 'â€”');
  const rawSt     = report.status || 'Unassigned';
  const status    = (rawSt === 'Under Investigation') ? 'Under Review'
    : (rawSt === 'Pending') ? 'Unassigned'
    : (rawSt === 'Reviewed') ? 'Resolved'
    : rawSt;

  return `
    <td>${date}</td>
    <td class="text-preview" title="${userId}">${userId}</td>
    <td class="url-cell" title="${url}">${url}</td>
    <td class="text-preview" title="${escapeHtml(evidenceRaw)}">${text || 'â€”'}</td>
    <td>${buildRiskBar(riskScore, riskLevel)}</td>
    <td class="text-preview" title="${heuristic}">${heuristic}</td>
    <td>${buildStatusBadge(status)}</td>
    <td>${buildStatusDropdown(report.id, status)}</td>
  `;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  REPORT DETAILS MODAL
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

  // â”€â”€ Populate modal fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Modal Title with shortened Report ID
  const modalTitleEl = document.getElementById('modal-title');
  if (modalTitleEl) {
    const shortId = reportId.slice(-6).toUpperCase();
    modalTitleEl.textContent = `Report Details #${shortId}`;
  }

  // Date
  const dateEl = document.getElementById('modal-date');
  if (dateEl) dateEl.innerHTML = formatDate(report.created_at);

  // Discovery Context: Platform (text only)
  const discoveryPlatformEl = document.getElementById('modal-discovery-platform');
  if (discoveryPlatformEl) discoveryPlatformEl.textContent = extractPlatform(report.url);

  // Discovery Context: Source Identifier
  const srcIdEl = document.getElementById('modal-source-identifier');
  if (srcIdEl) srcIdEl.textContent = report.source_identifier || report.sourceIdentifier || 'â€”';

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

  // Risk Factors â€” structured badge layout
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
      const verdictLower = String(verdictLabel).toLowerCase();
      const verdictClass = verdictLabel === 'Confirmed Threat' ? 'badge--verdict-threat'
                        : verdictLabel === 'Invalid'          ? 'badge--verdict-invalid'
                        : verdictLower.includes('safe')       ? 'badge--verdict-safe'
                        : verdictLabel === 'Investigating'    ? 'badge--status-investigating'
                        : '';
      const verdictHtml = `<span class="badge ${verdictClass}">${escapeHtml(verdictLabel)}</span>`;
      if (verdictBadgeEl) verdictBadgeEl.innerHTML = verdictHtml;
      if (verdictHeaderEl) verdictHeaderEl.innerHTML = verdictHtml;

      // Safe alert vs notes visibility (+ Safety Justification)
      const safeAlertEl = document.getElementById('modal-safe-alert');
      const threatAlertEl = document.getElementById('modal-threat-alert');
      const notesWrapperEl = document.getElementById('modal-expert-notes');
      const notesLabelEl = document.getElementById('modal-expert-notes-label');
      const safeJustWrapper = document.getElementById('modal-safety-justification-wrapper');
      const safeJustEl = document.getElementById('modal-safety-justification');
      const isConfirmedThreat = verdictLower.includes('threat') || verdictLower.includes('confirm');

      if (verdictLower.includes('safe')) {
        if (safeAlertEl) safeAlertEl.style.display = '';
        if (threatAlertEl) threatAlertEl.style.display = 'none';
        if (notesWrapperEl) notesWrapperEl.style.display = 'none';
        if (notesLabelEl) notesLabelEl.style.display = 'none';
        if (safeJustWrapper) safeJustWrapper.style.display = '';
        if (safeJustEl) {
          const sj = report.safety_justification || report.safetyJustification || '';
          safeJustEl.innerHTML = sj ? escapeHtml(sj).replace(/\n/g, '<br>') : '<p class="text-muted">No justification provided.</p>';
        }
      } else if (isConfirmedThreat) {
        // Confirmed Threat: show investigation complete alert, hide safety justification
        if (safeAlertEl) safeAlertEl.style.display = 'none';
        if (threatAlertEl) threatAlertEl.style.display = '';
        if (safeJustWrapper) safeJustWrapper.style.display = 'none';
        if (notesWrapperEl) notesWrapperEl.style.display = '';
        if (notesLabelEl) notesLabelEl.style.display = '';
      } else {
        if (safeAlertEl) safeAlertEl.style.display = 'none';
        if (threatAlertEl) threatAlertEl.style.display = 'none';
        if (notesWrapperEl) notesWrapperEl.style.display = '';
        if (notesLabelEl) notesLabelEl.style.display = '';
        if (safeJustWrapper) safeJustWrapper.style.display = 'none';
      }

      // Change label for Dismissed status and Confirmed Threat
      if (notesLabelEl) {
        if (rawStatus === 'Dismissed') {
          notesLabelEl.textContent = 'Dismissal Note';
        } else if (isConfirmedThreat) {
          notesLabelEl.textContent = 'Remediation Plan';
        } else {
          notesLabelEl.textContent = 'Reasoning & Analysis';
        }
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

      // Resolved At (only for Resolved/Reviewed status)
      const resolvedAtItem = document.getElementById('modal-resolved-at-item');
      const resolvedAtEl = document.getElementById('modal-resolved-at');
      if (resolvedAtItem && resolvedAtEl) {
        const isResolved = ['Resolved', 'Reviewed'].includes(rawStatus);
        if (isResolved && report.resolved_at) {
          resolvedAtEl.textContent = formatDateSingleLine(report.resolved_at);
          resolvedAtItem.style.display = '';
        } else if (isResolved && report.updated_at) {
          resolvedAtEl.textContent = formatDateSingleLine(report.updated_at);
          resolvedAtItem.style.display = '';
        } else {
          resolvedAtItem.style.display = 'none';
        }
      }

      // Expert Notes â†’ Reasoning & Analysis (hidden when Under Investigation)
      if (isUnderInvestigation) {
        if (notesWrapperEl) notesWrapperEl.style.display = 'none';
        if (notesLabelEl) notesLabelEl.style.display = 'none';
      } else if (notesWrapperEl) {
        const verdictLabelLower = (verdictLabel || '').toLowerCase();
        const isSafeVerdict = verdictLabelLower === 'safe';
        const isConfirmedThreatVerdict = verdictLabelLower === 'confirmed threat';
        
        if (isSafeVerdict) {
          // Safe: hide notes (safety justification is shown separately)
          notesWrapperEl.style.display = 'none';
        } else if (isConfirmedThreatVerdict) {
          // Confirmed Threat: show remediation plan
          const remediation = report.remediation_plan || report.remediationPlan || '';
          notesWrapperEl.style.display = '';
          if (remediation) {
            notesWrapperEl.innerHTML = escapeHtml(remediation).replace(/\n/g, '<br>');
          } else {
            notesWrapperEl.innerHTML = '<p class="text-muted">No remediation plan available.</p>';
          }
        } else {
          // Other statuses: show expert notes
          const notes = report.expert_notes || report.expertNotes || '';
          notesWrapperEl.style.display = '';
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
      // Hide the How to Protect Yourself section - remediation plan will be shown in Forensic Review
      showAction = false;
    } else if (rawStatus === 'Dismissed') {
      // No separate dismissal rationale â€” show nothing; use Dismissal Note in Forensic Review instead
      showAction = false;
    }
    actionSection.style.display = showAction ? 'block' : 'none';
  }

  // â”€â”€ Show modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  overlay.style.display = '';
  overlay.classList.remove('closing');
  document.body.style.overflow = 'hidden';

  // Store current report ID for PDF download
  overlay.dataset.currentReportId = reportId;

  // Configure PDF download button based on status
  const downloadBtn = document.getElementById('modal-download-pdf');
  if (downloadBtn) {
    const status = report.status || 'Pending';
    // Show PDF button only for Resolved or Reviewed status
    const showPdf = status === 'Resolved' || status === 'Reviewed';
    
    downloadBtn.style.display = showPdf ? 'flex' : 'none';
    downloadBtn.disabled = !showPdf;
    
    if (showPdf) {
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  PDF EVIDENCE DOWNLOAD (Backend ReportLab)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function downloadPdfEvidence() {
  const overlay = document.getElementById('report-modal-overlay');
  if (!overlay) return;

  const reportId = overlay.dataset.currentReportId;
  if (!reportId) { showToast('Report ID not found.', 'error'); return; }

  // â”€â”€ Loading state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const btn     = document.getElementById('modal-download-pdf');
  const btnText = btn && btn.querySelector('.btn-text');
  const origLabel = btnText ? btnText.textContent : null;
  if (btn)     btn.disabled = true;
  if (btnText) btnText.textContent = 'Generating...';

  try {
    // Get auth token - window.__suriinAuth is { user, role, profile }
    const auth = window.__suriinAuth;
    if (!auth || !auth.user) {
      throw new Error('Not authenticated');
    }
    const token = await auth.user.getIdToken();

    // Call backend endpoint
    const response = await fetch(`/api/report/evidence-pdf?report_id=${encodeURIComponent(reportId)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    // Get PDF blob and show preview
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const shortFileId = reportId.slice(-6).toUpperCase();
    const fileName = `Suriin_Report_${shortFileId}.pdf`;

    // Build preview overlay
    const overlayEl = document.createElement('div');
    overlayEl.className = 'pdf-preview-overlay';

    const cardEl = document.createElement('div');
    cardEl.className = 'pdf-preview-card';

    const headerEl = document.createElement('div');
    headerEl.className = 'pdf-preview-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'pdf-preview-header__title';
    titleEl.textContent = 'Suriin AI - Forensic Evidence Report';

    const dlBtn = document.createElement('a');
    dlBtn.className = 'pdf-preview-header__btn pdf-preview-header__btn--download';
    dlBtn.href = blobUrl;
    dlBtn.download = fileName;
    dlBtn.textContent = 'Download Report';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pdf-preview-header__btn pdf-preview-header__btn--close';
    closeBtn.textContent = 'Close';

    headerEl.appendChild(titleEl);
    headerEl.appendChild(dlBtn);
    headerEl.appendChild(closeBtn);

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

    showToast('PDF ready - preview opened.', 'success');

  } catch (err) {
    console.error('[SuriinAI] PDF generation error:', err);
    showToast('Failed to generate PDF: ' + err.message, 'error');
  } finally {
    if (btn)     btn.disabled = false;
    if (btnText) btnText.textContent = origLabel;
  }
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STATUS UPDATE (Expert only)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function handleStatusChange(e) {
  const select   = e.target;
  const reportId = select.dataset.reportId;
  const newStatus = select.value;

  try {
    // Get fresh token - window.__suriinAuth is { user, role, profile }
    let token;
    if (window.__suriinAuth && window.__suriinAuth.user) {
      token = await window.__suriinAuth.user.getIdToken();
    } else {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`/api/report/${reportId}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ status: newStatus })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Update local state
    const original = allReports.find(r => r.id === reportId);
    if (original) {
      original.status = newStatus;
      renderTable();
    }

    showToast('Status updated', 'success');

  } catch (err) {
    console.error('[SuriinAI Dashboard] Status update error:', err);
    showToast('Failed to update status. Please try again.', 'error');
    // Revert the select to original value
    const original = allReports.find(r => r.id === reportId);
    if (original) select.value = original.status;
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FILTER CHIPS (Expert only)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function initFilterChips() {
  const container = document.getElementById('expert-filter-chips');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-chip');
    if (!btn) return;

    const filter = btn.dataset.filter;
    if (!filter) return;

    // Toggle active state
    const wasActive = btn.classList.contains('active');

    // Deactivate all
    container.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));

    if (!wasActive) {
      btn.classList.add('active');
      currentFilter = filter;
    } else {
      currentFilter = null;
    }

    renderTable();
  });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ═══════════════════════════════════════════════════════════════════════════════
//  TABS (User dashboard)
// ═══════════════════════════════════════════════════════════════════════════════

function initTabs() {
  const tabActive = document.getElementById('tab-active');
  const tabResolved = document.getElementById('tab-resolved');
  const filterBarActive = document.getElementById('user-filter-bar-active');
  const filterBarResolved = document.getElementById('user-filter-bar-resolved');
  
  if (!tabActive || !tabResolved) return; // Not on user dashboard
  
  tabActive.addEventListener('click', () => {
    currentTab = 'active';
    
    // Update tab styles
    tabActive.style.borderBottom = '2px solid var(--clr-accent)';
    tabActive.style.color = 'var(--clr-accent)';
    tabResolved.style.borderBottom = '2px solid transparent';
    tabResolved.style.color = 'var(--clr-text-secondary)';
    
    // Show/hide filter bars
    if (filterBarActive) filterBarActive.style.display = 'block';
    if (filterBarResolved) filterBarResolved.style.display = 'none';
    
    renderTable();
  });
  
  tabResolved.addEventListener('click', () => {
    currentTab = 'resolved';
    
    // Update tab styles
    tabResolved.style.borderBottom = '2px solid var(--clr-accent)';
    tabResolved.style.color = 'var(--clr-accent)';
    tabActive.style.borderBottom = '2px solid transparent';
    tabActive.style.color = 'var(--clr-text-secondary)';
    
    // Show/hide filter bars
    if (filterBarActive) filterBarActive.style.display = 'none';
    if (filterBarResolved) filterBarResolved.style.display = 'block';
    
    renderTable();
  });
}

//  UI BUILDERS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function renderRiskBar(score) {
  const n = Number(score || 0);
  const pct = Math.round(n * 100);
  let level = 'safe';
  if (pct >= 85) level = 'critical';
  else if (pct >= 40) level = 'warning';

  return `
    <div class="risk-bar" title="Risk Score: ${pct}%">
      <div class="risk-bar__fill" style="width: ${pct}%; background: var(--clr-${level});"></div>
      <span class="risk-bar__label" style="color: var(--clr-${level})">${pct}%</span>
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
  let cls = 'badge--safe';
  let label = 'Safe';
  if (pct >= 85) {
    cls = 'badge--critical';
    label = 'Critical';
  } else if (pct >= 40) {
    cls = 'badge--warning';
    label = 'Warning';
  }

  return `<span class="badge ${cls}" title="Threat level: ${label}">${label} (${pct}%)</span>`;
}

function buildStatusBadge(status) {
  const classMap = {
    'Unassigned': 'badge--unassigned',
    'Under Review': 'badge--review',
    'Under Investigation': 'badge--review',
    'Resolved': 'badge--resolved',
    'Reviewed': 'badge--resolved',
    'Dismissed': 'badge--safe',
    'Pending': 'badge--unassigned'
  };
  const cls = classMap[status] || 'badge--default';

  const displayMap = {
    'Under Investigation': 'Under Investigation',
    'Investigating': 'Under Investigation',
    'Resolved': 'Resolved',
    'Reviewed': 'Verified',
    'Dismissed': 'Dismissed',
    'Pending': 'Unassigned',
    'Unassigned': 'Unassigned'
  };
  const displayStatus = displayMap[status] || status;
  return `<span class="badge ${cls}">${escapeHtml(displayStatus)}</span>`;
}

function buildStatusDropdown(reportId, currentStatus) {
  const options = ['Unassigned', 'Under Review', 'Resolved'];
  const normCurrent = currentStatus === 'Pending' ? 'Unassigned' : currentStatus;
  const optionsHtml = options.map(opt =>
    `<option value="${opt}" ${opt === normCurrent ? 'selected' : ''}>${opt}</option>`
  ).join('');
  return `<select class="status-select" data-report-id="${reportId}">${optionsHtml}</select>`;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  UTILITIES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function formatDate(iso) {
  if (!iso) return '<span class="text-muted">â€”</span>';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso) {
  if (!iso) return 'â€”';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDatePlain(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateSingleLine(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function extractPlatform(url) {
  if (!url) return 'â€”';
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('facebook')) return 'Facebook';
    if (hostname.includes('twitter') || hostname.includes('x.com')) return 'Twitter/X';
    if (hostname.includes('instagram')) return 'Instagram';
    if (hostname.includes('telegram')) return 'Telegram';
    if (hostname.includes('discord')) return 'Discord';
    if (hostname.includes('whatsapp')) return 'WhatsApp';
    if (hostname.includes('youtube')) return 'YouTube';
    if (hostname.includes('tiktok')) return 'TikTok';
    if (hostname.includes('linkedin')) return 'LinkedIn';
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function classifyRisk(score) {
  const pct = Math.round((score || 0) * 100);
  if (pct >= 85) return 'critical';
  if (pct >= 40) return 'warning';
  return 'safe';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function generateReportHash(report) {
  // Generate a simple hash for the report
  const data = `${report.id}${report.created_at}${report.risk_score || 0}`;
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).toUpperCase().padStart(8, '0');
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.className = `toast toast--${type}`;
  toast.style.display = 'block';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}

function hideToast() {
  const toast = document.getElementById('toast');
  if (toast) toast.style.display = 'none';
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  RISK FACTOR MODAL
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function showRiskFactorModal() {
  const overlay = document.getElementById('risk-modal-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function hideRiskFactorModal() {
  const overlay = document.getElementById('risk-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAuthAndInit);
} else {
  checkAuthAndInit();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  END OF DASHBOARD.JS
// ═══════════════════════════════════════════════════════════════════════════════
