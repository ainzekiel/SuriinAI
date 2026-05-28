/**
 * notification-bell.js — Shared notification bell setup for all pages
 * Initializes the notification dropdown on pages with the notification bell
 */

'use strict';

console.log('[SuriinAI NotificationBell] Script loaded');

let notificationUnsubscribe = null;
let allNotifications = [];

// ── Listen for auth-ready event from auth.js ──────────────────────────────────
window.addEventListener('suriin:auth-ready', (e) => {
  console.log('[SuriinAI NotificationBell] Received suriin:auth-ready event');
  const { user } = e.detail;
  if (!user) {
    console.error('[SuriinAI NotificationBell] No user in event detail');
    return;
  }

  const db = window.__suriinFirestore;
  if (!db) {
    console.warn('[SuriinAI NotificationBell] Firestore not available.');
    return;
  }

  console.log('[SuriinAI NotificationBell] Starting setup for user:', user.uid);
  setupNotificationBell(user, db);
  console.log('[SuriinAI NotificationBell] Setup complete');
});

// ── If auth already completed before this script loaded, initialize now ────────
if (window.__suriinAuthReady && window.__suriinAuthData) {
  console.log('[SuriinAI NotificationBell] Auth already ready, initializing immediately');
  const { user } = window.__suriinAuthData;
  const db = window.__suriinFirestore;
  
  if (user && db) {
    setTimeout(() => {
      console.log('[SuriinAI NotificationBell] Starting setup for user:', user.uid);
      setupNotificationBell(user, db);
      console.log('[SuriinAI NotificationBell] Setup complete');
    }, 0);
  }
}

function setupNotificationBell(user, db) {
  const bellBtn = document.getElementById('notification-bell-btn');
  const dropdown = document.getElementById('notification-dropdown');
  const markAllBtn = document.getElementById('mark-all-read-btn');

  if (!bellBtn || !dropdown) {
    console.warn('[SuriinAI NotificationBell] Notification bell elements not found.');
    return;
  }

  // ── Toggle dropdown on bell click ──────────────────────────────────────────
  bellBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = dropdown.style.display !== 'none';
    // Close avatar dropdown if open (mutual exclusion)
    if (!isVisible) {
      const avatarDropdown = document.getElementById('avatar-dropdown');
      const avatarEl       = document.getElementById('user-avatar');
      if (avatarDropdown) avatarDropdown.style.display = 'none';
      if (avatarEl)       avatarEl.setAttribute('aria-expanded', 'false');
    }
    dropdown.style.display = isVisible ? 'none' : 'flex';
  });

  // ── Close dropdown on outside click ────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const container = document.getElementById('notification-bell-container');
    if (container && !container.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });

  // ── Mark all as read ──────────────────────────────────────────────────────
  if (markAllBtn) {
    markAllBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const unread = allNotifications.filter(n => !n.isRead);
      if (unread.length === 0) return;

      const role = window.__suriinAuthData?.role || 'user';
      const collectionName = (role === 'admin' || role === 'expert') ? 'staff_notifications' : 'user_notifications';

      try {
        for (const notification of unread) {
          await db.collection(collectionName).doc(notification.id).update({
            isRead: true
          });
        }
        console.log('[SuriinAI NotificationBell] All notifications marked as read');
      } catch (err) {
        console.error('[SuriinAI NotificationBell] Error marking notifications as read:', err);
      }
    });
  }

  // ── Set up real-time listener based on role ───────────────────────────────
  const role = window.__suriinAuthData?.role || 'user';
  let notificationsQuery;

  if (role === 'admin') {
    // Admins query staff_notifications targeting admins
    notificationsQuery = db.collection('staff_notifications')
      .where('targetRole', '==', 'admin')
      .orderBy('created_at', 'desc');
    console.log('[SuriinAI NotificationBell] Admin mode: querying staff_notifications for admins');
  } else if (role === 'expert') {
    // Experts query staff_notifications targeting experts
    notificationsQuery = db.collection('staff_notifications')
      .where('targetRole', '==', 'expert')
      .orderBy('created_at', 'desc');
    console.log('[SuriinAI NotificationBell] Expert mode: querying staff_notifications for experts');
  } else {
    // Regular users query user_notifications for their user_id
    notificationsQuery = db.collection('user_notifications')
      .where('user_id', '==', user.uid)
      .orderBy('created_at', 'desc');
    console.log('[SuriinAI NotificationBell] User mode: querying user_notifications for user:', user.uid);
  }
  
  notificationUnsubscribe = notificationsQuery
    .onSnapshot(
      (snapshot) => {
        allNotifications = [];

        snapshot.forEach((doc) => {
          allNotifications.push({ id: doc.id, ...doc.data() });
        });

        updateNotificationBadge();
        renderNotificationDropdown();

        console.log('[SuriinAI NotificationBell] Notifications updated:', allNotifications.length);
      },
      (error) => {
        if (error && error.code === 'permission-denied') {
          const container = document.getElementById('notification-bell-container');
          if (container) container.style.display = 'none';
        } else {
          console.warn('[SuriinAI NotificationBell] Notification listener error:', error);
        }
      }
    );
}

