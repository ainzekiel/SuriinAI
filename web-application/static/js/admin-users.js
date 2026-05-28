/**
 * admin-users.js — Admin user management table.
 * Features: tabbed filtering, peer-protection guardrails, self-lockout,
 *           suspend/reactivate toggle, role-change confirmation modal.
 */

'use strict';

let users = [];

let pendingRoleChange = null;
let drawerUserId = null;
const activityCountCache = {};

// ── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('suriin:auth-ready', (e) => {
  const { role } = e.detail;

  if (role !== 'admin') {
    window.location.href = '/admin-dashboard';
    return;
  }

  initRoleConfirmModal();
  initUserDrawer();
  loadUsers();
});

// ── Filter ───────────────────────────────────────────────────────────────────

function getFilteredUsers() {
  return users.filter((u) => normalizeRole(u.role) === 'expert');
}

// ── Role Confirm Modal ───────────────────────────────────────────────────────

function initRoleConfirmModal() {
  const modal   = document.getElementById('role-confirm-modal');
  const backdrop = document.getElementById('role-confirm-backdrop');
  const cancelBtn = document.getElementById('role-confirm-cancel');
  const okBtn     = document.getElementById('role-confirm-ok');

  if (!modal) return;

  cancelBtn.addEventListener('click', () => {
    closeRoleConfirmModal(true);
  });

  okBtn.addEventListener('click', async () => {
    if (!pendingRoleChange) return;
    const { userId, nextRole } = pendingRoleChange;
    closeRoleConfirmModal(false);
    await commitRoleUpdate(userId, nextRole);
  });

  backdrop.addEventListener('click', () => {
    closeRoleConfirmModal(true);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('modal--hidden')) {
      closeRoleConfirmModal(true);
    }
  });
}

function promptRoleChange(userId, oldRole, nextRole, userName, sourceEl) {
  const modal = document.getElementById('role-confirm-modal');
  const desc  = document.getElementById('role-confirm-desc');
  if (!modal) return;

  const roleLabel = (r) => r.charAt(0).toUpperCase() + r.slice(1);
  desc.innerHTML = `Change <strong>${escapeHtml(userName)}</strong>'s role from <strong>${roleLabel(oldRole)}</strong> to <strong>${roleLabel(nextRole)}</strong>?`;

  pendingRoleChange = { userId, oldRole, nextRole, sourceEl: sourceEl || null };
  modal.classList.remove('modal--hidden');
}

function closeRoleConfirmModal(revertSelect) {
  const modal = document.getElementById('role-confirm-modal');
  if (modal) modal.classList.add('modal--hidden');

  if (revertSelect && pendingRoleChange) {
    const { userId, oldRole } = pendingRoleChange;
    const select = pendingRoleChange.sourceEl || document.querySelector(`select[data-action="role"][data-user-id="${userId}"]`);
    if (select) select.value = oldRole;
  }
  pendingRoleChange = null;
}

function initUserDrawer() {
  const overlay = document.getElementById('user-drawer-overlay');
  const closeBtn = document.getElementById('user-drawer-close');
  const tbody = document.getElementById('users-tbody');

  if (overlay) {
    overlay.addEventListener('click', closeUserDrawer);
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', closeUserDrawer);
  }

  if (tbody) {
    tbody.addEventListener('click', (event) => {
      if (event.target && event.target.closest && event.target.closest('select, button, a, input, label')) {
        return;
      }

      const tr = event.target && event.target.closest ? event.target.closest('tr[data-user-id]') : null;
      if (!tr || !tr.dataset || !tr.dataset.userId) return;
      openUserDrawer(tr.dataset.userId);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) {
      closeUserDrawer();
    }
  });

  const suspendBtn = document.getElementById('drawer-suspend-btn');
  if (suspendBtn) {
    suspendBtn.addEventListener('click', async () => {
      const userId = suspendBtn.dataset.userId;
      const isSuspended = suspendBtn.dataset.suspended === 'true';
      if (!userId) return;
      await toggleSuspension(userId, isSuspended);
    });
  }

  const roleSelect = document.getElementById('drawer-role-select');
  if (roleSelect) {
    roleSelect.addEventListener('change', () => {
      const userId = roleSelect.dataset.userId;
      const oldRole = roleSelect.dataset.currentRole;
      const nextRole = roleSelect.value;
      if (!userId || !oldRole || nextRole === oldRole) return;

      const userObj = users.find(u => u.id === userId);
      const userName = userObj?.displayName || userObj?.email || 'this user';
      promptRoleChange(userId, oldRole, nextRole, userName, roleSelect);
    });
  }

  const resetBtn = document.getElementById('drawer-password-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      const email = resetBtn.dataset.email;
      if (!email) {
        alert('No email address found for this user.');
        return;
      }
      if (!window.firebase || !firebase.auth || typeof firebase.auth !== 'function') {
        alert('Firebase Auth is not available on this page.');
        return;
      }

      try {
        await firebase.auth().sendPasswordResetEmail(email);
        alert('Password reset email sent.');
      } catch (err) {
        console.error('[SuriinAI Admin] Failed to send password reset email:', err);
        alert('Unable to send password reset email.');
      }
    });
  }
}

