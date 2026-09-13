/**
 * admin-analytics.js — Admin Threat Analytics dashboard.
 * Displays threat patterns, AI-expert alignment, and platform activity.
 */

'use strict';

let domainsChart = null;
let alignmentChart = null;
let activityChart = null;
let threatSourceChart = null;

let _allReports = [];
let _allUsers = [];
let _perfPeriod = 'daily';

// ── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('suriin:auth-ready', (e) => {
  const { role } = e.detail;

  if (role !== 'admin') {
    window.location.href = '/admin-dashboard';
    return;
  }

  initPerfPeriodButtons();
  initExecutiveReportButton();
  loadAnalytics();
});

// ── Expert Performance Period Filter ─────────────────────────────────────────

function initPerfPeriodButtons() {
  document.querySelectorAll('#perf-period-group button').forEach((btn) => {
    btn.addEventListener('click', () => {
      _perfPeriod = btn.dataset.period;
      document.querySelectorAll('#perf-period-group button').forEach((b) => {
        b.classList.toggle('btn--primary', b === btn);
        b.classList.toggle('btn--ghost', b !== btn);
      });
      renderExpertPerformance(_allReports, _allUsers, _perfPeriod);
    });
  });
}

// ── Data Loading ───────────────────────────────────────────────────────────

async function loadAnalytics() {
  const db = window.__suriinFirestore;
  if (!db) {
    console.error('[SuriinAI Admin] Firestore not available.');
    return;
  }

  try {
    const [reportsSnapshot, usersSnapshot] = await Promise.all([
      db.collection('Reports').get(),
      db.collection('Users').get()
    ]);

    const reports = reportsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const users = usersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    _allReports = reports;
    _allUsers = users;

    renderExpertPerformance(reports, users, _perfPeriod);
    renderThreatSourceChart(reports);
    renderActivityChart(users, reports);

    // Remove skeletons and show charts
    hideSkeletons();
  } catch (err) {
    console.error('[SuriinAI Admin] Failed to load analytics:', err);
    // Still remove skeletons on error to show error state
    hideSkeletons();
  }
}

// ── Expert Performance Rendering ────────────────────────────────────────────

// Helper to normalize Firestore timestamps (handles Timestamp objects, ISO strings, seconds/nanos, or plain numbers)
function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  if (ts.toMillis && typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts.seconds !== undefined) return ts.seconds * 1000;
  return 0;
}

