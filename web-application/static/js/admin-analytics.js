/**
 * admin-analytics.js — Admin Threat Analytics dashboard.
 * Displays threat patterns, AI-expert alignment, and platform activity.
 */

'use strict';

let domainsChart = null;
let alignmentChart = null;
let activityChart = null;

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
    renderDomainsChart(reports);
    renderAlignmentChart(reports);
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

function renderExpertPerformance(reports, users, period) {
  const grid = document.getElementById('perf-cards-grid');
  const empty = document.getElementById('perf-empty');
  if (!grid) return;

  // Remove skeleton cards
  grid.querySelectorAll('.skeleton-perf-card').forEach(el => el.remove());

  // Determine cutoff date
  const now = Date.now();
  const cutoffMs = period === 'daily' ? 86400000 : period === 'weekly' ? 604800000 : 2592000000;
  const cutoff = now - cutoffMs;

  // Filter resolved reports within period
  const periodReports = reports.filter((r) => {
    const reviewed = r.status === 'Reviewed' || r.status === 'reviewed';
    if (!reviewed) return false;
    const ts = r.resolvedAt?.toMillis?.() || r.reviewedAt?.toMillis?.() || r.updated_at?.toMillis?.() || 0;
    return ts >= cutoff;
  });

  // Build expert-keyed stats
  const expertMap = {};
  periodReports.forEach((r) => {
    const uid = r.reviewedBy || r.reviewed_by || null;
    if (!uid) return;
    if (!expertMap[uid]) {
      expertMap[uid] = { resolved: 0, tatSum: 0, tatCount: 0, confirmed: 0, safe: 0 };
    }
    const stat = expertMap[uid];
    stat.resolved++;
    const resolvedTs = r.resolvedAt?.toMillis?.() || r.reviewedAt?.toMillis?.() || 0;
    const createdTs = r.created_at?.toMillis?.() || 0;
    if (resolvedTs && createdTs && resolvedTs > createdTs) {
      stat.tatSum += (resolvedTs - createdTs) / 60000;
      stat.tatCount++;
    }
    const verdict = (r.expert_verdict || r.expertVerdict || '').toLowerCase();
    if (verdict === 'confirmed threat') stat.confirmed++;
    else stat.safe++;
  });

  const expertUids = Object.keys(expertMap);
  if (!expertUids.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  // Resolve display names
  const userLookup = {};
  users.forEach((u) => { userLookup[u.id] = u.displayName || u.email || u.id; });

  grid.innerHTML = expertUids.map((uid) => {
    const s = expertMap[uid];
    const name = userLookup[uid] || uid.slice(0, 8);
    const avgTat = s.tatCount ? Math.round(s.tatSum / s.tatCount) : null;
    const tatLabel = avgTat !== null ? (avgTat < 60 ? `${avgTat}m` : `${Math.round(avgTat / 60)}h ${avgTat % 60}m`) : '—';
    const threatPct = s.resolved ? Math.round((s.confirmed / s.resolved) * 100) : 0;
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

// ── Skeleton Handling ───────────────────────────────────────────────────────

function hideSkeletons() {
  // Remove is-skeleton classes from headers
  document.querySelectorAll('.reports-header__title.is-skeleton, .reports-header__count.is-skeleton').forEach((el) => {
    el.classList.remove('is-skeleton');
    el.style.width = '';
  });
  
  // Domains chart
  const domainsSkeleton = document.getElementById('domains-skeleton');
  const domainsCanvas = document.getElementById('domains-chart');
  if (domainsSkeleton) domainsSkeleton.style.display = 'none';
  if (domainsCanvas) domainsCanvas.style.display = 'block';
  
  // Alignment chart
  const alignmentSkeleton = document.getElementById('alignment-skeleton');
  const alignmentCanvas = document.getElementById('alignment-chart');
  const alignmentCenter = document.getElementById('alignment-center-text');
  if (alignmentSkeleton) alignmentSkeleton.style.display = 'none';
  if (alignmentCanvas) alignmentCanvas.style.display = 'block';
  if (alignmentCenter) alignmentCenter.style.display = 'block';
  
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
