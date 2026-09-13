/**
 * admin-settings.js — Suriin AI Admin Settings Logic
 * ═══════════════════════════════════════════════════════════════════════════
 * Handles:
 *   1. Tab navigation between Account and System sections
 *   2. Account settings (name, password, theme) - reused from settings.js
 *   3. System configuration (maintenance mode, registrations, AI threshold)
 *   4. Auto-save system config with debounce
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

// ── Wait for auth to be ready ─────────────────────────────────────────────────
window.addEventListener('suriin:auth-ready', (e) => {
  const { user, role } = e.detail;
  if (user && role === 'admin') {
    initAdminSettings(user, role);
  } else if (user) {
    // Non-admin users shouldn't be on this page
    window.location.href = '/user-dashboard';
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════════════════

async function initAdminSettings(user, role) {
  const db = window.__suriinFirestore;

  // ── Setup tab navigation ─────────────────────────────────────────────────
  setupTabNavigation();

  // ── Populate account info ─────────────────────────────────────────────────
  const emailEl = document.getElementById('settings-email');
  const createdEl = document.getElementById('settings-created');
  const lastLoginEl = document.getElementById('settings-last-login');
  const displayNameInput = document.getElementById('settings-display-name');

  if (emailEl) emailEl.textContent = user.email || '—';

  // Pre-fill display name from Firebase Auth
  if (displayNameInput) displayNameInput.value = user.displayName || '';

  // ── Setup form handlers (don't block on Firestore) ──────────────────────
  setupProfilePicture(user);
  setupUpdateProfileForm(user, db);
  setupChangePasswordForm(user);
  setupThemeToggle(user, db);
  setupSystemConfig(db, user.uid);
  setupIntelligenceSettings(db, user.uid);

  // Fetch timestamps + profile fields from Firestore
  if (db) {
    db.collection('Users').doc(user.uid).get()
      .then((userDoc) => {
        if (userDoc.exists) {
          const data = userDoc.data();
          if (createdEl && data.createdAt) createdEl.textContent = formatSettingsDate(data.createdAt);
          if (lastLoginEl && data.lastLogin) lastLoginEl.textContent = formatSettingsDate(data.lastLogin);
          const fnEl = document.getElementById('settings-first-name');
          const lnEl = document.getElementById('settings-last-name');
          const phoneEl = document.getElementById('settings-phone');
          if (fnEl && data.firstName) fnEl.value = data.firstName;
          if (lnEl && data.lastName) lnEl.value = data.lastName;
          if (phoneEl && data.phone) phoneEl.value = data.phone;
          if (displayNameInput && data.displayName) displayNameInput.value = data.displayName;
        }
      })
      .catch((err) => console.error('[SuriinAI AdminSettings] Error fetching profile:', err));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TAB NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════

function setupTabNavigation() {
  const tabAccount = document.getElementById('tab-account');
  const tabSystem = document.getElementById('tab-system');
  const contentAccount = document.getElementById('tab-content-account');
  const contentSystem = document.getElementById('tab-content-system');

  if (!tabAccount || !tabSystem || !contentAccount || !contentSystem) return;

  tabAccount.addEventListener('click', () => {
    tabAccount.classList.add('auth-tab--active');
    tabSystem.classList.remove('auth-tab--active');
    contentAccount.style.display = 'block';
    contentSystem.style.display = 'none';
  });

  tabSystem.addEventListener('click', () => {
    tabSystem.classList.add('auth-tab--active');
    tabAccount.classList.remove('auth-tab--active');
    contentSystem.style.display = 'block';
    contentAccount.style.display = 'none';
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PROFILE PICTURE
// ═══════════════════════════════════════════════════════════════════════════════

function setupProfilePicture(user) {
  const picInput = document.getElementById('profile-pic-input');
  const picAvatar = document.getElementById('profile-pic-avatar');
  const picOverlay = document.getElementById('profile-pic-overlay');
  const removeBtn = document.getElementById('remove-profile-pic-btn');
  const navAvatar = document.getElementById('user-avatar');

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

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Failed to load image for compression.'));
      };

      img.src = objectUrl;
    });
  }

  // Show initials immediately
  picAvatar.textContent = getInitials();

  const avatarCacheKey = `suriin_avatar_${user.uid}`;

  // Try sessionStorage cache
  let resolved = false;
  try {
    const fromStorage = sessionStorage.getItem(avatarCacheKey);
    if (fromStorage) {
      applyPhoto(fromStorage);
      resolved = true;
    }
  } catch (e) {}

  // Try navbar avatar
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

  // Fetch from Firestore
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

  if (picOverlay) {
    picOverlay.addEventListener('click', () => picInput.click());
  }

  picInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    picInput.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showAdminToast('Please select an image file (JPG, PNG, GIF).', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showAdminToast('Image must be smaller than 5 MB.', 'error');
      return;
    }
    if (!db) {
      showAdminToast('Database not available. Please refresh and try again.', 'error');
      return;
    }

    showAdminToast('Processing photo...', 'info');

    try {
      const compressed = await compressImage(file);
      await db.collection('Users').doc(user.uid).update({ photoURL: compressed });
      try { sessionStorage.setItem(`suriin_avatar_${user.uid}`, compressed); } catch (e) {}
      applyPhoto(compressed);
      showAdminToast('Profile picture updated!', 'success');
    } catch (err) {
      console.error('[SuriinAI AdminSettings] Save error:', err);
      showAdminToast(`Failed to save photo: ${err.message}`, 'error');
    }
  });

  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      if (!db) return;
      removeBtn.disabled = true;
      try {
        await db.collection('Users').doc(user.uid).update({ photoURL: null });
        try { sessionStorage.removeItem(`suriin_avatar_${user.uid}`); } catch (e) {}
        clearPhoto();
        showAdminToast('Profile picture removed.', 'info');
      } catch (err) {
        console.error('[SuriinAI AdminSettings] Remove error:', err);
        showAdminToast(`Failed to remove: ${err.message}`, 'error');
      } finally {
        removeBtn.disabled = false;
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UPDATE DISPLAY NAME
// ═══════════════════════════════════════════════════════════════════════════════

function setupUpdateProfileForm(user, db) {
  const form = document.getElementById('update-profile-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const firstName = (document.getElementById('settings-first-name')?.value || '').trim();
    const lastName  = (document.getElementById('settings-last-name')?.value  || '').trim();
    const phone     = (document.getElementById('settings-phone')?.value       || '').trim();
    const newName   = (document.getElementById('settings-display-name')?.value || '').trim();
    const btn = document.getElementById('update-profile-btn');

    if (!newName || newName.length < 2) {
      showAdminToast('Display name must be at least 2 characters.', 'error');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      await user.updateProfile({ displayName: newName });
      if (db) {
        const updates = { displayName: newName };
        if (firstName) updates.firstName = firstName;
        if (lastName)  updates.lastName  = lastName;
        if (phone)     updates.phone     = phone;
        await db.collection('Users').doc(user.uid).update(updates);
      }

      const avatarEl = document.getElementById('user-avatar');
      if (avatarEl) avatarEl.textContent = newName.substring(0, 2).toUpperCase();

      showAdminToast('Profile updated successfully!', 'success');
    } catch (err) {
      console.error('[SuriinAI AdminSettings] Update profile error:', err);
      showAdminToast(`Failed to update profile: ${err.message}`, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CHANGE PASSWORD
// ═══════════════════════════════════════════════════════════════════════════════

function setupChangePasswordForm(user) {
  const form = document.getElementById('change-password-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const currentPwInput = document.getElementById('settings-current-password');
    const newPwInput = document.getElementById('settings-new-password');
    const confirmPwInput = document.getElementById('settings-confirm-password');
    const btn = document.getElementById('change-password-btn');

    const currentPassword = currentPwInput.value;
    const newPassword = newPwInput.value;
    const confirmPassword = confirmPwInput.value;

    if (!currentPassword || !newPassword || !confirmPassword) {
      showAdminToast('Please fill in all password fields.', 'error');
      return;
    }

    if (newPassword.length < 6) {
      showAdminToast('New password must be at least 6 characters.', 'error');
      return;
    }

    if (newPassword !== confirmPassword) {
      showAdminToast('New passwords do not match.', 'error');
      return;
    }

    if (currentPassword === newPassword) {
      showAdminToast('New password must be different from current password.', 'error');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      const credential = firebase.auth.EmailAuthProvider.credential(
        user.email,
        currentPassword
      );

      await user.reauthenticateWithCredential(credential);
      await user.updatePassword(newPassword);

      currentPwInput.value = '';
      newPwInput.value = '';
      confirmPwInput.value = '';

      showAdminToast('Password changed successfully!', 'success');
    } catch (err) {
      console.error('[SuriinAI AdminSettings] Change password error:', err);

      const errorMessages = {
        'auth/wrong-password': 'Current password is incorrect.',
        'auth/invalid-credential': 'Current password is incorrect.',
        'auth/weak-password': 'New password is too weak. Use at least 6 characters.',
        'auth/requires-recent-login': 'Session expired. Please log out and log in again.',
        'auth/too-many-requests': 'Too many attempts. Please try again later.',
        'auth/network-request-failed': 'Network error. Check your internet connection.',
      };

      const code = err.code || '';
      const message = errorMessages[code] || `Failed to change password: ${err.message}`;
      showAdminToast(message, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  THEME TOGGLE
// ═══════════════════════════════════════════════════════════════════════════════

function setupThemeToggle(user, db) {
  const themeToggle = document.getElementById('theme-toggle');
  const themeWrapper = document.getElementById('theme-toggle-wrapper');

  if (!themeToggle) return;

  // Load saved preference
  const savedTheme = localStorage.getItem('suriin_theme') || 'light';
  themeToggle.checked = savedTheme === 'dark';
  applyTheme(savedTheme);

  // Wrapper click handler
  if (themeWrapper) {
    themeWrapper.addEventListener('click', (e) => {
      e.preventDefault();
      themeToggle.checked = !themeToggle.checked;
      themeToggle.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  themeToggle.addEventListener('change', async (e) => {
    const isDark = e.target.checked;
    const theme = isDark ? 'dark' : 'light';
    applyTheme(theme);
    localStorage.setItem('suriin_theme', theme);
    showAdminToast(`${isDark ? 'Dark' : 'Light'} mode enabled`, 'success');
  });
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark-theme');
  } else {
    document.documentElement.classList.remove('dark-theme');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SYSTEM CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

function setupSystemConfig(db, adminUid) {
  if (!db) return;

  const maintenanceToggle = document.getElementById('maintenance-toggle');
  const maintenanceWrapper = document.getElementById('maintenance-toggle-wrapper');
  const registrationToggle = document.getElementById('registration-toggle');
  const registrationWrapper = document.getElementById('registration-toggle-wrapper');
  const aiThresholdSlider = document.getElementById('ai-threshold-slider');
  const aiThresholdValue = document.getElementById('ai-threshold-value');
  const lastUpdatedEl = document.getElementById('system-config-updated');

  const configRef = db.collection('system_config').doc('global_settings');

  // Debounce helper
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // Save config to Firestore
  const saveConfig = debounce(async (updates) => {
    try {
      await configRef.update({
        ...updates,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: adminUid
      });
      showAdminToast('System configuration saved', 'success');
    } catch (err) {
      console.error('[SuriinAI AdminSettings] Error saving config:', err);
      showAdminToast('Failed to save configuration', 'error');
    }
  }, 500);

  // Load current config
  configRef.get()
    .then((doc) => {
      if (doc.exists) {
        const data = doc.data();

        // Maintenance mode
        if (maintenanceToggle) {
          maintenanceToggle.checked = data.maintenanceMode || false;
        }

        // Accept new registrations
        if (registrationToggle) {
          registrationToggle.checked = data.acceptNewRegistrations !== false; // default true
        }

        // AI threshold
        if (aiThresholdSlider) {
          const threshold = data.aiConfidenceThreshold !== undefined ? data.aiConfidenceThreshold : 75;
          aiThresholdSlider.value = threshold;
          if (aiThresholdValue) aiThresholdValue.textContent = `${threshold}%`;
        }

        // Last updated
        if (lastUpdatedEl && data.updatedAt) {
          lastUpdatedEl.textContent = formatSettingsDate(data.updatedAt);
        }
      } else {
        // Document doesn't exist - create with defaults
        configRef.set({
          maintenanceMode: false,
          acceptNewRegistrations: true,
          aiConfidenceThreshold: 75,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedBy: adminUid
        });
      }
    })
    .catch((err) => {
      console.error('[SuriinAI AdminSettings] Error loading config:', err);
    });

  // Toggle click handlers
  if (maintenanceWrapper) {
    maintenanceWrapper.addEventListener('click', (e) => {
      e.preventDefault();
      maintenanceToggle.checked = !maintenanceToggle.checked;
      maintenanceToggle.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  if (registrationWrapper) {
    registrationWrapper.addEventListener('click', (e) => {
      e.preventDefault();
      registrationToggle.checked = !registrationToggle.checked;
      registrationToggle.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Change handlers
  if (maintenanceToggle) {
    maintenanceToggle.addEventListener('change', (e) => {
      saveConfig({ maintenanceMode: e.target.checked });
    });
  }

  if (registrationToggle) {
    registrationToggle.addEventListener('change', (e) => {
      saveConfig({ acceptNewRegistrations: e.target.checked });
    });
  }

  if (aiThresholdSlider) {
    aiThresholdSlider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      if (aiThresholdValue) aiThresholdValue.textContent = `${value}%`;
    });

    aiThresholdSlider.addEventListener('change', (e) => {
      const value = parseInt(e.target.value, 10);
      saveConfig({ aiConfidenceThreshold: value });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INTELLIGENCE & PRIVACY SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

function setupIntelligenceSettings(db, adminUid) {
  if (!db) return;

  const syncBtn = document.getElementById('btn-sync-sec');
  const syncStatus = document.getElementById('sync-status');
  const syncMessage = document.getElementById('sync-message');
  const telemetryToggle = document.getElementById('telemetry-toggle');
  const telemetryWrapper = document.getElementById('telemetry-toggle-wrapper');

  // SEC Sync Button Handler
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      try {
        syncBtn.disabled = true;
        syncBtn.innerHTML = '<span>⏳</span><span>Syncing...</span>';
        if (syncStatus) {
          syncStatus.style.display = 'block';
          syncStatus.style.background = 'rgba(62, 207, 207, 0.1)';
          syncStatus.style.borderColor = 'rgba(62, 207, 207, 0.3)';
          syncMessage.textContent = 'Triggering SEC database sync...';
        }

        const auth = window.__suriinAuth;
        if (!auth?.user) {
          throw new Error('Not authenticated');
        }

        const token = await auth.user.getIdToken();
        const response = await fetch('/api/admin/sync-sec-watchlist', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'Sync failed');
        }

        if (syncStatus) {
          syncStatus.style.background = 'rgba(34, 197, 94, 0.1)';
          syncStatus.style.borderColor = 'rgba(34, 197, 94, 0.3)';
          syncMessage.textContent = `✅ ${data.message || 'Sync initiated successfully'}`;
        }
        showAdminToast('SEC database sync initiated', 'success');

      } catch (err) {
        console.error('[SuriinAI AdminSettings] SEC sync error:', err);
        showAdminToast('Failed to sync SEC database: ' + err.message, 'error');
        if (syncStatus) {
          syncStatus.style.background = 'rgba(239, 68, 68, 0.1)';
          syncStatus.style.borderColor = 'rgba(239, 68, 68, 0.3)';
          syncMessage.textContent = '❌ Sync failed: ' + err.message;
        }
      } finally {
        syncBtn.disabled = false;
        syncBtn.innerHTML = '<span>↻</span><span>Sync SEC Database Now</span>';
      }
    });
  }

  // Telemetry Toggle Handler
  if (telemetryWrapper && telemetryToggle) {
    // Load current preference
    db.collection('system_config').doc('global_settings').get()
      .then((doc) => {
        if (doc.exists) {
          const data = doc.data();
          telemetryToggle.checked = data.autoThreatTelemetry !== false; // default ON
        }
      })
      .catch((err) => {
        console.error('[SuriinAI AdminSettings] Error loading telemetry preference:', err);
      });

    // Toggle click handler
    telemetryWrapper.addEventListener('click', (e) => {
      e.preventDefault();
      telemetryToggle.checked = !telemetryToggle.checked;
      telemetryToggle.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Change handler
    telemetryToggle.addEventListener('change', async (e) => {
      try {
        await db.collection('system_config').doc('global_settings').update({
          autoThreatTelemetry: e.target.checked,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedBy: adminUid
        });
        showAdminToast(`Automated threat telemetry ${e.target.checked ? 'enabled' : 'disabled'}`, 'success');
      } catch (err) {
        console.error('[SuriinAI AdminSettings] Error saving telemetry preference:', err);
        showAdminToast('Failed to save telemetry preference', 'error');
        // Revert toggle
        telemetryToggle.checked = !e.target.checked;
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatSettingsDate(value) {
  if (!value) return '—';
  try {
    let d;
    if (typeof value === 'string') {
      d = new Date(value);
    } else if (value instanceof Date) {
      d = value;
    } else if (value && typeof value.toDate === 'function') {
      d = value.toDate();
    } else if (value && (value.seconds !== undefined || value._seconds !== undefined)) {
      d = new Date((value.seconds ?? value._seconds) * 1000);
    } else {
      d = new Date(value);
    }
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '—';
  }
}

function showAdminToast(message, type = 'info') {
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