function renderExpertPerformance(reports, users, period) {
  const grid = document.getElementById('perf-cards-grid');
  const empty = document.getElementById('perf-empty');
  if (!grid) return;

  // Remove skeleton cards
  grid.querySelectorAll('.skeleton-perf-card').forEach(el => el.remove());

  // Debug: log all unique statuses and show first few reports
  const allStatuses = [...new Set(reports.map(r => r.status))];
  console.log('[ExpertPerf] All status values in database:', allStatuses);
  console.log('[ExpertPerf] First 3 reports:', reports.slice(0, 3).map(r => ({
    id: r.id,
    status: r.status,
    updated_at: r.updated_at,
    assigned_to: r.assigned_to,
    updated_by: r.updated_by
  })));

  // Determine cutoff date
  const now = Date.now();
  const cutoffMs = period === 'daily' ? 86400000 : period === 'weekly' ? 604800000 : 2592000000;
  const cutoff = now - cutoffMs;

  // Filter resolved reports within period
  // Use resolvedAt as resolution timestamp, fallback to updated_at or created_at
  const resolvedReports = reports.filter((r) => {
    const statusLower = (r.status || '').toLowerCase();
    return statusLower === 'resolved' || statusLower === 'reviewed';
  });

  const periodReports = resolvedReports.filter((r) => {
    const ts = toMillis(r.resolvedAt || r.updated_at || r.updatedAt || r.created_at);
    return ts >= cutoff;
  });

  // Build expert-keyed stats (expert UID in assigned_to or updated_by)
  const expertMap = {};
  periodReports.forEach((r) => {
    const uid = r.assigned_to || r.updated_by || r.resolved_by || null;
    if (!uid) return;
    if (!expertMap[uid]) {
      expertMap[uid] = { resolved: 0, tatSum: 0, tatCount: 0, confirmed: 0, safe: 0 };
    }
    const stat = expertMap[uid];
    stat.resolved++;
    // Calculate TAT from claimed_at to resolvedAt (resolution time)
    const claimedTs = toMillis(r.claimed_at || r.claimedAt || r.created_at);
    const resolvedTs = toMillis(r.resolvedAt || r.updated_at || r.updatedAt);
    if (resolvedTs && claimedTs && resolvedTs > claimedTs) {
      stat.tatSum += (resolvedTs - claimedTs) / 60000;
      stat.tatCount++;
    }
    // Check verdict for threat vs safe classification
    const verdict = (r.expert_verdict || r.expertVerdict || '').toLowerCase();
    if (verdict === 'confirmed threat' || verdict === 'confirmed scam') stat.confirmed++;
    else stat.safe++;
  });

  // Get all expert-role users to show cards even with zero data
  const expertUsers = users.filter((u) => u.role === 'expert' || u.role === 'Expert');

  // If no experts found, show empty state
  if (!expertUsers.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  // Resolve display names
  const userLookup = {};
  users.forEach((u) => { userLookup[u.id] = u.displayName || u.email || u.id; });

  // Render cards for ALL experts (including zero-data state)
  grid.innerHTML = expertUsers.map((user) => {
    const uid = user.id;
    const s = expertMap[uid] || { resolved: 0, tatSum: 0, tatCount: 0, confirmed: 0, safe: 0 };
    const name = userLookup[uid] || uid.slice(0, 8);
    const avgTat = s.tatCount > 0 ? Math.round(s.tatSum / s.tatCount) : 0;
    const tatLabel = s.tatCount > 0
      ? (avgTat < 60 ? `${avgTat}m` : `${Math.round(avgTat / 60)}h ${avgTat % 60}m`)
      : '0h 0m';
    // Strict threat percentage: (Confirmed / Total Resolved) * 100 with divide-by-zero protection
    const totalResolved = s.confirmed + s.safe;
    const threatPct = totalResolved > 0 ? Math.round((s.confirmed / totalResolved) * 100) : 0;
    return `
      <div style="background: var(--clr-bg-card); border: 1px solid var(--clr-border); border-radius: var(--radius-lg); padding: var(--space-lg);">
        <div style="font-size: var(--font-sm); font-weight: 600; color: var(--clr-text-primary); margin-bottom: var(--space-md); display: flex; align-items: center; gap: var(--space-sm);">
          <span style="width:32px;height:32px;border-radius:50%;background:var(--clr-accent-muted);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--clr-accent);">${name.charAt(0).toUpperCase()}</span>
          ${escapeHtml(name)}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--space-sm);">
          <div style="text-align:center;">
            <div style="font-size:1.4rem;font-weight:700;color:var(--clr-text-primary);">${s.resolved}</div>
            <div style="font-size:var(--font-xs);color:var(--clr-text-muted);margin-top:2px;">Resolved</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:1.4rem;font-weight:700;color:var(--clr-text-primary);">${tatLabel}</div>
            <div style="font-size:var(--font-xs);color:var(--clr-text-muted);margin-top:2px;">Avg TAT</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:1.4rem;font-weight:700;color:${threatPct >= 50 ? '#ef4444' : '#22c55e'};">${threatPct}%</div>
            <div style="font-size:var(--font-xs);color:var(--clr-text-muted);margin-top:2px;">Threats</div>
          </div>
        </div>
        <div style="margin-top:var(--space-md);display:flex;gap:var(--space-xs);">
          <span style="flex:1;background:rgba(239,68,68,0.12);color:#ef4444;border-radius:var(--radius-sm);padding:3px 6px;font-size:var(--font-xs);text-align:center;">&#x1F534; ${s.confirmed} Threats</span>
          <span style="flex:1;background:rgba(34,197,94,0.12);color:#22c55e;border-radius:var(--radius-sm);padding:3px 6px;font-size:var(--font-xs);text-align:center;">&#x1F7E2; ${s.safe} Safe</span>
        </div>
      </div>`;
  }).join('');
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Chart: Threat Source Attribution (AI vs SEC Breakdown) ────────────────

function renderThreatSourceChart(reports) {
  const ctx = document.getElementById('threat-source-chart');
  if (!ctx) return;

  // Count threat sources based on dual-engine scan results
  let pureAI = 0;      // AI flagged only (no SEC match)
  let pureSEC = 0;     // SEC matched only (AI said safe)
  let dualEngine = 0;  // Both AI and SEC flagged

  reports.forEach((report) => {
    const riskScore = report.risk_score || 0;
    const normalizedRisk = riskScore > 1 ? riskScore / 100 : riskScore; // Normalize 0-100 to 0-1

    // Check SEC watchlist match
    const secMatched = report.gov_records?.is_flagged === true ||
                       report.sec_match === true ||
                       (report.threat_level === 'Critical' && normalizedRisk < 0.7);

    // Check AI threat detection
    const aiVerdict = report.ai_verdict || report.ai_analysis?.status || '';
    const aiFlagged = aiVerdict.toLowerCase().includes('scam') ||
                      aiVerdict.toLowerCase().includes('threat') ||
                      aiVerdict.toLowerCase().includes('critical') ||
                      aiVerdict.toLowerCase().includes('warning') ||
                      normalizedRisk >= 0.4;

    // Categorize based on dual-engine logic:
    // - Pure AI: AI flagged, no SEC match
    // - Pure SEC: SEC matched, AI didn't flag
    // - Dual Engine: Both flagged
    if (aiFlagged && secMatched) {
      dualEngine++;
    } else if (aiFlagged && !secMatched) {
      pureAI++;
    } else if (!aiFlagged && secMatched) {
      pureSEC++;
    }
    // Reports where neither flagged are not threats, so we don't count them
  });

  // Update stat displays
  const statPureAI = document.getElementById('stat-pure-ai');
  const statPureSEC = document.getElementById('stat-pure-sec');
  const statDualEngine = document.getElementById('stat-dual-engine');

  if (statPureAI) statPureAI.textContent = pureAI;
  if (statPureSEC) statPureSEC.textContent = pureSEC;
  if (statDualEngine) statDualEngine.textContent = dualEngine;

  const total = pureAI + pureSEC + dualEngine;

  // If no threat data, show empty state
  if (total === 0) {
    if (threatSourceChart) {
      threatSourceChart.destroy();
      threatSourceChart = null;
    }
    return;
  }

  threatSourceChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Pure AI Matches', 'Pure SEC Matches', 'Dual Engine Consensus'],
      datasets: [{
        data: [pureAI, pureSEC, dualEngine],
        backgroundColor: ['#8B5CF6', '#F59E0B', '#EF4444'],
        borderWidth: 2,
        borderColor: 'rgba(0,0,0,0.3)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          display: false // We have a custom legend
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const value = context.raw;
              const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `${context.label}: ${value} (${percentage}%)`;
            }
          }
        }
      }
    }
  });
}

