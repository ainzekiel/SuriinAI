/**
 * admin-users.js — Admin user management table.
 * Features: tabbed filtering, peer-protection guardrails, self-lockout,
 *           suspend/reactivate toggle, role-change confirmation modal.
 */

'use strict';

let users = [];
let currentTab = 'experts'; // 'experts' | 'admins'

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
  initProvisionModal();
  initTabs();
  loadUsers();
});

// ── Filter ─────────────────────────────────────────────────────────────────--

function getFilteredUsers(roleFilter = null) {
  const targetRole = roleFilter || (currentTab === 'experts' ? 'expert' : 'admin');
  return users.filter((u) => normalizeRole(u.role) === targetRole);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function initTabs() {
  const tabExperts = document.getElementById('tab-experts');
  const tabAdmins = document.getElementById('tab-admins');

  if (tabExperts) {
    tabExperts.addEventListener('click', () => switchTab('experts'));
  }
  if (tabAdmins) {
    tabAdmins.addEventListener('click', () => switchTab('admins'));
  }
}

function switchTab(tab) {
  if (tab === currentTab) return;

  currentTab = tab;

  // Update tab UI
  document.querySelectorAll('.user-tab').forEach((el) => {
    el.classList.toggle('user-tab--active', el.dataset.tab === tab);
  });

  // Update table headers based on tab
  const thead = document.getElementById('users-thead');
  if (thead) {
    if (tab === 'experts') {
      thead.innerHTML = `
        <tr>
          <th style="width: 20%; min-width: 140px;">Name</th>
          <th style="width: 30%; min-width: 200px;">Email</th>
          <th style="width: 15%; min-width: 100px;">Role</th>
          <th style="width: 15%; min-width: 100px;">Status</th>
          <th style="width: 20%; min-width: 140px;">Actions</th>
        </tr>
      `;
    } else {
      thead.innerHTML = `
        <tr>
          <th style="width: 22%; min-width: 140px;">Name</th>
          <th style="width: 32%; min-width: 200px;">Email</th>
          <th style="width: 20%; min-width: 120px;">Created Date</th>
          <th style="width: 26%; min-width: 140px;">Access Level</th>
        </tr>
      `;
    }
  }

  // Update empty state text
  const emptyTitle = document.getElementById('empty-title');
  const emptyDesc = document.getElementById('empty-desc');
  if (emptyTitle) {
    emptyTitle.textContent = tab === 'experts' ? 'No expert accounts found' : 'No system administrators found';
  }
  if (emptyDesc) {
    emptyDesc.textContent = tab === 'experts' 
      ? 'Expert analyst accounts from Firestore will appear here.'
      : 'System administrator accounts from Firestore will appear here.';
  }

  // Re-render table
  renderUsersTable();
}

// ── Role Confirm Modal ─────────────────────────────────────────────────────--

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

  // Role badge with custom styling for admin
  if (roleBadgeEl) {
    if (role === 'admin') {
      roleBadgeEl.innerHTML = '<span class="badge badge--admin" style="background: linear-gradient(135deg, #6C63FF, #3ECFCF); border: 1px solid rgba(108, 99, 255, 0.5); color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 0.75rem; font-weight: 600;">Admin</span>';
    } else {
      roleBadgeEl.innerHTML = buildRoleBadge(role);
    }
  }

  // Protected badge for admin
  const protectedBadgeEl = document.getElementById('drawer-protected-badge');
  if (protectedBadgeEl) {
    if (role === 'admin') {
      protectedBadgeEl.innerHTML = '<span class="badge badge--protected" style="background: rgba(108, 99, 255, 0.08); border: 1px solid rgba(108, 99, 255, 0.25); color: rgba(255, 255, 255, 0.7); padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 500;">Protected</span>';
      protectedBadgeEl.style.display = '';
    } else {
      protectedBadgeEl.style.display = 'none';
    }
  }

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

  // Handle Activity / Administrative Footprint sections
  const activitySection = document.getElementById('drawer-activity-section');
  const activityLabel = document.getElementById('drawer-activity-label');
  const activityValue = document.getElementById('drawer-activity-value');
  const adminActivitySection = document.getElementById('drawer-admin-activity-section');

  // Handle Actions sections
  const expertActions = document.getElementById('drawer-expert-actions');
  const adminActions = document.getElementById('drawer-admin-actions');

  if (role === 'admin') {
    // Hide expert activity, show admin footprint
    if (activitySection) activitySection.style.display = 'none';
    if (adminActivitySection) adminActivitySection.style.display = '';

    // Hide expert actions, show admin security safeguard
    if (expertActions) expertActions.style.display = 'none';
    if (adminActions) adminActions.style.display = '';

    return; // Skip the rest for admins
  }

  // For experts and users
  if (adminActivitySection) adminActivitySection.style.display = 'none';
  if (expertActions) expertActions.style.display = '';
  if (adminActions) adminActions.style.display = 'none';

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

  // Update stat cards
  setText('stat-total-users',     allUsers.filter(u => normalizeRole(u.role) === 'expert').length);
  setText('stat-active-users',  allUsers.filter(u => normalizeRole(u.role) === 'expert' && !u.suspended).length);
  setText('stat-suspended-users', allUsers.filter(u => normalizeRole(u.role) === 'expert' && u.suspended).length);

  // Calculate new experts (created within last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const newExperts = allUsers.filter(u => {
    if (normalizeRole(u.role) !== 'expert') return false;
    const created = u.createdAt ? new Date(u.createdAt) : null;
    return created && created >= sevenDaysAgo;
  }).length;
  setText('stat-expert-users', newExperts);

  // Update tab counts
  setText('tab-count-experts', allUsers.filter(u => normalizeRole(u.role) === 'expert').length);
  setText('tab-count-admins',  allUsers.filter(u => normalizeRole(u.role) === 'admin').length);
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderUsersTable() {
  const tbody      = document.getElementById('users-tbody');
  const emptyState = document.getElementById('users-empty');
  const table      = document.getElementById('users-table');

  if (!tbody) return;

  const auth       = window.__suriinAuth;
  const currentUid = auth?.user?.uid || null;
  const filtered   = getFilteredUsers();

  tbody.innerHTML = '';

  const n = filtered.length;

  if (!n) {
    if (table) table.style.display = 'none';
    if (emptyState) emptyState.style.display = '';
    return;
  }

  if (table) table.style.display = '';
  if (emptyState) emptyState.style.display = 'none';

  // Render based on current tab
  if (currentTab === 'experts') {
    renderExpertsTable(tbody, filtered, currentUid);
  } else {
    renderAdminsTable(tbody, filtered, currentUid);
  }
}

