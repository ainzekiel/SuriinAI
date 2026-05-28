/**
 * expert-settings.js — Suriin AI Expert Account Settings
 * ════════════════════════════════════════════════════════════
 * Handles:
 *   1. Populating account info from Firebase Auth + Firestore
 *   2. Change-password form (re-auth + update)
 *   3. Notification Preferences toggle — preferences.email_new_assignments
 * ════════════════════════════════════════════════════════════
 */

'use strict';

// ── Wait for the shared auth module to signal readiness ──────────────────────
window.addEventListener('suriin:auth-ready', (e) => {
  const { user, role } = e.detail;

  if (role !== 'expert') {
    window.location.href = role === 'admin' ? '/admin-dashboard' : '/user-dashboard';
    return;
  }

  if (user) initExpertSettings(user);
});

// ════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════

async function initExpertSettings(user) {
  const db = window.__suriinFirestore;

  // Populate static fields
  const emailEl     = document.getElementById('settings-email');
  const createdEl   = document.getElementById('settings-created');
  const lastLoginEl = document.getElementById('settings-last-login');

  if (emailEl) emailEl.textContent = user.email || '—';

  const displayNameInput = document.getElementById('settings-display-name');
  if (displayNameInput) displayNameInput.value = user.displayName || '';

  // Wire up forms and toggles immediately — don't block on Firestore
  setupProfilePicture(user);
  setupUpdateProfileForm(user, db);
  setupUpdateNameForm(user, db);
  setupChangePasswordForm(user);
  setupThemeToggle(user, db);
  setupNotificationPreferences(user, db);

  // Fetch timestamps + personal info asynchronously
  if (db) {
    db.collection('Users').doc(user.uid).get()
      .then((doc) => {
        if (doc.exists) {
          const data = doc.data();
          if (createdEl   && data.createdAt)  createdEl.textContent  = formatDate(data.createdAt);
          if (lastLoginEl && data.lastLogin)  lastLoginEl.textContent = formatDate(data.lastLogin);
          const fnEl = document.getElementById('settings-first-name');
          const lnEl = document.getElementById('settings-last-name');
          const phEl = document.getElementById('settings-phone');
          if (fnEl) fnEl.value = data.firstName || '';
          if (lnEl) lnEl.value = data.lastName  || '';
          if (phEl) phEl.value = data.phone      || '';
        }
      })
      .catch((err) => console.error('[ExpertSettings] Timestamp fetch error:', err));
  }

  // Reveal dashboard after setup
  const loadingOverlay   = document.getElementById('loading-overlay');
  const dashboardWrapper = document.getElementById('dashboard-wrapper');
  if (loadingOverlay)   loadingOverlay.classList.add('hidden');
  if (dashboardWrapper) dashboardWrapper.style.display = '';
}

// ════════════════════════════════════════════════════════════
//  PERSONAL INFORMATION
// ════════════════════════════════════════════════════════════