function openUserDrawer(userId) {
  drawerUserId = userId;
  document.body.classList.add('drawer-open');

  const drawer = document.getElementById('user-drawer');
  const overlay = document.getElementById('user-drawer-overlay');
  if (drawer) drawer.setAttribute('aria-hidden', 'false');
  if (overlay) overlay.setAttribute('aria-hidden', 'false');

  renderUserDrawer(userId);
}

function closeUserDrawer() {
  document.body.classList.remove('drawer-open');
  const drawer = document.getElementById('user-drawer');
  const overlay = document.getElementById('user-drawer-overlay');
  if (drawer) drawer.setAttribute('aria-hidden', 'true');
  if (overlay) overlay.setAttribute('aria-hidden', 'true');
  drawerUserId = null;
}

function renderUserDrawer(userId) {
  const user = users.find(u => u.id === userId);
  if (!user) return;

  const auth = window.__suriinAuth;
  const currentUid = auth?.user?.uid || null;

  const role = normalizeRole(user.role);
  const suspended = user.suspended === true;
  const isSelf = user.id === currentUid;
  const isPeerAdmin = role === 'admin' && !isSelf;
  const isLocked = isSelf || isPeerAdmin;

  const nameEl = document.getElementById('drawer-name');
  const emailEl = document.getElementById('drawer-email');
  const uidEl = document.getElementById('drawer-uid');
  const joinedEl = document.getElementById('drawer-joined');
  const roleBadgeEl = document.getElementById('drawer-role-badge');
  const statusBadgeEl = document.getElementById('drawer-status-badge');

  if (nameEl) nameEl.textContent = user.displayName || 'Unnamed';
  if (emailEl) emailEl.textContent = user.email || '—';
  if (uidEl) uidEl.textContent = user.id;

  if (joinedEl) {
    const raw = user.createdAt;
    const d = raw ? new Date(raw) : null;
    joinedEl.textContent = d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : '—';
  }

  if (roleBadgeEl) roleBadgeEl.innerHTML = buildRoleBadge(role);
  if (statusBadgeEl) statusBadgeEl.innerHTML = buildSuspensionBadge(suspended);

  const suspendBtn = document.getElementById('drawer-suspend-btn');
  if (suspendBtn) {
    if (role !== 'expert') {
      suspendBtn.style.display = 'none';
    } else {
      suspendBtn.style.display = '';
      suspendBtn.dataset.userId = user.id;
      suspendBtn.dataset.suspended = String(suspended);
      suspendBtn.disabled = isLocked;
      suspendBtn.className = suspended
        ? 'btn btn--ghost btn--sm btn-reactivate'
        : 'btn btn--ghost btn--sm btn-suspend';
      suspendBtn.textContent = suspended ? 'Reactivate' : 'Suspend';
    }
  }

  const roleSelect = document.getElementById('drawer-role-select');
  if (roleSelect) {
    roleSelect.dataset.userId = user.id;
    roleSelect.dataset.currentRole = role;
    roleSelect.value = role;
    roleSelect.disabled = isLocked;
  }

  const resetBtn = document.getElementById('drawer-password-reset-btn');
  if (resetBtn) {
    resetBtn.dataset.email = user.email || '';
  }

  const activitySection = document.getElementById('drawer-activity-section');
  const activityLabel = document.getElementById('drawer-activity-label');
  const activityValue = document.getElementById('drawer-activity-value');

  if (!activitySection || !activityLabel || !activityValue) return;

  if (role !== 'user' && role !== 'expert') {
    activitySection.style.display = 'none';
    return;
  }

  activitySection.style.display = '';
  activityLabel.textContent = role === 'user' ? 'Total Scams Reported' : 'Total Cases Resolved';
  activityValue.textContent = 'Loading…';

  loadActivityCount(user.id, role)
    .then((count) => {
      if (drawerUserId !== user.id) return;
      activityValue.textContent = String(count);
    })
    .catch((err) => {
      console.warn('[SuriinAI Admin] Failed to load activity count:', err);
      if (drawerUserId !== user.id) return;
      activityValue.textContent = '—';
    });
}

