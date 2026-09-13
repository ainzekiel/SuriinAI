/**
 * admin-audit-logs.js — Admin audit logs viewer.
 * Displays system-altering actions by admins and experts.
 */

'use strict';

let allAuditLogs = [];
let currentFilter = { role: '', action: '', startDate: '', endDate: '' };
let currentSearch = '';
let unsubscribeLogs = null;
let auditCurrentPage = 1;
const auditLogsPerPage = 10;

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
  const searchInput = document.getElementById('search-logs');
  const startDateInput = document.getElementById('filter-start-date');
  const endDateInput = document.getElementById('filter-end-date');
  const exportBtn = document.getElementById('btn-export-pdf');

  if (roleFilter) {
    roleFilter.addEventListener('change', () => {
      currentFilter.role = roleFilter.value;
      auditCurrentPage = 1;
      renderAuditTable();
    });
  }

  if (actionFilter) {
    actionFilter.addEventListener('change', () => {
      currentFilter.action = actionFilter.value;
      auditCurrentPage = 1;
      renderAuditTable();
    });
  }

  // Search functionality
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearch = e.target.value.trim().toLowerCase();
      auditCurrentPage = 1;
      renderAuditTable();
    });
  }

  // Date range functionality
  if (startDateInput) {
    startDateInput.addEventListener('change', () => {
      currentFilter.startDate = startDateInput.value;
      auditCurrentPage = 1;
      renderAuditTable();
    });
  }

  if (endDateInput) {
    endDateInput.addEventListener('change', () => {
      currentFilter.endDate = endDateInput.value;
      auditCurrentPage = 1;
      renderAuditTable();
    });
  }

  // Export button functionality - Client-side PDF generation
  if (exportBtn) {
    exportBtn.addEventListener('click', generateAuditPdfPreview);
  }

  // Pagination event listeners
  const btnPrev = document.getElementById('audit-pagination-prev');
  const btnNext = document.getElementById('audit-pagination-next');

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (auditCurrentPage > 1) {
        auditCurrentPage--;
        renderAuditTable();
      }
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      auditCurrentPage++;
      renderAuditTable();
    });
  }

  // Initialize event drawer close button
  const drawerClose = document.getElementById('event-drawer-close');
  const drawerOverlay = document.getElementById('event-drawer-overlay');

  if (drawerClose) {
    drawerClose.addEventListener('click', closeEventDrawer);
  }
  if (drawerOverlay) {
    drawerOverlay.addEventListener('click', closeEventDrawer);
  }
}

// ── Event Drawer ────────────────────────────────────────────────────────────

function openEventDrawer(log) {
  const drawer = document.getElementById('event-drawer');
  const overlay = document.getElementById('event-drawer-overlay');

  if (!drawer || !overlay) return;

  // Populate fields
  document.getElementById('event-id').textContent = log.id || '—';
  document.getElementById('event-timestamp').textContent = formatTimestampUTC(log.timestamp);
  document.getElementById('event-actor').textContent = escapeHtml(log.actorEmail || 'Unknown');
  document.getElementById('event-action').textContent = formatActionLabel(log.action);

  // Populate Event Impact Summary
  const impactEl = document.getElementById('event-impact-text');
  if (impactEl) {
    impactEl.textContent = generateImpactSummary(log);
  }

  // Populate raw payload
  const payloadEl = document.getElementById('event-payload');
  if (payloadEl) {
    payloadEl.textContent = JSON.stringify(log, null, 2);
  }

  // Reset details element to closed state
  const detailsEl = document.querySelector('.forensic-details');
  if (detailsEl) {
    detailsEl.removeAttribute('open');
  }

  // Show drawer
  document.body.classList.add('drawer-open');
  drawer.setAttribute('aria-hidden', 'false');
  overlay.setAttribute('aria-hidden', 'false');
}

