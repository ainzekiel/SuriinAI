/**
 * admin-audit-logs.js — Admin audit logs viewer.
 * Displays system-altering actions by admins and experts.
 */

'use strict';

let allAuditLogs = [];
let currentFilter = { role: '', action: '' };
let unsubscribeLogs = null;

// ── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('suriin:auth-ready', (e) => {
  const { role } = e.detail;

  if (role !== 'admin') {
    window.location.href = '/admin-dashboard';
    return;
  }

  initFilters();
  loadAuditLogs();
});

// ── Filters ─────────────────────────────────────────────────────────────────

function initFilters() {
  const roleFilter = document.getElementById('filter-role');
  const actionFilter = document.getElementById('filter-action');

  if (roleFilter) {
    roleFilter.addEventListener('change', () => {
      currentFilter.role = roleFilter.value;
      renderAuditTable();
    });
  }

  if (actionFilter) {
    actionFilter.addEventListener('change', () => {
      currentFilter.action = actionFilter.value;
      renderAuditTable();
    });
  }
}

// ── Data Loading ─────────────────────────────────────────────────────────────

function loadAuditLogs() {
  const db = window.__suriinFirestore;
  if (!db) {
    console.error('[SuriinAI Admin] Firestore not available.');
    return;
  }

  // Real-time listener for audit logs
  unsubscribeLogs = db.collection('audit_logs')
    .orderBy('timestamp', 'desc')
    .limit(200)
    .onSnapshot((snapshot) => {
      allAuditLogs = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
      }));

      renderAuditTable();

      // Remove skeleton classes after data loads
      document.querySelectorAll('.skeleton-row').forEach((el) => {
        el.remove();
      });
    }, (err) => {
      console.error('[SuriinAI Admin] Failed to load audit logs:', err);
      
      // Remove skeleton rows even on error so user isn't stuck with loading state
      document.querySelectorAll('.skeleton-row').forEach((el) => {
        el.remove();
      });
      
      // Show error state in table
      const tbody = document.getElementById('audit-tbody');
      const table = document.getElementById('audit-table');
      if (tbody && table) {
        table.style.display = '';
        tbody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; padding: var(--space-xl); color: var(--clr-text-muted);">
              <div style="margin-bottom: var(--space-md);">⚠️</div>
              <div>Unable to load audit logs</div>
              <div style="font-size: var(--font-xs); margin-top: var(--space-sm);">${err.message || 'Check Firestore permissions'}</div>
            </td>
          </tr>
        `;
      }
    });
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderAuditTable() {
  const tbody = document.getElementById('audit-tbody');
  const emptyState = document.getElementById('audit-empty');
  const table = document.getElementById('audit-table');
  const countEl = document.getElementById('audit-count');

  if (!tbody) return;

  // Apply filters
  let filtered = allAuditLogs;
  if (currentFilter.role) {
    filtered = filtered.filter(log => log.actorRole === currentFilter.role);
  }
  if (currentFilter.action) {
    filtered = filtered.filter(log => log.action === currentFilter.action);
  }

  tbody.innerHTML = '';

  const n = filtered.length;
  if (countEl) countEl.textContent = `${n} entr${n === 1 ? 'y' : 'ies'}`;

  if (!n) {
    if (table) table.style.display = 'none';
    if (emptyState) emptyState.style.display = '';
    return;
  }

  if (table) table.style.display = '';
  if (emptyState) emptyState.style.display = 'none';

  filtered.forEach((log) => {
    const tr = document.createElement('tr');

    const timestamp = formatTimestamp(log.timestamp);
    const actorBadge = buildActorBadge(log.actorRole);
    const actionLabel = formatActionLabel(log.action);
    const targetType = log.targetType || '—';
    const details = escapeHtml(log.details || '—');

    tr.innerHTML = `
      <td>${timestamp}</td>
      <td>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          ${actorBadge}
          <span style="font-size: var(--font-xs); color: var(--clr-text-muted);">${escapeHtml(log.actorEmail || 'Unknown')}</span>
        </div>
      </td>
      <td><span class="badge ${getActionBadgeClass(log.action)}">${actionLabel}</span></td>
      <td>${targetType}</td>
      <td style="font-size: var(--font-sm);">${details}</td>
    `;

    tbody.appendChild(tr);
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(timestamp) {
  if (!timestamp) return '—';

  let date;
  if (timestamp.toDate) {
    // Firestore Timestamp
    date = timestamp.toDate();
  } else if (typeof timestamp === 'string') {
    date = new Date(timestamp);
  } else if (typeof timestamp === 'number') {
    date = new Date(timestamp);
  } else {
    return '—';
  }

  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

function buildActorBadge(role) {
  if (role === 'admin') {
    return '<span class="badge badge--critical">Admin</span>';
  }
  if (role === 'expert') {
    return '<span class="badge badge--expert">Expert</span>';
  }
  return '<span class="badge badge--pending">Unknown</span>';
}

function formatActionLabel(action) {
  if (!action) return 'Unknown';

  const labels = {
    'SUSPEND_USER': 'Suspend User',
    'REACTIVATE_USER': 'Reactivate User',
    'ROLE_CHANGE': 'Role Change',
    'CLAIM_REPORT': 'Claim Report',
    'REVIEW_REPORT': 'Review Report',
    'DISMISS_REPORT': 'Dismiss Report',
    'REOPEN_INVESTIGATION': 'Reopen Investigation'
  };

  return labels[action] || action.replace(/_/g, ' ');
}

function getActionBadgeClass(action) {
  if (!action) return 'badge--pending';

  if (action.includes('SUSPEND')) return 'badge--critical';
  if (action.includes('REACTIVATE')) return 'badge--safe';
  if (action.includes('ROLE_CHANGE')) return 'badge--warning';
  if (action.includes('CLAIM')) return 'badge--investigating';
  if (action.includes('REVIEW')) return 'badge--safe';
  if (action.includes('DISMISS')) return 'badge--dismissed';
  if (action.includes('REOPEN')) return 'badge--warning';

  return 'badge--pending';
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  if (unsubscribeLogs) {
    unsubscribeLogs();
  }
});