async function loadActivityCount(uid, role) {
  const cacheKey = `${uid}:${role}`;
  if (Object.prototype.hasOwnProperty.call(activityCountCache, cacheKey)) {
    return activityCountCache[cacheKey];
  }

  const db = window.__suriinFirestore;
  if (!db) return 0;

  if (role === 'user') {
    const snapshot = await db.collection('Reports').where('user_id', '==', uid).get();
    const n = snapshot.size || 0;
    activityCountCache[cacheKey] = n;
    return n;
  }

  if (role === 'expert') {
    const snapshot = await db.collection('Reports').where('reviewedBy', '==', uid).get();
    let n = 0;
    snapshot.forEach((doc) => {
      const data = doc.data() || {};
      if (data.status === 'Reviewed' || data.status === 'Dismissed') n++;
    });
    activityCountCache[cacheKey] = n;
    return n;
  }

  activityCountCache[cacheKey] = 0;
  return 0;
}

// ── Data Loading ─────────────────────────────────────────────────────────────

async function loadUsers() {
  const db = window.__suriinFirestore;
  if (!db) {
    console.error('[SuriinAI Admin] Firestore not available.');
    return;
  }

  try {
    const snapshot = await db.collection('Users').get();
    users = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    users.sort((a, b) =>
      String(a.displayName || a.email || '').localeCompare(String(b.displayName || b.email || ''))
    );

    updateUserStats(users);
    renderUsersTable();
    if (drawerUserId) {
      renderUserDrawer(drawerUserId);
    }

    document.querySelectorAll('.stat-card__value.is-skeleton, .stat-card__label.is-skeleton').forEach((el) => {
      el.classList.remove('is-skeleton');
    });
  } catch (err) {
    console.error('[SuriinAI Admin] Failed to load users:', err);
    alert('Unable to load users. Check Firestore permissions.');
  }
}

function updateUserStats(allUsers) {
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  };
  setText('stat-total-users',     allUsers.length);
  setText('stat-active-users',    allUsers.filter(u => !u.suspended).length);
  setText('stat-suspended-users', allUsers.filter(u => u.suspended).length);
  setText('stat-expert-users',    allUsers.filter(u => normalizeRole(u.role) === 'expert').length);
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderUsersTable() {
  const tbody      = document.getElementById('users-tbody');
  const emptyState = document.getElementById('users-empty');
  const countEl    = document.getElementById('users-count');
  const table      = document.getElementById('users-table');

  if (!tbody) return;

  const auth       = window.__suriinAuth;
  const currentUid = auth?.user?.uid || null;
  const filtered   = getFilteredUsers();

  tbody.innerHTML = '';

  const n = filtered.length;
  if (countEl) countEl.textContent = `${n} expert${n !== 1 ? 's' : ''}`;

  if (!n) {
    if (table) table.style.display = 'none';
    if (emptyState) emptyState.style.display = '';
    return;
  }

  if (table) table.style.display = '';
  if (emptyState) emptyState.style.display = 'none';

  filtered.forEach((user) => {
    const role      = normalizeRole(user.role);
    const suspended = user.suspended === true;
    const isSelf    = user.id === currentUid;
    const isPeer    = role === 'admin' && !isSelf; // another admin

    const isLocked  = isSelf || isPeer;
    const canSuspend = role === 'expert';

    const suspendBtnClass = suspended
      ? 'btn btn--ghost btn--sm btn-reactivate'
      : 'btn btn--ghost btn--sm btn-suspend';
    const suspendBtnLabel = suspended ? 'Reactivate' : 'Suspend';

    const tr = document.createElement('tr');
    tr.classList.add('row-clickable');
    tr.dataset.userId = user.id;
    if (isSelf)  tr.classList.add('row--self');
    if (isPeer)  tr.classList.add('row--protected');

    tr.innerHTML = `
      <td>${escapeHtml(user.displayName || 'Unnamed')}${isSelf ? ' <span class="badge badge--investigating" style="font-size:0.65rem;padding:1px 6px;">You</span>' : ''}</td>
      <td>${escapeHtml(user.email || '-')}</td>
      <td>
        <select class="role-select" data-action="role" data-user-id="${user.id}" data-current-role="${role}" ${isLocked ? 'disabled' : ''}>
          <option value="user"   ${role === 'user'   ? 'selected' : ''}>User</option>
          <option value="expert" ${role === 'expert' ? 'selected' : ''}>Expert</option>
          <option value="admin"  ${role === 'admin'  ? 'selected' : ''}>Admin</option>
        </select>
      </td>
      <td>${buildSuspensionBadge(suspended)}</td>
      <td>
        ${canSuspend ? `<button class="${suspendBtnClass}" data-action="suspend" data-user-id="${user.id}" data-suspended="${suspended}" ${isLocked ? 'disabled' : ''}>${suspendBtnLabel}</button>` : '<span class="text-muted" style="font-size:0.75rem;">N/A</span>'}
      </td>
    `;

    tbody.appendChild(tr);
  });

  // Role dropdown — intercept with confirmation modal
  tbody.querySelectorAll('select[data-action="role"]:not([disabled])').forEach((select) => {
    select.addEventListener('change', () => {
      const userId   = select.dataset.userId;
      const oldRole  = select.dataset.currentRole;
      const nextRole = select.value;
      if (nextRole === oldRole) return;

      const userObj  = users.find(u => u.id === userId);
      const userName = userObj?.displayName || userObj?.email || 'this user';
      promptRoleChange(userId, oldRole, nextRole, userName, select);
    });
  });

  // Suspend / Reactivate button
  tbody.querySelectorAll('button[data-action="suspend"]:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      const isSuspended = btn.dataset.suspended === 'true';
      toggleSuspension(btn.dataset.userId, isSuspended);
    });
  });
}