function generateImpactSummary(log) {
  const action = log.action || 'UNKNOWN';
  const actor = log.actorEmail || 'An administrator';
  const target = log.targetType || 'system resources';
  const targetEmail = log.targetEmail || 'a user';

  const summaries = {
    'SUSPEND_USER': `${actor} suspended ${targetEmail}'s account, temporarily revoking system access and disabling all authentication privileges. The user can no longer log in or perform any actions until reactivated.`,
    'REACTIVATE_USER': `${actor} reactivated ${targetEmail}'s previously suspended account, restoring full system access and authentication privileges. The user can now log in and resume normal operations.`,
    'ROLE_CHANGE': `${actor} modified user role assignments for ${targetEmail}, altering their system permissions and access levels. This change affects what data and features the user can access.`,
    'CLAIM_REPORT': `${actor} claimed ownership of fraud report #${log.targetId || 'unknown'} for investigation, assigning it to their caseload. They are now responsible for reviewing and resolving this case.`,
    'RESOLVE_REPORT': `${actor} resolved fraud report #${log.targetId || 'unknown'}, completing the investigation process. The case status has been updated and the reporter will be notified of the resolution.`,
    'PROVISION_EXPERT': `${actor} created a new expert analyst account for ${targetEmail}, granting specialized investigative privileges and system access. This user can now review and resolve fraud reports.`,
    'DELETE_USER': `${actor} permanently removed ${targetEmail}'s account from the system. All associated data and access records have been deleted.`,
    'PASSWORD_RESET': `${actor} initiated a password reset for ${targetEmail}'s account. A security credentials update email has been sent to the user.`
  };

  return summaries[action] || `${actor} performed an administrative action affecting ${target}. This event has been logged for compliance and security auditing purposes.`;
}

function closeEventDrawer() {
  const drawer = document.getElementById('event-drawer');
  const overlay = document.getElementById('event-drawer-overlay');

  if (!drawer || !overlay) return;

  document.body.classList.remove('drawer-open');
  drawer.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('aria-hidden', 'true');
}

function formatTimestampUTC(timestamp) {
  if (!timestamp) return '—';

  let date;
  if (timestamp.toDate) {
    date = timestamp.toDate();
  } else if (typeof timestamp === 'string') {
    date = new Date(timestamp);
  } else if (typeof timestamp === 'number') {
    date = new Date(timestamp);
  } else {
    return '—';
  }

  if (Number.isNaN(date.getTime())) return '—';

  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
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

  // Apply date range filter
  if (currentFilter.startDate || currentFilter.endDate) {
    filtered = filtered.filter(log => {
      let logDate;
      if (log.timestamp && log.timestamp.toDate) {
        logDate = log.timestamp.toDate();
      } else if (log.timestamp) {
        logDate = new Date(log.timestamp);
      } else {
        return false;
      }
      
      if (!logDate || isNaN(logDate.getTime())) return false;
      
      const logDateStr = logDate.toISOString().split('T')[0];
      
      if (currentFilter.startDate && logDateStr < currentFilter.startDate) return false;
      if (currentFilter.endDate && logDateStr > currentFilter.endDate) return false;
      
      return true;
    });
  }

  // Apply search filter
  if (currentSearch) {
    filtered = filtered.filter(log => {
      const searchFields = [
        log.actorEmail || '',
        log.action || '',
        log.targetType || '',
        log.details || ''
      ].join(' ').toLowerCase();
      return searchFields.includes(currentSearch);
    });
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

  // --- Pagination Logic ---
  const totalPages = Math.ceil(filtered.length / auditLogsPerPage);
  if (auditCurrentPage > totalPages) auditCurrentPage = totalPages;
  if (auditCurrentPage < 1) auditCurrentPage = 1;

  const startIndex = (auditCurrentPage - 1) * auditLogsPerPage;
  const paginatedLogs = filtered.slice(startIndex, startIndex + auditLogsPerPage);

  // Update Pagination UI
  const paginationContainer = document.getElementById('audit-pagination');
  const btnPrev = document.getElementById('audit-pagination-prev');
  const btnNext = document.getElementById('audit-pagination-next');
  const pageNumbersContainer = document.getElementById('audit-pagination-numbers');

  if (paginationContainer) {
    paginationContainer.style.display = totalPages > 1 ? 'flex' : 'none';

    // Show/hide Previous button (hidden on page 1)
    if (btnPrev) btnPrev.style.display = auditCurrentPage > 1 ? 'inline-flex' : 'none';

    // Show/hide Next button (hidden on last page)
    if (btnNext) btnNext.style.display = auditCurrentPage < totalPages ? 'inline-flex' : 'none';

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

        if (i === auditCurrentPage) {
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
            auditCurrentPage = i;
            renderAuditTable();
          });
        }
        pageNumbersContainer.appendChild(pageBtn);
      }
    }
  }

  paginatedLogs.forEach((log) => {
    const tr = document.createElement('tr');
    tr.classList.add('row-clickable');
    tr.style.cursor = 'pointer';
    tr.style.transition = 'background 0.2s ease';
    tr.addEventListener('mouseenter', () => {
      tr.style.background = 'rgba(255, 255, 255, 0.05)';
    });
    tr.addEventListener('mouseleave', () => {
      tr.style.background = '';
    });
    tr.addEventListener('click', () => openEventDrawer(log));

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
    'RESOLVE_REPORT': 'Resolve Report'
  };

  return labels[action] || action.replace(/_/g, ' ');
}