// ── Skeleton Handling ───────────────────────────────────────────────────────

function hideSkeletons() {
  // Remove is-skeleton classes from headers
  document.querySelectorAll('.reports-header__title.is-skeleton, .reports-header__count.is-skeleton').forEach((el) => {
    el.classList.remove('is-skeleton');
    el.style.width = '';
  });

  // Activity chart
  const activitySkeleton = document.getElementById('activity-skeleton');
  const activityCanvas = document.getElementById('activity-chart');
  if (activitySkeleton) activitySkeleton.style.display = 'none';
  if (activityCanvas) activityCanvas.style.display = 'block';
}

// ── Chart 1: Most Exploited Domains (Pie Chart) ─────────────────────────────

function renderDomainsChart(reports) {
  const ctx = document.getElementById('domains-chart');
  if (!ctx) return;

  // Extract domains from URLs and count
  const domainCounts = {};
  reports.forEach((report) => {
    const url = report.url || '';
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    } catch {
      // Invalid URL, skip
    }
  });

  // Sort by count and take top 8, bucket rest as "Others"
  const sorted = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
  const top8 = sorted.slice(0, 8);
  const others = sorted.slice(8).reduce((sum, [, count]) => sum + count, 0);

  const labels = top8.map(([domain]) => domain);
  const data = top8.map(([, count]) => count);

  if (others > 0) {
    labels.push('Others');
    data.push(others);
  }

  // Color palette
  const colors = [
    '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
    '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16',
    '#6B7280'
  ];

  domainsChart = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: colors.slice(0, labels.length),
        borderWidth: 2,
        borderColor: 'rgba(0,0,0,0.3)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: '#E5E7EB',
            font: { size: 12 },
            padding: 16,
            boxWidth: 12
          }
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = ((context.raw / total) * 100).toFixed(1);
              return `${context.label}: ${context.raw} (${percentage}%)`;
            }
          }
        }
      }
    }
  });
}