function renderExpertsTable(tbody, filtered, currentUid) {
  filtered.forEach((user) => {
    const role      = normalizeRole(user.role);
    const suspended = user.suspended === true;
    const isSelf    = user.id === currentUid;

    const suspendBtnClass = suspended
      ? 'btn btn--ghost btn--sm btn-reactivate'
      : 'btn btn--ghost btn--sm btn-suspend';
    const suspendBtnLabel = suspended ? 'Reactivate' : 'Suspend';

    const tr = document.createElement('tr');
    tr.classList.add('row-clickable');
    tr.dataset.userId = user.id;
    if (isSelf) tr.classList.add('row--self');

    tr.innerHTML = `
      <td>${escapeHtml(user.displayName || 'Unnamed')}${isSelf ? ' <span class="badge badge--investigating" style="font-size:0.65rem;padding:1px 6px;">You</span>' : ''}</td>
      <td>${escapeHtml(user.email || '-')}</td>
      <td>
        <select class="role-select" data-action="role" data-user-id="${user.id}" data-current-role="${role}">
          <option value="user"   ${role === 'user'   ? 'selected' : ''}>User</option>
          <option value="expert" ${role === 'expert' ? 'selected' : ''}>Expert</option>
          <option value="admin"  ${role === 'admin'  ? 'selected' : ''}>Admin</option>
        </select>
      </td>
      <td>${buildSuspensionBadge(suspended)}</td>
      <td>
        <button class="${suspendBtnClass}" data-action="suspend" data-user-id="${user.id}" data-suspended="${suspended}">${suspendBtnLabel}</button>
      </td>
    `;

    tbody.appendChild(tr);
  });

  // Role dropdown — intercept with confirmation modal
  tbody.querySelectorAll('select[data-action="role"]').forEach((select) => {
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
  tbody.querySelectorAll('button[data-action="suspend"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const isSuspended = btn.dataset.suspended === 'true';
      toggleSuspension(btn.dataset.userId, isSuspended);
    });
  });
}