function getActionBadgeClass(action) {
  if (!action) return 'badge--pending';

  if (action.includes('SUSPEND')) return 'badge--critical';
  if (action.includes('REACTIVATE')) return 'badge--safe';
  if (action.includes('ROLE_CHANGE')) return 'badge--warning';
  if (action.includes('CLAIM')) return 'badge--investigating';
  if (action.includes('RESOLVE')) return 'badge--safe';

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

// ── PDF Generation ───────────────────────────────────────────────────────────

function injectPdfPreviewStyles() {
  if (document.getElementById('pdf-preview-styles')) return;

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
  `;

  const styleEl = document.createElement('style');
  styleEl.id = 'pdf-preview-styles';
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);
}

function getFilteredAuditLogsForPdf() {
  let filtered = allAuditLogs;
  if (currentFilter.role) {
    filtered = filtered.filter(log => log.actorRole === currentFilter.role);
  }
  if (currentFilter.action) {
    filtered = filtered.filter(log => log.action === currentFilter.action);
  }
  if (currentFilter.startDate || currentFilter.endDate) {
    filtered = filtered.filter(log => {
      let logDate;
      if (log.timestamp?.toDate) {
        logDate = log.timestamp.toDate();
      } else if (log.timestamp) {
        logDate = new Date(log.timestamp);
      } else {
        return false;
      }
      if (!logDate || isNaN(logDate.getTime())) return false;
      const logDateStr = logDate.toISOString().split('T')[0];
      if (currentFilter.startDate && logDateStr < currentFilter.startDate) return false;
      if (currentFilter.endDate && logDateStr > currentFilter.endDate) return false;
      return true;
    });
  }
  if (currentSearch) {
    filtered = filtered.filter(log => {
      const searchFields = [
        log.actorEmail || '',
        log.action || '',
        log.targetType || '',
        log.details || ''
      ].join(' ').toLowerCase();
      return searchFields.includes(currentSearch);
    });
  }
  return filtered;
}

function buildFilterDescription() {
  const parts = [];
  if (currentFilter.startDate && currentFilter.endDate) {
    parts.push(`${currentFilter.startDate} to ${currentFilter.endDate}`);
  } else if (currentFilter.startDate) {
    parts.push(`From ${currentFilter.startDate}`);
  } else if (currentFilter.endDate) {
    parts.push(`Until ${currentFilter.endDate}`);
  }
  if (currentFilter.role) parts.push(`Role: ${currentFilter.role}`);
  if (currentFilter.action) parts.push(`Action: ${formatActionLabel(currentFilter.action)}`);
  if (currentSearch) parts.push(`Search: "${currentSearch}"`);
  return parts.join(' | ') || 'All Records';
}

function generateAuditPdfPreview() {
  const filtered = getFilteredAuditLogsForPdf();

  if (filtered.length === 0) {
    showToast('No audit logs to export.', 'error');
    return;
  }

  // Loading state
  const btn = document.getElementById('btn-export-pdf');
  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>⏳</span><span>Generating...</span>';

  setTimeout(() => {
    try {
      if (!window.jspdf) {
        throw new Error('jsPDF library not loaded');
      }

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });

      // Check AutoTable
      if (typeof doc.autoTable !== 'function') {
        console.error('[PDF] AutoTable not found:', typeof doc.autoTable);
        throw new Error('jsPDF AutoTable plugin not loaded');
      }

      const PAGE_W = doc.internal.pageSize.getWidth();
      const MARGIN = 40;

      // Header
      doc.setFontSize(18);
      doc.setTextColor('#6C63FF');
      doc.text('SURIIN AI - OFFICIAL SYSTEM AUDIT REPORT', PAGE_W / 2, 50, { align: 'center' });

      // Filter info
      doc.setFontSize(10);
      doc.setTextColor(100);
      const filterText = buildFilterDescription();
      doc.text(`Report Scope: ${filterText}`, PAGE_W / 2, 70, { align: 'center' });

      // Generation info
      doc.setFontSize(9);
      doc.text(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`, MARGIN, 95);
      doc.text(`Total Records: ${filtered.length}`, MARGIN, 110);

      // Table data
      const tableData = filtered.map(log => {
        let timestamp = log.timestamp;
        if (timestamp?.toDate) {
          timestamp = timestamp.toDate().toISOString().slice(0, 19).replace('T', ' ');
        } else if (timestamp) {
          timestamp = new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
        } else {
          timestamp = '—';
        }

        return [
          timestamp,
          (log.id || '—').slice(0, 20),
          (log.actorEmail || 'Unknown').slice(0, 25),
          (log.action || '—').replace(/_/g, ' '),
          log.ipAddress || '—'
        ];
      });

      // AutoTable
      doc.autoTable({
        head: [['Timestamp (UTC)', 'Event ID', 'Actor', 'Action', 'IP Address']],
        body: tableData,
        startY: 130,
        margin: { left: MARGIN, right: MARGIN },
        headStyles: {
          fillColor: '#6C63FF',
          textColor: 255,
          fontSize: 10,
          fontStyle: 'bold'
        },
        bodyStyles: {
          fontSize: 9,
          textColor: 60
        },
        alternateRowStyles: {
          fillColor: 245
        },
        styles: {
          cellPadding: 6,
          lineColor: 200,
          lineWidth: 0.5
        }
      });

      // Confidentiality footer
      const finalY = doc.lastAutoTable?.finalY || 600;
      doc.setFontSize(8);
      doc.setTextColor('#dc2626');
      doc.text('CONFIDENTIAL: For internal security and compliance auditing only. Do not distribute.', PAGE_W / 2, finalY + 30, { align: 'center' });

      // Show preview
      const fileName = `Suriin_Audit_Report_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.pdf`;
      showPdfPreview(doc, fileName);

      showToast('PDF ready — preview opened.', 'success');

    } catch (err) {
      console.error('[Audit PDF] Generation error:', err);
      showToast('Failed to generate PDF: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }, 100);
}

function showPdfPreview(doc, fileName) {
  injectPdfPreviewStyles();

  const pdfBlob = doc.output('blob');
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

  // Close handlers
  function close() {
    overlay.remove();
    URL.revokeObjectURL(blobUrl);
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') close(); }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onEsc);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  if (unsubscribeLogs) {
    unsubscribeLogs();
  }
});