function setupUpdateProfileForm(user, db) {
  const form = document.getElementById('update-profile-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const firstName   = (document.getElementById('settings-first-name')?.value  || '').trim();
    const lastName    = (document.getElementById('settings-last-name')?.value   || '').trim();
    const phone       = (document.getElementById('settings-phone')?.value       || '').trim();
    const displayName = (document.getElementById('settings-display-name')?.value || '').trim()
                        || [firstName, lastName].filter(Boolean).join(' ')
                        || user.displayName || '';
    const btn = document.getElementById('update-profile-btn');
    if (displayName && displayName.length < 2) { showToast('Display name must be at least 2 characters.', 'error'); return; }
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      if (db) {
        const update = { firstName, lastName, phone };
        if (displayName) update.displayName = displayName;
        await db.collection('Users').doc(user.uid).update(update);
      }
      if (displayName) await user.updateProfile({ displayName });
      const avatarEl = document.getElementById('user-avatar');
      if (avatarEl && displayName) avatarEl.textContent = displayName.substring(0, 2).toUpperCase();
      showToast('Personal information updated!', 'success');
    } catch (err) {
      console.error('[ExpertSettings] Profile update error:', err);
      showToast('Failed to update: ' + err.message, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}

// ════════════════════════════════════════════════════════════
//  PROFILE PICTURE
// ════════════════════════════════════════════════════════════

function setupProfilePicture(user) {
  const picInput   = document.getElementById('profile-pic-input');
  const picAvatar  = document.getElementById('profile-pic-avatar');
  const picOverlay = document.getElementById('profile-pic-overlay');
  const removeBtn  = document.getElementById('remove-profile-pic-btn');
  const navAvatar  = document.getElementById('user-avatar');

  if (!picAvatar || !picInput) return;

  const db = window.__suriinFirestore;

  function getInitials() {
    return (user.displayName || user.email || 'U')
      .split('@')[0].substring(0, 2).toUpperCase();
  }

  function applyPhoto(dataUrl) {
    const imgTag = `<img src="${dataUrl}" alt="Profile photo">`;
    picAvatar.innerHTML = imgTag;
    if (navAvatar) navAvatar.innerHTML = imgTag;
    if (removeBtn) removeBtn.style.display = '';
  }

  function clearPhoto() {
    const initials = getInitials();
    picAvatar.textContent = initials;
    if (navAvatar) navAvatar.textContent = initials;
    if (removeBtn) removeBtn.style.display = 'none';
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const MAX_SIZE = 256;
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let { width, height } = img;
        if (width > height) {
          if (width > MAX_SIZE) { height = Math.round(height * MAX_SIZE / width); width = MAX_SIZE; }
        } else {
          if (height > MAX_SIZE) { width = Math.round(width * MAX_SIZE / height); height = MAX_SIZE; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Failed to load image.')); };
      img.src = objectUrl;
    });
  }

  picAvatar.textContent = getInitials();
  const avatarCacheKey = `suriin_avatar_${user.uid}`;
  let resolved = false;

  try {
    const fromStorage = sessionStorage.getItem(avatarCacheKey);
    if (fromStorage) { applyPhoto(fromStorage); resolved = true; }
  } catch (e) {}

  if (!resolved) {
    try {
      const navImg = document.querySelector('#user-avatar img');
      if (navImg && navImg.src && navImg.src.startsWith('data:')) {
        applyPhoto(navImg.src);
        try { sessionStorage.setItem(avatarCacheKey, navImg.src); } catch (e) {}
        resolved = true;
      }
    } catch (e) {}
  }

  if (db) {
    db.collection('Users').doc(user.uid).get()
      .then((doc) => {
        const savedPhoto = doc.exists ? doc.data().photoURL : null;
        if (savedPhoto) {
          try { sessionStorage.setItem(avatarCacheKey, savedPhoto); } catch (e) {}
          applyPhoto(savedPhoto);
        } else if (!resolved) {
          picAvatar.textContent = getInitials();
          if (removeBtn) removeBtn.style.display = 'none';
        }
      })
      .catch(() => {});
  }

  if (picOverlay) picOverlay.addEventListener('click', () => picInput.click());

  picInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    picInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please select an image file (JPG, PNG, GIF).', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be smaller than 5 MB.', 'error'); return; }
    if (!db) { showToast('Database not available. Please refresh and try again.', 'error'); return; }
    showToast('Processing photo...', 'info');
    try {
      const compressed = await compressImage(file);
      await db.collection('Users').doc(user.uid).update({ photoURL: compressed });
      try { sessionStorage.setItem(avatarCacheKey, compressed); } catch (e) {}
      applyPhoto(compressed);
      showToast('Profile picture updated!', 'success');
    } catch (err) {
      showToast(`Failed to save photo: ${err.message}`, 'error');
    }
  });

  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      if (!db) return;
      removeBtn.disabled = true;
      try {
        await db.collection('Users').doc(user.uid).update({ photoURL: null });
        try { sessionStorage.removeItem(avatarCacheKey); } catch (e) {}
        clearPhoto();
        showToast('Profile picture removed.', 'info');
      } catch (err) {
        showToast(`Failed to remove: ${err.message}`, 'error');
      } finally {
        removeBtn.disabled = false;
      }
    });
  }
}

// ════════════════════════════════════════════════════════════
//  UPDATE DISPLAY NAME
// ════════════════════════════════════════════════════════════