function updateNotificationBadge() {
  const badge = document.getElementById('notification-badge');
  if (!badge) return;

  const unreadCount = allNotifications.filter(n => !n.isRead).length;

  if (unreadCount === 0) {
    badge.style.display = 'none';
  } else {
    badge.style.display = 'flex';
    // Show count up to 9, then '+' for 10+
    badge.textContent = unreadCount > 9 ? '+' : unreadCount.toString();
  }
}

let showAllNotifications = false;

function renderNotificationDropdown() {
  const list = document.getElementById('notification-list');
  const emptyState = document.getElementById('notification-empty');
  const markAllBtn = document.getElementById('mark-all-read-btn');

  if (!list || !emptyState) return;

  const unreadCount = allNotifications.filter(n => !n.isRead).length;

  // Show/hide mark all button
  if (markAllBtn) {
    markAllBtn.style.display = unreadCount > 0 ? 'block' : 'none';
  }

  // Clear list
  list.innerHTML = '';

  if (allNotifications.length === 0) {
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  // Determine notifications to render (cap at 10 unless showAll is true)
  const notificationsToRender = showAllNotifications ? allNotifications : allNotifications.slice(0, 10);

  // Render each notification
  notificationsToRender.forEach((notification) => {
    const notifEl = document.createElement('div');
    notifEl.className = `notification-item ${notification.isRead ? 'is-read' : ''}`;
    notifEl.dataset.notificationId = notification.id;

    const message = notification.message || 'Notification';
    const timestamp = formatRelativeTime(notification.created_at);

    notifEl.innerHTML = `
      <div class="notification-item__message">${escapeHtml(message)}</div>
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
        <div class="notification-item__timestamp">${timestamp}</div>
        <button class="notification-item__mark-read" title="Mark as read" aria-label="Mark as read">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span class="label">Mark as read</span>
        </button>
      </div>
    `;

    // Click on individual mark as read button
    const markReadBtn = notifEl.querySelector('.notification-item__mark-read');
    if (markReadBtn) {
      markReadBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); // Prevent modal from opening
        if (notification.isRead) return;
        try {
          const role = window.__suriinAuthData?.role || 'user';
          const collectionName = (role === 'admin' || role === 'expert') ? 'staff_notifications' : 'user_notifications';
          await window.__suriinFirestore
            .collection(collectionName)
            .doc(notification.id)
            .update({ isRead: true });
        } catch (err) {
          console.error('[SuriinAI NotificationBell] Error marking notification as read:', err);
        }
      });
    }

    // Click to open modal and mark as read
    notifEl.addEventListener('click', async () => {
      if (!notification.isRead) {
        try {
          const role = window.__suriinAuthData?.role || 'user';
          const collectionName = (role === 'admin' || role === 'expert') ? 'staff_notifications' : 'user_notifications';
          await window.__suriinFirestore
            .collection(collectionName)
            .doc(notification.id)
            .update({ isRead: true });
        } catch (err) {
          console.error('[SuriinAI NotificationBell] Error marking notification as read:', err);
        }
      }
      
      const dropdown = document.getElementById('notification-dropdown');
      if (dropdown) dropdown.style.display = 'none';

      const rid = notification.reportId || notification.report_id;
      if (!rid) return;
      
      if (typeof openReviewModal === 'function') {
        await openReviewModal(rid);
      } else if (typeof openReportModal === 'function') {
        openReportModal(rid);
      } else {
        // Fallback if the user is not on a page with the modal
        const role = window.__suriinAuthData?.role || 'user';
        const dash = role === 'expert' ? '/expert-dashboard' : '/user-dashboard';
        window.location.href = `${dash}?report_id=${rid}`;
      }
    });

    list.appendChild(notifEl);
  });

  // Add "View all" footer if there are more than 10 notifications
  if (allNotifications.length > 10) {
    const footerEl = document.createElement('div');
    footerEl.className = 'notification-footer';
    footerEl.innerHTML = `
      <button class="notification-footer__toggle" style="width: 100%; padding: 8px 12px; background: none; border: none; color: var(--clr-accent); font-size: var(--font-sm); cursor: pointer; text-align: center;">
        ${showAllNotifications ? 'Show fewer' : `View all ${allNotifications.length} notifications`}
      </button>
    `;
    
    const toggleBtn = footerEl.querySelector('.notification-footer__toggle');
    toggleBtn.addEventListener('click', () => {
      showAllNotifications = !showAllNotifications;
      renderNotificationDropdown();
    });
    
    list.appendChild(footerEl);
  }
}

function formatRelativeTime(firestoreTimestamp) {
  if (!firestoreTimestamp) return 'Unknown time';

  try {
    const now = new Date();
    const notifDate = firestoreTimestamp.toDate ? firestoreTimestamp.toDate() : new Date(firestoreTimestamp);
    const diffMs = now - notifDate;
    const diffMins = Math.floor(diffMs / (1000 * 60));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;

    return notifDate.toLocaleDateString();
  } catch (err) {
    console.error('[SuriinAI NotificationBell] Error formatting time:', err);
    return 'Unknown time';
  }
}

function escapeHtml(input) {
  return String(input || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