// ── Chart 2: AI vs Expert Alignment (Doughnut Chart) ────────────────────────

function renderAlignmentChart(reports) {
  const ctx = document.getElementById('alignment-chart');
  if (!ctx) return;

  // Filter to reviewed reports
  const reviewedReports = reports.filter((r) =>
    r.status === 'Reviewed' || r.status === 'Dismissed'
  );

  let aligned = 0;
  let misaligned = 0;

  reviewedReports.forEach((report) => {
    const aiVerdict = report.ai_analysis?.status || report.ai_status || '';
    const aiConfidence = report.ai_analysis?.confidence || 0;
    const expertVerdict = report.expert_verdict || report.expertVerdict || '';
    const status = report.status;

    // Determine alignment
    // Aligned: AI threat + Expert confirms threat, OR AI safe + Expert dismisses
    const aiIsThreat = aiVerdict.toLowerCase().includes('scam') ||
                       aiVerdict.toLowerCase().includes('threat') ||
                       aiVerdict.toLowerCase().includes('phishing') ||
                       aiConfidence < 0.5; // Low confidence often indicates threat

    const expertConfirmedThreat = expertVerdict.toLowerCase().includes('threat') ||
                                   expertVerdict.toLowerCase().includes('scam') ||
                                   status === 'Reviewed';
    const expertDismissed = status === 'Dismissed';

    if ((aiIsThreat && expertConfirmedThreat) || (!aiIsThreat && expertDismissed)) {
      aligned++;
    } else {
      misaligned++;
    }
  });

  // Update center text
  const totalEl = document.getElementById('alignment-total');
  if (totalEl) totalEl.textContent = reviewedReports.length;

  alignmentChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Aligned', 'Misaligned'],
      datasets: [{
        data: [aligned, misaligned],
        backgroundColor: ['#10B981', '#EF4444'],
        borderWidth: 2,
        borderColor: 'rgba(0,0,0,0.3)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#E5E7EB',
            font: { size: 14 },
            padding: 20
          }
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = total > 0 ? ((context.raw / total) * 100).toFixed(1) : 0;
              return `${context.label}: ${context.raw} (${percentage}%)`;
            }
          }
        }
      }
    }
  });
}

// ── Chart 3: Platform Activity (Line Chart) ─────────────────────────────────

function renderActivityChart(users, reports) {
  const ctx = document.getElementById('activity-chart');
  if (!ctx) return;

  // Generate last 3 months labels
  const months = [];
  const today = new Date();
  for (let i = 2; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric' }));
  }

  // Count user signups by month
  const userSignups = months.map((monthLabel) => {
    return users.filter((u) => {
      const created = u.createdAt ? new Date(u.createdAt) : null;
      if (!created) return false;
      const label = created.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      return label === monthLabel;
    }).length;
  });

  // Count reports filed by month
  const reportsFiled = months.map((monthLabel) => {
    return reports.filter((r) => {
      const created = r.created_at ? new Date(r.created_at) : null;
      if (!created) return false;
      const label = created.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      return label === monthLabel;
    }).length;
  });

  activityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months,
      datasets: [
        {
          label: 'User Signups',
          data: userSignups,
          borderColor: '#3B82F6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 6,
          pointBackgroundColor: '#3B82F6'
        },
        {
          label: 'Reports Filed',
          data: reportsFiled,
          borderColor: '#F59E0B',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 6,
          pointBackgroundColor: '#F59E0B'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            color: '#E5E7EB',
            font: { size: 12 },
            usePointStyle: true,
            padding: 20
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.8)',
          titleColor: '#E5E7EB',
          bodyColor: '#E5E7EB',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12
        }
      },
      scales: {
        x: {
          ticks: { color: '#9CA3AF' },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y: {
          ticks: { color: '#9CA3AF' },
          grid: { color: 'rgba(255,255,255,0.05)' },
          beginAtZero: true
        }
      }
    }
  });
}