// ── Firestore Mutations ──────────────────────────────────────────────────────

async function commitRoleUpdate(userId, nextRole) {
  const db   = window.__suriinFirestore;
  const auth = window.__suriinAuth;
  if (!db || !auth?.user) return;

  if (userId === auth.user.uid && nextRole !== 'admin') {
    alert('You cannot remove your own admin role.');
    await loadUsers();
    return;
  }

  const targetUser = users.find(u => u.id === userId);
  const targetEmail = targetUser?.email || userId;
  const oldRole = targetUser ? normalizeRole(targetUser.role) : 'unknown';

  try {
    await db.collection('Users').doc(userId).update({
      role: normalizeRole(nextRole),
      updatedAt: new Date().toISOString()
    });

    // Log audit event
    if (typeof window.logAuditEvent === 'function') {
      await window.logAuditEvent({
        action: 'ROLE_CHANGE',
        targetId: userId,
        targetType: 'user',
        details: `Changed role for ${targetEmail} from ${oldRole} to ${nextRole}`,
        metadata: { oldRole, newRole: nextRole }
      });
    }

    await loadUsers();
  } catch (err) {
    console.error('[SuriinAI Admin] Failed to update role:', err);
    alert('Unable to update role. Check Firestore permissions.');
    await loadUsers();
  }
}

async function toggleSuspension(userId, currentlySuspended) {
  const db   = window.__suriinFirestore;
  const auth = window.__suriinAuth;
  if (!db || !auth?.user) return;

  if (userId === auth.user.uid) {
    alert('You cannot suspend your own account.');
    return;
  }

  const targetUser = users.find(u => u.id === userId);
  const targetEmail = targetUser?.email || userId;
  const newStatus = !currentlySuspended;
  const action = newStatus ? 'SUSPEND_USER' : 'REACTIVATE_USER';

  try {
    await db.collection('Users').doc(userId).update({
      suspended: newStatus,
      updatedAt: new Date().toISOString()
    });

    // Log audit event
    if (typeof window.logAuditEvent === 'function') {
      await window.logAuditEvent({
        action: action,
        targetId: userId,
        targetType: 'user',
        details: newStatus ? `Suspended account ${targetEmail}` : `Reactivated account ${targetEmail}`,
        metadata: { suspended: newStatus, previousStatus: currentlySuspended }
      });
    }

    await loadUsers();
  } catch (err) {
    console.error('[SuriinAI Admin] Failed to toggle suspension:', err);
    alert('Unable to update suspension status.');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeRole(role) {
  const normalized = String(role || '').toLowerCase();
  if (normalized === 'admin')  return 'admin';
  if (normalized === 'expert') return 'expert';
  return 'user';
}

function buildSuspensionBadge(isSuspended) {
  return isSuspended
    ? '<span class="badge badge--critical">Suspended</span>'
    : '<span class="badge badge--resolved">Active</span>';
}

function buildRoleBadge(role) {
  if (role === 'admin') {
    return '<span class="badge badge--investigating">Admin</span>';
  }
  if (role === 'expert') {
    return '<span class="badge badge--pending">Expert</span>';
  }
  return '<span class="badge badge--dismissed">User</span>';
}

function escapeHtml(input) {
  return String(input || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
