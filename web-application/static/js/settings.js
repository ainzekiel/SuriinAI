/**
 * settings.js — Suriin AI Account Settings Logic
 * ═══════════════════════════════════════════════════════════════════════════
 * Handles:
 *   1. Pre-filling account info from Firebase Auth + Firestore
 *   2. Updating display name (Auth profile + Firestore Users doc)
 *   3. Changing password (re-authenticate + update)
 *   4. Toast notifications for feedback
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

// ── Wait for auth to be ready ─────────────────────────────────────────────────
window.addEventListener('suriin:auth-ready', (e) => {
  const { user, role } = e.detail;
  if (user) initSettings(user, role);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════════════════

async function initSettings(user, role) {
  const db = window.__suriinFirestore;

  // ── Populate account info ─────────────────────────────────────────────────
  const emailEl      = document.getElementById('settings-email');
  const roleEl       = document.getElementById('settings-role');
  const createdEl    = document.getElementById('settings-created');
  const lastLoginEl  = document.getElementById('settings-last-login');
  const displayNameInput = document.getElementById('settings-display-name');

  if (emailEl) emailEl.textContent = user.email || '—';
  if (roleEl) {
    const roleLabels = { user: 'General User', general: 'General User', expert: 'Expert / Investigator', admin: 'Administrator' };
    roleEl.textContent = roleLabels[role] || 'General User';
  }

  // Pre-fill display name
  if (displayNameInput) {
    displayNameInput.value = user.displayName || '';
  }

  // ── Setup form handlers immediately (don't block on Firestore) ────────────
  setupProfilePicture(user);
  setupUpdateProfileForm(user, db);
  setupUpdateNameForm(user, db);
  setupThemeToggle(user, db);
  setupChangePasswordForm(user);
  setupNotificationPreferences(user, db);
  setupDataPrivacyControls(user, db);

  // Fetch timestamps + personal info fire-and-forget
  if (db) {
    db.collection('Users').doc(user.uid).get()
      .then((userDoc) => {
        if (userDoc.exists) {
          const data = userDoc.data();
          if (createdEl && data.createdAt)   createdEl.textContent  = formatSettingsDate(data.createdAt);
          if (lastLoginEl && data.lastLogin) lastLoginEl.textContent = formatSettingsDate(data.lastLogin);
          const fnEl = document.getElementById('settings-first-name');
          const lnEl = document.getElementById('settings-last-name');
          const phEl = document.getElementById('settings-phone');
          if (fnEl) fnEl.value = data.firstName || '';
          if (lnEl) lnEl.value = data.lastName  || '';
          if (phEl) phEl.value = data.phone      || '';
        }
      })
      .catch((err) => console.error('[SuriinAI Settings] Error fetching user doc:', err));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PERSONAL INFORMATION (first name, last name, phone)
// ═══════════════════════════════════════════════════════════════════════════════

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

    if (displayName && displayName.length < 2) {
      showSettingsToast('Display name must be at least 2 characters.', 'error');
      return;
    }

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

      showSettingsToast('Profile updated successfully!', 'success');
    } catch (err) {
      console.error('[SuriinAI Settings] Profile update error:', err);
      showSettingsToast('Failed to update: ' + err.message, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PROFILE PICTURE
// ═══════════════════════════════════════════════════════════════════════════════

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

  // ── Compress image via canvas (max 256×256, JPEG 70%) ─────────────────────
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
        canvas.width  = width;
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

  // ── Load existing photo on init ────────────────────────────────────────
  // Show initials immediately as placeholder
  picAvatar.textContent = getInitials();

  const avatarCacheKey = `suriin_avatar_${user.uid}`;

  // 1. Try sessionStorage cache (instant)
  let resolved = false;
  try {
    const fromStorage = sessionStorage.getItem(avatarCacheKey);
    if (fromStorage) {
      applyPhoto(fromStorage);
      resolved = true;
    }
  } catch (e) {}

  // 2. Try reading from the navbar avatar element (set by instantReveal)
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

  // 3. Always fetch from Firestore as authoritative source (fire-and-forget)
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

  // Click on camera overlay also triggers picker
  if (picOverlay) {
    picOverlay.addEventListener('click', () => picInput.click());
  }

  // ── File selected → compress → save to Firestore ───────────────────────────
  picInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    picInput.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showSettingsToast('Please select an image file (JPG, PNG, GIF).', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showSettingsToast('Image must be smaller than 5 MB.', 'error');
      return;
    }
    if (!db) {
      showSettingsToast('Database not available. Please refresh and try again.', 'error');
      return;
    }

    showSettingsToast('Processing photo…', 'info');

    try {
      const compressed = await compressImage(file);

      await db.collection('Users').doc(user.uid).update({ photoURL: compressed });

      // Update avatar cache so nav avatar reflects the new photo immediately
      try { sessionStorage.setItem(`suriin_avatar_${user.uid}`, compressed); } catch (e) {}

      applyPhoto(compressed);
      showSettingsToast('Profile picture updated!', 'success');
      console.log('[SuriinAI Settings] Profile picture saved to Firestore.');
    } catch (err) {
      console.error('[SuriinAI Settings] Save error:', err);
      showSettingsToast(`Failed to save photo: ${err.message}`, 'error');
    }
  });

  // ── Remove photo ───────────────────────────────────────────────────────────
  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      if (!db) return;
      removeBtn.disabled = true;
      try {
        await db.collection('Users').doc(user.uid).update({ photoURL: null });

        // Clear avatar cache
        try { sessionStorage.removeItem(`suriin_avatar_${user.uid}`); } catch (e) {}

        clearPhoto();
        showSettingsToast('Profile picture removed.', 'info');
        console.log('[SuriinAI Settings] Profile picture removed from Firestore.');
      } catch (err) {
        console.error('[SuriinAI Settings] Remove error:', err);
        showSettingsToast(`Failed to remove: ${err.message}`, 'error');
      } finally {
        removeBtn.disabled = false;
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UPDATE DISPLAY NAME
// ═══════════════════════════════════════════════════════════════════════════════

function setupUpdateNameForm(user, db) {
  const form = document.getElementById('update-name-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const nameInput = document.getElementById('settings-display-name');
    const btn       = document.getElementById('update-name-btn');
    const newName   = nameInput.value.trim();

    if (!newName || newName.length < 2) {
      showSettingsToast('Display name must be at least 2 characters.', 'error');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      // Update Firebase Auth profile
      await user.updateProfile({ displayName: newName });

      // Update Firestore Users doc
      if (db) {
        await db.collection('Users').doc(user.uid).update({
          displayName: newName
        });
      }

      // Update avatar in header
      const avatarEl = document.getElementById('user-avatar');
      if (avatarEl) {
        avatarEl.textContent = newName.substring(0, 2).toUpperCase();
      }

      showSettingsToast('Display name updated successfully!', 'success');
      console.log('[SuriinAI Settings] Display name updated to:', newName);
    } catch (err) {
      console.error('[SuriinAI Settings] Update name error:', err);
      showSettingsToast(`Failed to update name: ${err.message}`, 'error');
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
    const newPwInput     = document.getElementById('settings-new-password');
    const confirmPwInput = document.getElementById('settings-confirm-password');
    const btn            = document.getElementById('change-password-btn');

    const currentPassword = currentPwInput.value;
    const newPassword     = newPwInput.value;
    const confirmPassword = confirmPwInput.value;

    // Validation
    if (!currentPassword || !newPassword || !confirmPassword) {
      showSettingsToast('Please fill in all password fields.', 'error');
      return;
    }

    if (newPassword.length < 6) {
      showSettingsToast('New password must be at least 6 characters.', 'error');
      return;
    }

    if (newPassword !== confirmPassword) {
      showSettingsToast('New passwords do not match.', 'error');
      return;
    }

    if (currentPassword === newPassword) {
      showSettingsToast('New password must be different from current password.', 'error');
      return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      // Re-authenticate user first
      const credential = firebase.auth.EmailAuthProvider.credential(
        user.email,
        currentPassword
      );

      await user.reauthenticateWithCredential(credential);
      console.log('[SuriinAI Settings] Re-authentication successful');

      // Update password
      await user.updatePassword(newPassword);

      // Clear the form
      currentPwInput.value = '';
      newPwInput.value = '';
      confirmPwInput.value = '';

      showSettingsToast('Password changed successfully!', 'success');
      console.log('[SuriinAI Settings] Password updated');
    } catch (err) {
      console.error('[SuriinAI Settings] Change password error:', err);

      const errorMessages = {
        'auth/wrong-password':        'Current password is incorrect.',
        'auth/invalid-credential':    'Current password is incorrect.',
        'auth/weak-password':         'New password is too weak. Use at least 6 characters.',
        'auth/requires-recent-login': 'Session expired. Please log out and log in again.',
        'auth/too-many-requests':     'Too many attempts. Please try again later.',
        'auth/network-request-failed':'Network error. Check your internet connection.',
      };

      const code = err.code || '';
      const message = errorMessages[code] || `Failed to change password: ${err.message}`;
      showSettingsToast(message, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  NOTIFICATION PREFERENCES
// ═══════════════════════════════════════════════════════════════════════════════

function setupNotificationPreferences(user, db) {
  const expertReviewToggle = document.getElementById('notif-expert-review-toggle');
  const weeklyTipsToggle = document.getElementById('notif-weekly-tips-toggle');
  const expertReviewWrapper = document.getElementById('notif-expert-review-toggle-wrapper');
  const weeklyTipsWrapper = document.getElementById('notif-weekly-tips-toggle-wrapper');

  if (!expertReviewToggle || !weeklyTipsToggle) return;

  // Load current preferences from Firestore
  if (db) {
    db.collection('Users').doc(user.uid).get()
      .then((doc) => {
        if (doc.exists) {
          const data = doc.data();
          expertReviewToggle.checked = data.notifExpertReview || false;
          weeklyTipsToggle.checked = data.notifWeeklyTips || false;
        }
      })
      .catch((err) => {
        console.error('[SuriinAI Settings] Error loading notification preferences:', err);
      });
  }

  // Add click handlers to toggle buttons to toggle hidden checkboxes
  if (expertReviewWrapper) {
    expertReviewWrapper.addEventListener('click', (e) => {
      e.preventDefault();
      expertReviewToggle.checked = !expertReviewToggle.checked;
      expertReviewToggle.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  if (weeklyTipsWrapper) {
    weeklyTipsWrapper.addEventListener('click', (e) => {
      e.preventDefault();
      weeklyTipsToggle.checked = !weeklyTipsToggle.checked;
      weeklyTipsToggle.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Add change listeners
  expertReviewToggle.addEventListener('change', async (e) => {
    const newValue = e.target.checked;
    try {
      if (db) {
        await db.collection('Users').doc(user.uid).update({
          notifExpertReview: newValue
        });
      }
      console.log('[SuriinAI Settings] Expert review notification preference updated to:', newValue);
      showSettingsToast('Notification preferences updated!', 'success');
    } catch (err) {
      console.error('[SuriinAI Settings] Error updating expert review preference:', err);
      showSettingsToast('Failed to update preferences.', 'error');
      e.target.checked = !newValue; // Revert on error
    }
  });

  weeklyTipsToggle.addEventListener('change', async (e) => {
    const newValue = e.target.checked;
    try {
      if (db) {
        await db.collection('Users').doc(user.uid).update({
          notifWeeklyTips: newValue
        });
      }
      console.log('[SuriinAI Settings] Weekly tips notification preference updated to:', newValue);
      showSettingsToast('Notification preferences updated!', 'success');
    } catch (err) {
      console.error('[SuriinAI Settings] Error updating weekly tips preference:', err);
      showSettingsToast('Failed to update preferences.', 'error');
      e.target.checked = !newValue; // Revert on error
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DATA PRIVACY CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════

function setupDataPrivacyControls(user, db) {
  const exportBtn = document.getElementById('export-data-btn');
  const deleteBtn = document.getElementById('delete-account-btn');

  if (exportBtn) {
    exportBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      exportBtn.disabled = true;
      const originalText = exportBtn.textContent;
      exportBtn.innerHTML = '<span class="spinner"></span> Generating PDF...';
      
      try {
        const response = await fetch('/api/user/export-data', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${await user.getIdToken()}`
          }
        });

        if (response.ok) {
          // Get the blob and show in preview overlay
          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);
          const fileName = 'SuriinAI_UserData_Export.pdf';
          
          // Build preview overlay
          const overlayEl = document.createElement('div');
          overlayEl.className = 'pdf-preview-overlay';
          overlayEl.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';

          const cardEl = document.createElement('div');
          cardEl.className = 'pdf-preview-card';
          cardEl.style.cssText = 'background:#1e1e2f;border-radius:12px;width:90%;max-width:900px;height:90%;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 25px 50px rgba(0,0,0,0.5);';

          const headerEl = document.createElement('div');
          headerEl.className = 'pdf-preview-header';
          headerEl.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #333;background:#252538;';

          const titleEl = document.createElement('span');
          titleEl.className = 'pdf-preview-header__title';
          titleEl.style.cssText = 'color:#fff;font-size:14px;font-weight:500;';
          titleEl.textContent = `📄 ${fileName}`;

          const btnGroup = document.createElement('div');
          btnGroup.style.cssText = 'display:flex;gap:8px;';

          const dlBtn = document.createElement('a');
          dlBtn.className = 'pdf-preview-header__btn pdf-preview-header__btn--download';
          dlBtn.style.cssText = 'padding:6px 12px;background:#6C63FF;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;font-weight:500;';
          dlBtn.href = blobUrl;
          dlBtn.download = fileName;
          dlBtn.textContent = '⬇ Download';

          const closeBtn = document.createElement('button');
          closeBtn.className = 'pdf-preview-header__btn pdf-preview-header__btn--close';
          closeBtn.style.cssText = 'padding:6px 12px;background:#374151;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;';
          closeBtn.textContent = '✕ Close';

          btnGroup.appendChild(dlBtn);
          btnGroup.appendChild(closeBtn);
          headerEl.appendChild(titleEl);
          headerEl.appendChild(btnGroup);

          const frameEl = document.createElement('iframe');
          frameEl.className = 'pdf-preview-frame';
          frameEl.style.cssText = 'flex:1;border:none;width:100%;background:#fff;';
          frameEl.src = blobUrl;
          frameEl.title = 'PDF Preview';

          cardEl.appendChild(headerEl);
          cardEl.appendChild(frameEl);
          overlayEl.appendChild(cardEl);
          document.body.appendChild(overlayEl);

          // Close handlers
          function closePdfPreview() {
            overlayEl.remove();
            URL.revokeObjectURL(blobUrl);
            document.removeEventListener('keydown', onEsc);
          }
          function onEsc(e) { if (e.key === 'Escape') closePdfPreview(); }

          closeBtn.addEventListener('click', closePdfPreview);
          overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closePdfPreview(); });
          document.addEventListener('keydown', onEsc);
          
          showSettingsToast('PDF ready - preview opened.', 'success');
          console.log('[SuriinAI Settings] Data export PDF preview opened');
        } else {
          const errorData = await response.json().catch(() => ({}));
          showSettingsToast(errorData.error || 'Failed to generate export. Please try again.', 'error');
        }
      } catch (err) {
        console.error('[SuriinAI Settings] Error generating data export:', err);
        showSettingsToast(`Error: ${err.message}`, 'error');
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = originalText;
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', async (e) => {
      e.preventDefault();

      // Enhanced confirmation dialog with email verification - DARK THEME
      const confirmationHtml = `
        <div style="font-family: system-ui, -apple-system, sans-serif; color: #F3F4F6; padding: 0 24px;">
          <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; padding: 16px; margin-bottom: 20px;">
            <h3 style="color: #ef4444; margin: 0 0 12px 0; font-size: 18px; display: flex; align-items: center; gap: 8px;">
              <svg width="24" height="24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
              Delete Account Permanently
            </h3>
            <p style="color: #fca5a5; margin: 0; font-size: 14px; line-height: 1.5;">
              This action <strong style="color: #F3F4F6;">CANNOT be undone</strong>. Your account and personal data will be permanently removed from our servers.
            </p>
          </div>
          
          <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 16px; margin-bottom: 20px;">
            <h4 style="margin: 0 0 12px 0; font-size: 14px; color: #F3F4F6;">What will happen:</h4>
            <ul style="margin: 0; padding-left: 20px; color: #9CA3AF; font-size: 13px; line-height: 1.6;">
              <li>Your account will be permanently deleted from Firebase Auth</li>
              <li>Your profile will be removed from our database</li>
              <li>Your submitted reports will be <strong style="color: #F3F4F6;">anonymized</strong> (reporter changed to 'anonymous')</li>
              <li>Report evidence and threat data will be preserved to help protect others</li>
            </ul>
          </div>
          
          <div style="margin-bottom: 16px;">
            <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer; font-size: 14px; color: #F3F4F6;">
              <input type="checkbox" id="delete-confirm-checkbox" style="margin-top: 2px; accent-color: #ef4444;">
              <span>I understand this action cannot be undone and I want to permanently delete my account.</span>
            </label>
          </div>
          
          <div style="margin-bottom: 20px;">
            <label style="display: block; font-size: 13px; color: #6B7280; margin-bottom: 6px;">
              To confirm, type your email address: <strong style="color: #F3F4F6;">${user.email}</strong>
            </label>
            <input type="email" id="delete-confirm-email" placeholder="Enter your email" 
              style="width: 100%; padding: 10px 12px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; font-size: 14px; color: #F3F4F6; box-sizing: border-box; outline: none;">
          </div>
        </div>
      `;

      // Create modal overlay - DARK THEME
      const modalOverlay = document.createElement('div');
      modalOverlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.8); z-index: 10000;
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
      `;
      
      const modalContent = document.createElement('div');
      modalContent.style.cssText = `
        background: rgba(17, 24, 39, 0.95); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; max-width: 540px; width: 100%;
        backdrop-filter: blur(24px) saturate(1.2); box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); padding-top: 24px;
      `;
      modalContent.innerHTML = confirmationHtml + `
        <div style="display: flex; gap: 12px; padding: 20px 24px 24px 24px;">
          <button id="confirm-delete-btn" style="flex: 1; padding: 12px; background: linear-gradient(135deg, #ef4444, #DC2626); color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; opacity: 0.5; transition: opacity 0.2s;" disabled>
            Delete My Account
          </button>
          <button id="cancel-delete-btn" style="flex: 1; padding: 12px; background: transparent; color: #9CA3AF; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;">
            Cancel
          </button>
        </div>
      `;
      
      modalOverlay.appendChild(modalContent);
      document.body.appendChild(modalOverlay);
      
      // Prevent background scrolling
      document.body.style.overflow = 'hidden';
      
      // Handle checkbox and email validation
      const checkbox = modalContent.querySelector('#delete-confirm-checkbox');
      const emailInput = modalContent.querySelector('#delete-confirm-email');
      const confirmBtn = modalContent.querySelector('#confirm-delete-btn');
      const cancelBtn = modalContent.querySelector('#cancel-delete-btn');
      
      function validateConfirmation() {
        const isChecked = checkbox.checked;
        const emailMatches = emailInput.value.trim().toLowerCase() === user.email.toLowerCase();
        confirmBtn.disabled = !(isChecked && emailMatches);
        confirmBtn.style.opacity = confirmBtn.disabled ? '0.5' : '1';
      }
      
      checkbox.addEventListener('change', validateConfirmation);
      emailInput.addEventListener('input', validateConfirmation);
      
      // Close modal function
      function closeModal() {
        document.body.style.overflow = '';
        modalOverlay.remove();
      }
      
      cancelBtn.addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
      });
      
      // Handle confirmed deletion
      confirmBtn.addEventListener('click', async () => {
        closeModal();
        
        deleteBtn.disabled = true;
        const originalText = deleteBtn.textContent;
        deleteBtn.innerHTML = '<span class="spinner"></span> Deleting...';
        
        try {
          const response = await fetch('/api/user/delete-account', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${await user.getIdToken()}`
            }
          });

          if (response.ok) {
            const result = await response.json();
            showSettingsToast(`Account deleted. ${result.anonymized_reports || 0} reports anonymized. Redirecting...`, 'success');
            console.log('[SuriinAI Settings] Account deleted successfully');

            // Clear session storage
            sessionStorage.clear();
            localStorage.removeItem('suriin_cached_uid');

            // Sign out and redirect after a brief delay
            setTimeout(async () => {
              try {
                const auth = window.__suriinFirebaseAuth || firebase.auth();
                await auth.signOut();
                window.location.href = '/?deleted=1';
              } catch (err) {
                console.error('[SuriinAI Settings] Error signing out:', err);
                window.location.href = '/?deleted=1';
              }
            }, 2000);
          } else {
            const errorData = await response.json().catch(() => ({}));
            showSettingsToast(errorData.error || 'Failed to delete account. Please try again or contact support.', 'error');
            deleteBtn.textContent = originalText;
            deleteBtn.disabled = false;
          }
        } catch (err) {
          console.error('[SuriinAI Settings] Error deleting account:', err);
          showSettingsToast(`Error: ${err.message}`, 'error');
          deleteBtn.textContent = originalText;
          deleteBtn.disabled = false;
        }
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  THEME TOGGLE
// ═══════════════════════════════════════════════════════════════════════════════

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
    showSettingsToast(`${isDark ? 'Dark' : 'Light'} mode enabled`, 'success');
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
      // Firestore Timestamp object
      d = value.toDate();
    } else if (value && (value.seconds !== undefined || value._seconds !== undefined)) {
      // Serialised Firestore Timestamp { seconds, nanoseconds }
      d = new Date((value.seconds ?? value._seconds) * 1000);
    } else {
      d = new Date(value);
    }
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
      month: 'long',
      day:   'numeric',
      year:  'numeric',
      hour:  '2-digit',
      minute:'2-digit'
    });
  } catch {
    return '—';
  }
}

function showSettingsToast(message, type = 'info') {
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