// ── Executive Report PDF Export ─────────────────────────────────────────────

function initExecutiveReportButton() {
  const btn = document.getElementById('btn-export-executive-report');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const user = firebase.auth().currentUser;
    if (!user) {
      console.error('[ExecutiveReport] User not authenticated');
      return;
    }

    // Show loading state
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 1s linear infinite;margin-right:6px;"></span>Generating...';

    try {
      const token = await user.getIdToken();
      const response = await fetch(`/api/admin/executive-report?period=${_perfPeriod}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const pdfBlob = await response.blob();
      showExecutivePdfPreview(pdfBlob, `Executive_Security_Report_${new Date().toISOString().slice(0,10)}.pdf`);

    } catch (err) {
      console.error('[ExecutiveReport] Failed to generate report:', err);
      alert('Failed to generate executive report. Please try again.');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  });
}

function showExecutivePdfPreview(pdfBlob, fileName) {
  // Inject styles if not present
  if (!document.getElementById('pdf-preview-styles')) {
    const styles = `
      .pdf-preview-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 20000; padding: 20px;
      }
      .pdf-preview-card {
        width: 90%; max-width: 900px; height: 85vh;
        background: #1A1928; border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.1);
        display: flex; flex-direction: column;
        box-shadow: 0 25px 50px rgba(0,0,0,0.5);
      }
      .pdf-preview-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      .pdf-preview-header__title { font-weight: 600; color: #fff; }
      .pdf-preview-header__btn {
        padding: 8px 16px; border-radius: 6px; font-size: 14px;
        cursor: pointer; transition: all 0.2s; text-decoration: none;
      }
      .pdf-preview-header__btn--download {
        background: #6C63FF; color: white; border: none; margin-right: 10px;
      }
      .pdf-preview-header__btn--download:hover { background: #5a52d5; }
      .pdf-preview-header__btn--close {
        background: transparent; color: #888;
        border: 1px solid rgba(255,255,255,0.2);
      }
      .pdf-preview-header__btn--close:hover { background: rgba(255,255,255,0.1); }
      .pdf-preview-frame {
        flex: 1; border: none; border-radius: 0 0 12px 12px;
        background: white;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;
    const styleEl = document.createElement('style');
    styleEl.id = 'pdf-preview-styles';
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);
  }

  const blobUrl = URL.createObjectURL(pdfBlob);

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'pdf-preview-overlay';

  const card = document.createElement('div');
  card.className = 'pdf-preview-card';

  const header = document.createElement('div');
  header.className = 'pdf-preview-header';

  const title = document.createElement('span');
  title.className = 'pdf-preview-header__title';
  title.textContent = `📄 ${fileName}`;

  const dlBtn = document.createElement('a');
  dlBtn.className = 'pdf-preview-header__btn pdf-preview-header__btn--download';
  dlBtn.href = blobUrl;
  dlBtn.download = fileName;
  dlBtn.textContent = '⬇ Download';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pdf-preview-header__btn pdf-preview-header__btn--close';
  closeBtn.textContent = '✕ Close';
  closeBtn.addEventListener('click', () => {
    URL.revokeObjectURL(blobUrl);
    overlay.remove();
  });

  header.appendChild(title);
  header.appendChild(dlBtn);
  header.appendChild(closeBtn);

  const iframe = document.createElement('iframe');
  iframe.className = 'pdf-preview-frame';
  iframe.src = blobUrl;

  card.appendChild(header);
  card.appendChild(iframe);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      URL.revokeObjectURL(blobUrl);
      overlay.remove();
    }
  });
}