function setupUpdateNameForm(user, db) {
  const form = document.getElementById('update-name-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('settings-display-name');
    const btn = document.getElementById('update-name-btn');
    const newName = nameInput.value.trim();
    if (!newName || newName.length < 2) { showToast('Display name must be at least 2 characters.', 'error'); return; }
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      await user.updateProfile({ displayName: newName });
      if (db) await db.collection('Users').doc(user.uid).update({ displayName: newName });
      const avatarEl = document.getElementById('user-avatar');
      if (avatarEl) avatarEl.textContent = newName.substring(0, 2).toUpperCase();
      showToast('Display name updated successfully!', 'success');
    } catch (err) {
      showToast(`Failed to update name: ${err.message}`, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}

// ════════════════════════════════════════════════════════════
//  THEME TOGGLE
// ════════════════════════════════════════════════════════════

function setupThemeToggle(user, db) {
  const themeToggle  = document.getElementById('theme-toggle');
  const themeWrapper = document.getElementById('theme-toggle-wrapper');
  if (!themeToggle) return;
  const savedTheme = localStorage.getItem('suriin_theme') || 'light';
  themeToggle.checked = savedTheme === 'dark';
  applyTheme(savedTheme);
  if (themeWrapper) {
    themeWrapper.addEventListener('click', (e) => {
      e.preventDefault();
      themeToggle.checked = !themeToggle.checked;
      themeToggle.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  themeToggle.addEventListener('change', (e) => {
    const isDark = e.target.checked;
    const theme = isDark ? 'dark' : 'light';
    applyTheme(theme);
    localStorage.setItem('suriin_theme', theme);
    showToast(`${isDark ? 'Dark' : 'Light'} mode enabled`, 'success');
  });
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark-theme');
  } else {
    document.documentElement.classList.remove('dark-theme');
  }
}

// ════════════════════════════════════════════════════════════
//  CHANGE PASSWORD
// ════════════════════════════════════════════════════════════

function setupChangePasswordForm(user) {
  const form = document.getElementById('change-password-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const currentPwInput  = document.getElementById('settings-current-password');
    const newPwInput      = document.getElementById('settings-new-password');
    const confirmPwInput  = document.getElementById('settings-confirm-password');
    const btn             = document.getElementById('change-password-btn');

    const currentPassword = currentPwInput.value;
    const newPassword     = newPwInput.value;
    const confirmPassword = confirmPwInput.value;

    if (!currentPassword || !newPassword || !confirmPassword) {
      showToast('Please fill in all password fields.', 'error');
      return;
    }
    if (newPassword.length < 6) {
      showToast('New password must be at least 6 characters.', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast('New passwords do not match.', 'error');
      return;
    }
    if (currentPassword === newPassword) {
      showToast('New password must differ from the current one.', 'error');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
      await user.reauthenticateWithCredential(credential);
      await user.updatePassword(newPassword);

      currentPwInput.value = '';
      newPwInput.value = '';
      confirmPwInput.value = '';

      showToast('Password changed successfully!', 'success');
    } catch (err) {
      const errorMessages = {
        'auth/wrong-password':        'Current password is incorrect.',
        'auth/invalid-credential':    'Current password is incorrect.',
        'auth/weak-password':         'New password is too weak.',
        'auth/requires-recent-login': 'Session expired. Please log out and sign in again.',
        'auth/too-many-requests':     'Too many attempts. Please try again later.',
      };
      showToast(errorMessages[err.code] || `Error: ${err.message}`, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}

// ════════════════════════════════════════════════════════════
//  NOTIFICATION PREFERENCES
//  Firestore path: Users/{uid}.preferences.email_new_assignments
// ════════════════════════════════════════════════════════════

function setupNotificationPreferences(user, db) {
  const toggle  = document.getElementById('notif-new-assignments-toggle');
  const wrapper = document.getElementById('notif-new-assignments-toggle-wrapper');

  if (!toggle || !wrapper) return;

  // ── Load current value from Firestore ────────────────────────────────────
  if (db) {
    db.collection('Users').doc(user.uid).get()
      .then((doc) => {
        if (doc.exists) {
          const prefs = doc.data().preferences || {};
          toggle.checked = Boolean(prefs.email_new_assignments);
          wrapper.setAttribute('aria-pressed', toggle.checked ? 'true' : 'false');
        }
      })
      .catch((err) => console.error('[ExpertSettings] Failed to load notification prefs:', err));
  }

  // ── Toggle button click → flip the hidden checkbox ───────────────────────
  wrapper.addEventListener('click', (e) => {
    e.preventDefault();
    toggle.checked = !toggle.checked;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // ── Persist on change ─────────────────────────────────────────────────────
  toggle.addEventListener('change', async (e) => {
    const newValue = e.target.checked;
    wrapper.setAttribute('aria-pressed', newValue ? 'true' : 'false');

    if (!db) {
      showToast('Database unavailable. Please refresh.', 'error');
      e.target.checked = !newValue;
      return;
    }

    try {
      await db.collection('Users').doc(user.uid).update({
        'preferences.email_new_assignments': newValue
      });
      showToast('Notification preference saved!', 'success');
      console.log('[ExpertSettings] preferences.email_new_assignments →', newValue);
    } catch (err) {
      console.error('[ExpertSettings] Failed to save notification pref:', err);
      showToast('Failed to save preference. Please try again.', 'error');
      // Revert the toggle on failure
      e.target.checked = !newValue;
      wrapper.setAttribute('aria-pressed', (!newValue) ? 'true' : 'false');
    }
  });
}

// ════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════

function formatSettingsDate(value) {
  return formatDate(value);
}

function formatDate(value) {
  if (!value) return '—';
  try {
    let d;
    if (typeof value.toDate === 'function') {
      d = value.toDate();
    } else if (value.seconds !== undefined) {
      d = new Date(value.seconds * 1000);
    } else {
      d = new Date(value);
    }
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return '—';
  }
}

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