function renderAdminsTable(tbody, filtered, currentUid) {
  filtered.forEach((user) => {
    const isSelf = user.id === currentUid;
    const createdAt = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—';

    const tr = document.createElement('tr');
    tr.classList.add('row-clickable');
    tr.classList.add('row--protected-admin');
    tr.dataset.userId = user.id;
    if (isSelf) tr.classList.add('row--self');

    tr.innerHTML = `
      <td>${escapeHtml(user.displayName || 'Unnamed')}${isSelf ? ' <span class="badge badge--investigating" style="font-size:0.65rem;padding:1px 6px;">You</span>' : ''}</td>
      <td>${escapeHtml(user.email || '-')}</td>
      <td>${createdAt}</td>
      <td><span class="badge badge--info" style="font-size:0.7rem;background:rgba(108,99,255,0.15);border:1px solid rgba(108,99,255,0.3);padding:3px 8px;border-radius:6px;display:inline-block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">System Administrator</span></td>
    `;

    tbody.appendChild(tr);
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

// ── Expert Provisioning Modal ────────────────────────────────────────────────

function initProvisionModal() {
  const modal = document.getElementById('createExpertModal');
  const backdrop = document.getElementById('create-expert-backdrop');
  const openBtn = document.getElementById('btn-provision-expert');
  const closeBtn = document.getElementById('create-expert-close');
  const cancelBtn = document.getElementById('btn-cancel-provision');
  const form = document.getElementById('create-expert-form');

  if (!modal || !openBtn) return;

  // Open modal
  openBtn.addEventListener('click', () => {
    openProvisionModal();
  });

  // Close handlers
  const closeModal = () => closeProvisionModal();
  if (backdrop) backdrop.addEventListener('click', closeModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('modal--hidden')) {
      closeModal();
    }
  });

  // Password visibility toggles
  const pwToggle = document.getElementById('toggle-expert-password');
  const confirmToggle = document.getElementById('toggle-expert-confirm');
  const pwInput = document.getElementById('expert-password');
  const confirmInput = document.getElementById('expert-password-confirm');

  if (pwToggle && pwInput) {
    pwToggle.addEventListener('click', () => {
      const isPassword = pwInput.type === 'password';
      pwInput.type = isPassword ? 'text' : 'password';
      pwToggle.innerHTML = isPassword
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    });
  }

  if (confirmToggle && confirmInput) {
    confirmToggle.addEventListener('click', () => {
      const isPassword = confirmInput.type === 'password';
      confirmInput.type = isPassword ? 'text' : 'password';
      confirmToggle.innerHTML = isPassword
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    });
  }

  // Password strength meter
  if (pwInput) {
    pwInput.addEventListener('input', () => {
      updateProvisionPasswordMeter(pwInput.value);
      clearFieldError('expert-password', 'error-expert-password');
    });
  }

  // Form submission
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitProvisionExpert();
    });
  }
}

function openProvisionModal() {
  const modal = document.getElementById('createExpertModal');
  if (!modal) return;

  // Reset form
  const form = document.getElementById('create-expert-form');
  if (form) form.reset();

  // Clear errors
  document.getElementById('error-expert-email').textContent = '';
  document.getElementById('error-expert-password').textContent = '';
  document.getElementById('error-expert-confirm').textContent = '';
  document.getElementById('provision-error').style.display = 'none';
  document.getElementById('provision-error').textContent = '';

  // Reset password meter
  document.getElementById('password-strength-bar-wrap').style.display = 'none';
  document.getElementById('pw-requirements').style.display = 'none';
  document.getElementById('password-strength-bar').style.width = '0';

  // Show modal
  modal.style.display = 'block';
  modal.classList.remove('modal--hidden');

  // Prevent background scrolling
  document.body.style.overflow = 'hidden';
}

function closeProvisionModal() {
  const modal = document.getElementById('createExpertModal');
  if (modal) {
    modal.classList.add('modal--hidden');
    modal.style.display = 'none';
  }

  // Restore background scrolling
  document.body.style.overflow = '';
}

function updateProvisionPasswordMeter(pw) {
  const bar = document.getElementById('password-strength-bar');
  const barWrap = document.getElementById('password-strength-bar-wrap');
  const reqWrap = document.getElementById('pw-requirements');

  if (!bar || !barWrap || !reqWrap) return;

  // Show elements once user starts typing
  if (pw.length > 0) {
    barWrap.style.display = 'block';
    reqWrap.style.display = 'block';
  }

  // Check requirements
  const hasLength = pw.length >= 8;
  const hasUpper = /[A-Z]/.test(pw);
  const hasLower = /[a-z]/.test(pw);
  const hasNumber = /[0-9]/.test(pw);
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pw);

  // Update requirement indicators
  updateReqIndicator('req-length', hasLength);
  updateReqIndicator('req-upper', hasUpper);
  updateReqIndicator('req-lower', hasLower);
  updateReqIndicator('req-number', hasNumber);
  updateReqIndicator('req-special', hasSpecial);

  // Calculate strength
  let score = 0;
  if (hasLength) score++;
  if (hasUpper) score++;
  if (hasLower) score++;
  if (hasNumber) score++;
  if (hasSpecial) score++;

  // Update bar
  const colors = ['#EF4444', '#EF4444', '#F59E0B', '#3ECFCF', '#10B981'];
  const widths = ['20%', '40%', '60%', '80%', '100%'];
  const color = colors[Math.max(0, score - 1)] || '#EF4444';
  const width = widths[Math.max(0, score - 1)] || '0%';

  bar.style.width = width;
  bar.style.background = color;
}

