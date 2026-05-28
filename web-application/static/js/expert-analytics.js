// expert-analytics.js - Scam Analytics Dashboard

let threatChart = null;
let triageImpactChart = null;

function getThemeColor(varName, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return value || fallback;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Check if user is authenticated
  await new Promise((resolve) => {
    firebase.auth().onAuthStateChanged((user) => {
      if (!user) {
        window.location.href = '/';
      }
      resolve();
    });
  });

  // Show dashboard after auth check
  document.getElementById('dashboard-wrapper').style.display = '';
  document.getElementById('loading-overlay').style.display = 'none';

  // Load analytics data
  await loadAnalyticsData();
});

async function loadAnalyticsData() {
  try {
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) return;
    const uid = currentUser.uid;

    const db = firebase.firestore();
    const reportsRef = db.collection('Reports');

    // Query only reports reviewed by the current expert
    const snapshot = await reportsRef.where('reviewedBy', '==', uid).get();

    const analyticsData = {
      // KPIs
      sumResolutionMs: 0,
      resolutionCount: 0,
      throughput24h: 0,
      correctiveActions: 0,
      complexTriage: 0,
      // Resolved-only charts
      threatDist: { safe: 0, warning: 0, critical: 0 },
      triageImpact: { confirmations: 0, overrides: 0, uncertainty: 0 }
    };

    const now = Date.now();
    const day24Ms = 24 * 60 * 60 * 1000;

    snapshot.forEach((doc) => {
      const report = doc.data() || {};

      // Only count resolved reports
      const status = String(report.status || '').trim();
      const isResolved = (status === 'Reviewed' || status === 'Resolved' || status === 'Dismissed');
      if (!isResolved) return;

      // Skip reopened cases (they were resolved then reopened)
      const wasReopened = Array.isArray(report.resolutionHistory) && 
        report.resolutionHistory.some(h => 
          String(h.status || '').toLowerCase().includes('reopen') ||
          String(h.action || '').toLowerCase().includes('reopen')
        );
      if (wasReopened) return;

      const rs = Number(report.risk_score ?? 0);
      const expertVerdict = String(report.expert_verdict || report.expertVerdict || '').trim();
      const expertIsThreat = (expertVerdict === 'Confirmed Threat');
      const expertIsSafe = (expertVerdict === 'Safe');
      const aiWarning = rs >= 0.4 && rs < 0.7;
      const aiCritical = rs >= 0.7;
      const aiIsThreat = rs >= 0.4; // Warning or Critical

      // Average Resolution Time (claimedAt -> resolvedAt) - ALL TIME
      const claimedAt = toDate(getFirstNonEmpty(report.claimedAt, report.claimed_at));
      const resolvedAt = toDate(getFirstNonEmpty(report.resolvedAt, report.reviewedAt, report.dismissedAt));
      
      // Skip reports without claimedAt (older reports before this feature)
      if (claimedAt && resolvedAt) {
        const diff = resolvedAt.getTime() - claimedAt.getTime();
        if (diff > 0) {
          analyticsData.sumResolutionMs += diff;
          analyticsData.resolutionCount += 1;
        }
        
        // Daily Throughput: last 24 hours only
        const resolvedTime = resolvedAt.getTime();
        if ((now - resolvedTime) <= day24Ms) {
          analyticsData.throughput24h += 1;
        }
      }

      // Corrective Actions: expert disagreed with AI - ALL TIME
      if (expertVerdict) {
        if (aiIsThreat !== expertIsThreat) analyticsData.correctiveActions += 1;
      }

      // Complex Triage: AI Warning band - ALL TIME
      if (aiWarning) analyticsData.complexTriage += 1;

      // Threat Distribution (exclusive, hybrid) - ALL TIME
      if (aiWarning) {
        analyticsData.threatDist.warning += 1;
      } else if (expertIsThreat && aiCritical) {
        analyticsData.threatDist.critical += 1;
      } else if (expertIsSafe) {
        analyticsData.threatDist.safe += 1;
      }

      // Triage Impact (exclusive stacks) - ALL TIME
      if (aiWarning) {
        analyticsData.triageImpact.uncertainty += 1;
      } else if (expertVerdict) {
        if (aiIsThreat === expertIsThreat) {
          analyticsData.triageImpact.confirmations += 1;
        } else {
          analyticsData.triageImpact.overrides += 1;
        }
      }
    });

    // Update stat cards
    const labelEl = document.querySelector('#card-avg-rt .stat-card__label');
    if (analyticsData.resolutionCount > 0) {
      const avgMs = Math.floor(analyticsData.sumResolutionMs / analyticsData.resolutionCount);
      setTextContent('stat-analytics-avg-rt', formatDurationShort(avgMs));
      if (labelEl) labelEl.textContent = 'Average Resolution Time';
    } else {
      setTextContent('stat-analytics-avg-rt', String(analyticsData.throughput24h));
      if (labelEl) labelEl.textContent = 'Daily Throughput';
    }
    setTextContent('stat-analytics-corrective', analyticsData.correctiveActions);
    setTextContent('stat-analytics-complex', analyticsData.complexTriage);

    // Render charts
    setTimeout(() => {
      createTriageImpactChart(analyticsData.triageImpact);
      createThreatBarChart(analyticsData.threatDist);
    }, 100);
  } catch (error) {
    console.error('Error loading analytics data:', error);
  }
}


function getFirstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}


function createTriageImpactChart(impact) {
  const el = document.getElementById('analytics-triage-impact');
  if (!el) return;

  if (triageImpactChart) triageImpactChart.destroy();

  const textPrimary = getThemeColor('--clr-text-primary', '#E5E7EB');

  // Vertical grouped bars: three categories on X, single dataset values
  const labels = ['Confirmations', 'Overrides', 'Uncertainty'];
  const data = [impact.confirmations, impact.overrides, impact.uncertainty];
  const backgroundColors = ['#22c55e', '#ef4444', '#f59e0b'];

  triageImpactChart = new Chart(el, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Number of Cases',
        data,
        backgroundColor: backgroundColors,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: textPrimary }, grid: { display: false } },
        y: { ticks: { color: textPrimary, precision: 0 }, grid: { color: 'rgba(148,163,184,0.15)' } }
      }
    }
  });
}

function createThreatBarChart(buckets) {
  const el = document.getElementById('analytics-threat-bar-chart');
  if (!el) return;

  if (threatChart) threatChart.destroy();

  const textPrimary = getThemeColor('--clr-text-primary', '#E5E7EB');
  const barColors = ['#22c55e', '#f59e0b', '#ef4444']; // green, amber, red

  threatChart = new Chart(el, {
    type: 'bar',
    data: {
      labels: ['Safe', 'Warning', 'Critical'],
      datasets: [{
        label: 'Reports',
        data: [buckets.safe, buckets.warning, buckets.critical],
        backgroundColor: barColors,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: textPrimary },
          grid: { display: false }
        },
        y: {
          ticks: { color: textPrimary, precision: 0 },
          grid: { color: 'rgba(148,163,184,0.15)' }
        }
      }
    }
  });
}

// Helpers for dates
function toDate(value) {
  if (!value) return null;
  try {
    if (typeof value.toDate === 'function') return value.toDate(); // Firestore Timestamp
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}


function setTextContent(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatDurationShort(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