function updateReqIndicator(id, met) {
  const el = document.getElementById(id);
  if (!el) return;
  const indicator = el.querySelector('span');
  if (indicator) {
    indicator.style.background = met ? '#10B981' : 'var(--clr-border)';
    indicator.style.color = met ? '#fff' : 'transparent';
  }
  el.style.color = met ? '#10B981' : 'var(--clr-text-muted)';
}

function clearFieldError(inputId, errorId) {
  const errorEl = document.getElementById(errorId);
  if (errorEl) errorEl.textContent = '';
}

async function submitProvisionExpert() {
  const firstName = document.getElementById('expert-firstname').value.trim();
  const lastName = document.getElementById('expert-lastname').value.trim();
  const phone = document.getElementById('expert-phone').value.trim();
  const email = document.getElementById('expert-email').value.trim();
  const password = document.getElementById('expert-password').value;
  const confirmPassword = document.getElementById('expert-password-confirm').value;

  // Clear previous errors
  document.getElementById('error-expert-email').textContent = '';
  document.getElementById('error-expert-password').textContent = '';
  document.getElementById('error-expert-confirm').textContent = '';
  document.getElementById('provision-error').style.display = 'none';

  // Validate
  let hasError = false;

  if (!firstName || !lastName) {
    document.getElementById('provision-error').textContent = 'First and last name are required.';
    document.getElementById('provision-error').style.display = 'block';
    hasError = true;
  }

  if (!email) {
    document.getElementById('error-expert-email').textContent = 'Email is required.';
    hasError = true;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('error-expert-email').textContent = 'Please enter a valid email address.';
    hasError = true;
  }

  if (!password) {
    document.getElementById('error-expert-password').textContent = 'Password is required.';
    hasError = true;
  } else {
    const hasLength = password.length >= 8;
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

    if (!hasLength || !hasUpper || !hasLower || !hasNumber || !hasSpecial) {
      document.getElementById('error-expert-password').textContent = 'Password does not meet all requirements.';
      hasError = true;
    }
  }

  if (password !== confirmPassword) {
    document.getElementById('error-expert-confirm').textContent = 'Passwords do not match.';
    hasError = true;
  }

  if (hasError) return;

  // Show loading state
  const submitBtn = document.getElementById('btn-submit-provision');
  const btnText = submitBtn.querySelector('.btn-text');
  const spinner = submitBtn.querySelector('.spinner');

  submitBtn.disabled = true;
  btnText.textContent = 'Creating...';
  spinner.style.display = 'inline-block';

  try {
    // Get Firebase auth token
    const auth = window.__suriinAuth;
    if (!auth?.user) {
      document.getElementById('provision-error').textContent = 'Authentication required. Please sign in again.';
      document.getElementById('provision-error').style.display = 'block';
      submitBtn.disabled = false;
      btnText.textContent = 'Generate Account';
      spinner.style.display = 'none';
      return;
    }

    const idToken = await auth.user.getIdToken();

    const response = await fetch('/api/admin/provision-expert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        firstName,
        lastName,
        phone,
        email,
        password
      })
    });

    const data = await response.json();

    if (data.success) {
      // Success - close modal and refresh users
      closeProvisionModal();
      await loadUsers();

      // Show success notification (using alert for simplicity, could be a toast)
      alert(`Expert account created successfully for ${email}`);
    } else {
      // Show error
      document.getElementById('provision-error').textContent = data.error || 'Failed to create expert account.';
      document.getElementById('provision-error').style.display = 'block';
    }
  } catch (err) {
    console.error('[SuriinAI Admin] Failed to provision expert:', err);
    document.getElementById('provision-error').textContent = 'Network error. Please try again.';
    document.getElementById('provision-error').style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    btnText.textContent = 'Generate Account';
    spinner.style.display = 'none';
  }
}
