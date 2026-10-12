/**
 * auth.js — Suriin AI Authentication & Session Management
 * ═══════════════════════════════════════════════════════════════════════════
 * Handles:
 *   1. Firebase Client SDK initialization
 *   2. Email/password sign-in on the login page
 *   3. Auth state persistence (onAuthStateChanged)
 *   4. Role-based redirection (admin / expert / user)
 *   5. Auth guard on dashboard pages (redirect to login if unauthenticated)
 *   6. Logout functionality
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

// ── Firebase Configuration ────────────────────────────────────────────────────
// TODO: Replace these placeholder values with your actual Firebase project config.
// Find them in: Firebase Console → Project Settings → General → Your Apps → Web App
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAGcX1Q5Qkl3NQe_ccSVJTnvvcBZTTAti0",
  authDomain:        "suriinai.firebaseapp.com",
  projectId:         "suriinai",
  storageBucket:     "suriinai.firebasestorage.app",
  messagingSenderId: "269389508779",
  appId:             "1:269389508779:web:44b0c4b3e2745ba93887ee",
  measurementId:     "G-GCHEM2RM67" // Optional: if GA enabled
};

// ── Initialize Firebase ───────────────────────────────────────────────────────
let authInstance, dbInstance;

try {
  firebase.initializeApp(FIREBASE_CONFIG);
  authInstance = firebase.auth();
  dbInstance = firebase.firestore();
  
  // Expose Firebase instances immediately for dashboard pages (before auth callbacks fire)
  window.__suriinAuth = null;
  window.__suriinFirestore = dbInstance;
  window.__suriinStorage = (firebase.storage && typeof firebase.storage === 'function') ? firebase.storage() : null;
  window.__suriinAuthReady = false;  // Flag to track if auth completed
  window.__suriinAuthData = null;    // Store auth data for late-loading listeners
  
  console.log('[SuriinAI] Firebase initialized successfully');
} catch (err) {
  console.error('[SuriinAI] Firebase initialization error:', err);
  // Show login page on load even if Firebase fails (for debugging)
  window.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('loading-overlay');
    const loginWrapper = document.getElementById('login-wrapper');
    if (overlay) overlay.classList.add('hidden');
    if (loginWrapper) loginWrapper.style.display = '';
  });
}

// ── Page Detection ────────────────────────────────────────────────────────────
const currentPage = (() => {
  const path = window.location.pathname;
  if (path === '/' || path.includes('index'))          return 'login';
  if (path.includes('user-dashboard'))                 return 'user-dashboard';
  if (path.includes('expert-dashboard'))               return 'expert-dashboard';
  if (path.includes('expert-resolved'))                return 'expert-resolved';
  if (path.includes('admin-dashboard'))                return 'admin-dashboard';
  if (path.includes('admin-users'))                    return 'admin-users';
  if (path.includes('scam-awareness'))                 return 'scam-awareness';
  if (path.includes('settings'))                       return 'settings';
  if (path.includes('privacy'))                        return 'privacy';
  if (path.includes('help'))                           return 'help';
  return 'unknown';
})();

const currentPath = window.location.pathname;
const isAdminScopedPath = currentPath.startsWith('/admin/');
const isAdminPage = currentPage === 'admin-dashboard' || currentPage === 'admin-users';
const isExpertPage = currentPage === 'expert-dashboard' || currentPage === 'expert-resolved';

function normalizeRole(rawRole) {
  const role = (rawRole || '').toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'expert') return 'expert';
  return 'user';
}

function getDashboardPathForRole(role) {
  if (role === 'admin') return '/admin-dashboard';
  if (role === 'expert') return '/expert-dashboard';
  return '/user-dashboard';
}

async function fetchUserRole(user) {
  const profile = await fetchUserProfile(user);
  return profile.role;
}

const PROFILE_CACHE_KEY = (uid) => `suriin_profile_${uid}`;
const AVATAR_CACHE_KEY  = (uid) => `suriin_avatar_${uid}`;
const CACHED_UID_KEY = 'suriin_cached_uid';

async function fetchUserProfile(user) {
  // ── Cache check: return immediately if we have a fresh profile ────────────
  try {
    const cached = sessionStorage.getItem(PROFILE_CACHE_KEY(user.uid));
    if (cached) {
      const parsed = JSON.parse(cached);
      try {
        sessionStorage.setItem(CACHED_UID_KEY, user.uid);
        if (parsed && parsed.role) sessionStorage.setItem('suriin_cached_role', parsed.role);
      } catch (e) {}
      // Fire-and-forget lastLogin update — don't await so we don't block
      dbInstance.collection('Users').doc(user.uid)
        .update({ lastLogin: new Date().toISOString() })
        .catch(() => {});
      console.log('[SuriinAI Auth] Profile served from cache');
      return parsed;
    }
  } catch (e) { /* ignore parse errors */ }

  // ── Cache miss: fetch from Firestore ─────────────────────────────────────
  const userDocRef = dbInstance.collection('Users').doc(user.uid);
  const userDoc = await userDocRef.get();

  if (!userDoc.exists) {
    await userDocRef.set({
      email: user.email,
      displayName: user.displayName || 'User',
      role: 'user',
      suspended: false,
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString()
    });
    const freshProfile = { role: 'user', suspended: false, data: { role: 'user', suspended: false } };
    try {
      sessionStorage.setItem(PROFILE_CACHE_KEY(user.uid), JSON.stringify(freshProfile));
      sessionStorage.setItem(CACHED_UID_KEY, user.uid);
      sessionStorage.setItem('suriin_cached_role', freshProfile.role);
    } catch (e) {}
    return freshProfile;
  }

  // Fire-and-forget lastLogin
  userDocRef.update({ lastLogin: new Date().toISOString() }).catch(() => {});

  const data = userDoc.data() || {};

  // ── Cache avatar separately (base64 is large, keep profile cache small) ───
  try {
    if (data.photoURL) {
      sessionStorage.setItem(AVATAR_CACHE_KEY(user.uid), data.photoURL);
    } else {
      sessionStorage.removeItem(AVATAR_CACHE_KEY(user.uid));
    }
  } catch (e) {}

  // Strip photoURL from profile data before caching (avoids quota issues)
  const dataWithoutPhoto = { ...data };
  delete dataWithoutPhoto.photoURL;

  const profile = {
    role: normalizeRole(data.role),
    suspended: data.suspended === true,
    data: dataWithoutPhoto
  };

  // ── Store profile in cache ──────────────────────────────────────────
  try {
    sessionStorage.setItem(PROFILE_CACHE_KEY(user.uid), JSON.stringify(profile));
    sessionStorage.setItem(CACHED_UID_KEY, user.uid);
    sessionStorage.setItem('suriin_cached_role', profile.role);
  } catch (e) {}

  return profile;
}

/** Clears the cached profile and avatar — call on logout */
function clearProfileCache(uid) {
  try {
    if (uid) {
      sessionStorage.removeItem(PROFILE_CACHE_KEY(uid));
      sessionStorage.removeItem(AVATAR_CACHE_KEY(uid));
    }
    sessionStorage.removeItem(CACHED_UID_KEY);
    sessionStorage.removeItem('suriin_cached_role');
    sessionStorage.removeItem('suriin_profile_cached');
  } catch (e) {}
}

/**
 * Adapts shared page chrome (header badge + sidebar dashboard link)
 * to the authenticated user's role.
 *
 * Shared pages: settings, help, scam-awareness
 */
function applyRoleAwareSharedNavigation(role) {
  const sharedPages = ['settings', 'help', 'scam-awareness'];
  if (!sharedPages.includes(currentPage)) return;

  const isExpert = role === 'expert';
  const isAdmin = role === 'admin';

  const roleBadge = document.getElementById('header-role-badge');
  if (roleBadge) {
    roleBadge.textContent = isAdmin ? 'Admin Portal' : (isExpert ? 'Expert Portal' : 'User');
    roleBadge.classList.toggle('admin-role-badge', isExpert || isAdmin);
  }

  const dashboardLink = document.getElementById('nav-reports');
  const dashboardText = document.getElementById('nav-reports-text');

  if (dashboardLink) {
    dashboardLink.href = getDashboardPathForRole(role);
  }

  if (dashboardText) {
    dashboardText.textContent = isAdmin ? 'Command Center' : (isExpert ? 'Investigator Portal' : 'My Reports');
  }
}

// ── Instant Layout Reveal for returning users ────────────────────────────────
// Runs synchronously before onAuthStateChanged (which is async).
// Pre-populates the entire navbar (role badge, avatar, nav text) from cache
// so onAuthStateChanged's later DOM mutations are no-ops → no bounce.
(function instantReveal() {
  try {
    if (currentPage === 'privacy' || currentPage === 'login') return;
    const cachedUid = sessionStorage.getItem(CACHED_UID_KEY);
    if (!cachedUid) return;
    const cached = sessionStorage.getItem(PROFILE_CACHE_KEY(cachedUid));
    if (!cached) return;

    const profile = JSON.parse(cached);
    const role = profile.role || 'user';

    const dashWrapper = document.getElementById('dashboard-wrapper');
    const overlay     = document.getElementById('loading-overlay');

    if (dashWrapper) { dashWrapper.style.display = ''; dashWrapper.classList.add('dashboard--revealed'); }
    if (overlay)     overlay.classList.add('hidden');

    // Pre-populate role badge so onAuthStateChanged text change is a no-op
    const roleBadge = document.getElementById('header-role-badge');
    if (roleBadge) {
      const isAdmin = role === 'admin';
      const isExpert = role === 'expert';
      roleBadge.textContent = isAdmin ? 'Admin Portal' : (isExpert ? 'Expert Portal' : 'User');
      roleBadge.classList.toggle('admin-role-badge', isExpert || isAdmin);
    }

    // Pre-populate nav dashboard link text
    const dashboardText = document.getElementById('nav-reports-text');
    if (dashboardText) {
      const isAdmin = role === 'admin';
      const isExpert = role === 'expert';
      dashboardText.textContent = isAdmin ? 'Command Center' : (isExpert ? 'Investigator Portal' : 'My Reports');
    }

    // Pre-populate avatar from dedicated avatar cache (instant, no Firestore)
    const cachedAvatar = sessionStorage.getItem(AVATAR_CACHE_KEY(cachedUid));
    const avatarEl = document.getElementById('user-avatar');
    if (avatarEl && cachedAvatar) {
      avatarEl.innerHTML = `<img src="${cachedAvatar}" alt="Profile photo" style="display:block;width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
    }

    // On settings page: also pre-populate the profile picture avatar instantly
    if (currentPage === 'settings' && cachedAvatar) {
      const picAvatar = document.getElementById('profile-pic-avatar');
      if (picAvatar) {
        picAvatar.innerHTML = `<img src="${cachedAvatar}" alt="Profile photo" style="display:block;width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
      }
      const removeBtn = document.getElementById('remove-profile-pic-btn');
      if (removeBtn) removeBtn.style.display = '';
    }

    console.log('[SuriinAI Auth] Instant reveal applied from cache');
  } catch (e) {}
})();

// ── Auth State Observer ───────────────────────────────────────────────────────
// This fires once on page load and on every auth state change (login/logout).
// Add timeout to prevent infinite loading if Firebase stalls
if (authInstance) {
  authInstance.onAuthStateChanged(async (user) => {
  const overlay = document.getElementById('loading-overlay');

  if (user) {
    // ── User is signed in ──────────────────────────────────────────────
    try {
      // Ensure user document exists in Firestore
      console.log('[SuriinAI Auth] Auth state changed - user signed in:', user.uid);
      const profile = await fetchUserProfile(user);
      const role = profile.role;

      if (profile.suspended) {
        alert('Your account has been suspended. Please contact an administrator.');
        await authInstance.signOut();
        window.location.href = '/';
        return;
      }

      if (currentPage === 'login') {
        // ── CHECK PRIVACY AGREEMENT BEFORE REDIRECTING ──────────────────
        // If privacy hasn't been agreed to, stay on login page to show modal
        const privacyAgreed = localStorage.getItem('privacy_policy_agreed') === 'true';
        
        if (!privacyAgreed) {
          // Don't redirect yet — privacy modal needs to be shown first
          console.log('[SuriinAI Auth] User authenticated but privacy not agreed. Showing privacy modal.');
          // The privacy modal code below will handle showing it
          return;
        }
        
        // Privacy agreed — now safe to redirect to dashboard
        window.location.href = getDashboardPathForRole(role);
        return; // Stop — page will redirect
      }

      // ── Auth guard: ensure user is on the correct dashboard ─────────
      if (isAdminPage && role !== 'admin') {
        window.location.href = getDashboardPathForRole(role);
        return;
      }

      if (isExpertPage && role !== 'expert') {
        window.location.href = getDashboardPathForRole(role);
        return;
      }

      // Admin and expert users should not be on the general user dashboard
      if (currentPage === 'user-dashboard' && (role === 'expert' || role === 'admin')) {
        window.location.href = getDashboardPathForRole(role);
        return;
      }

      // Non-admin users cannot access admin-scoped routes.
      if (isAdminScopedPath && role !== 'admin') {
        window.location.href = getDashboardPathForRole(role);
        return;
      }

      // Keep role dashboards strict by redirecting non-user roles off shared user pages.
      if (role === 'expert' || role === 'admin') {
        const sharedUserOnlyRoutes = ['/settings', '/help', '/scam-awareness'];
        if (sharedUserOnlyRoutes.includes(currentPath)) {
          window.location.href = getDashboardPathForRole(role);
          return;
        }
      }

      // Make shared pages role-aware for navigation + badge content.
      applyRoleAwareSharedNavigation(role);


      // ── Populate user info on dashboard pages ──────────────────────
      populateUserInfo(user);

      // Show the dashboard, hide loading
      const dashWrapper = document.getElementById('dashboard-wrapper');
      if (dashWrapper) { dashWrapper.style.display = ''; dashWrapper.classList.add('dashboard--revealed'); }
      if (overlay) overlay.classList.add('hidden');

      // Expose for dashboard.js
      window.__suriinAuth = { user, role, profile };

      // Store auth data for late-loading scripts
      window.__suriinAuthData = { user, role, profile };
      window.__suriinAuthReady = true;

      // Dispatch a custom event so dashboard.js can start fetching data
      console.log('[SuriinAI Auth] Dispatching suriin:auth-ready event for user:', user.uid, 'role:', role);
      window.dispatchEvent(new CustomEvent('suriin:auth-ready', {
        detail: { user, role, profile }
      }));
      console.log('[SuriinAI Auth] Event dispatched successfully');

      // Push credentials to the Chrome Extension (via content.js relay).
      // content.js listens for this event and forwards to background.js.
      try {
        const idToken = await user.getIdToken();
        window.dispatchEvent(new CustomEvent('suriin:credentials-ready', {
          detail: { uid: user.uid, email: user.email || '', idToken, role }
        }));
      } catch (e) { /* getIdToken failed — extension sync skipped */ }

    } catch (err) {
      console.error('[SuriinAI Auth] Error during authentication:', err);
      console.error('[SuriinAI Auth] Error code:', err.code);
      console.error('[SuriinAI Auth] Error message:', err.message);
      
      // Determine error type and show appropriate message
      let errorMsg = 'An authentication error occurred. ';
      
      if (err.code === 'permission-denied') {
        errorMsg += 'You do not have permission to access this. Contact your administrator.';
        console.error('[SuriinAI Auth] Permission denied - missing Firestore access');
      } else if (err.code === 'failed-precondition') {
        errorMsg += 'Database is not configured properly. Contact support.';
        console.error('[SuriinAI Auth] Database configuration error');
      } else if (err.code === 'unauthenticated') {
        errorMsg += 'Authentication failed. Please try logging in again.';
        console.error('[SuriinAI Auth] User authentication lost');
      } else {
        errorMsg += `${err.message}`;
      }

      // Show error to user on login page, or allow page to load on dashboards
      if (currentPage === 'login') {
        showLoginError(errorMsg);
      } else {
        // On dashboards, still show the page but log the error
        console.warn('[SuriinAI Auth] Allowing page load despite Firestore error:', errorMsg);
      }
      
      // Always populate user info if we have a user
      populateUserInfo(user);
      const dashWrapper = document.getElementById('dashboard-wrapper');
      if (dashWrapper) { dashWrapper.style.display = ''; dashWrapper.classList.add('dashboard--revealed'); }
      if (overlay) overlay.classList.add('hidden');

      // Expose with default role
      window.__suriinAuth = { user, role: 'user', profile: { role: 'user', suspended: false } };
      window.__suriinAuthData = { user, role: 'user', profile: { role: 'user', suspended: false } };
      window.__suriinAuthReady = true;
      applyRoleAwareSharedNavigation('user');
      window.dispatchEvent(new CustomEvent('suriin:auth-ready', {
        detail: { user, role: 'user', profile: { role: 'user', suspended: false } }
      }));
    }
  } else {
    // ── User is NOT signed in ──────────────────────────────────────────
    const publicPages = ['login', 'privacy'];
    const isPublicPage = publicPages.includes(currentPage);

    if (!isPublicPage) {
      // Redirect unauthenticated users away from protected pages
      window.location.href = '/';
      return;
    }

    // Public page rendering, hide loading
    const loginWrapper = document.getElementById('login-wrapper');
    if (loginWrapper) loginWrapper.style.display = '';

    if (overlay) overlay.classList.add('hidden');

    // Dispatch auth-ready with null user so pages (e.g. privacy) can react to logged-out state
    window.__suriinAuth = null;
    window.__suriinAuthData = { user: null };
    window.__suriinAuthReady = true;
    window.dispatchEvent(new CustomEvent('suriin:auth-ready', {
      detail: { user: null }
    }));
  }
  });
}

// ── Privacy Policy Agreement Modal ────────────────────────────────────────────
class PrivacyAgreementModal {
  constructor() {
    this.modal = document.getElementById('privacy-agreement-modal');
    this.backdrop = this.modal?.querySelector('.modal__backdrop');
    this.closeBtn = document.getElementById('privacy-modal-close');
    this.declineBtn = document.getElementById('privacy-decline-btn');
    this.agreeBtn = document.getElementById('privacy-agree-btn');
    this.loginWrapper = document.getElementById('login-wrapper');
    
    // Check if user has already agreed
    this.hasAgreed = localStorage.getItem('privacy_policy_agreed') === 'true';
    
    console.log('[SuriinAI Privacy Modal] Initialized:', {
      modalExists: !!this.modal,
      hasAgreed: this.hasAgreed,
      loginWrapperExists: !!this.loginWrapper,
      elementsFound: {
        backdrop: !!this.backdrop,
        closeBtn: !!this.closeBtn,
        declineBtn: !!this.declineBtn,
        agreeBtn: !!this.agreeBtn
      }
    });
  }

  showIfNeeded() {
    console.log('[SuriinAI Privacy Modal] showIfNeeded() called:', {
      hasAgreed: this.hasAgreed,
      modalExists: !!this.modal,
      loginWrapperExists: !!this.loginWrapper
    });
    
    if (!this.hasAgreed && this.modal) {
      console.log('[SuriinAI Privacy Modal] ✓ Showing privacy modal (not yet agreed)');
      this.show();
      // Hide login/signup forms until privacy is agreed
      if (this.loginWrapper) {
        this.loginWrapper.style.display = 'none';
        console.log('[SuriinAI Privacy Modal] ✓ Hidden login wrapper');
      }
    } else if (this.hasAgreed && this.loginWrapper) {
      // Show login form if already agreed
      console.log('[SuriinAI Privacy Modal] ✓ User already agreed, showing login form');
      this.loginWrapper.style.display = '';
    }
  }

  show() {
    if (this.modal) {
      console.log('[SuriinAI Privacy Modal] ✓ Revealing modal (removing modal--hidden class)');
      this.modal.classList.remove('modal--hidden');
      document.body.style.overflow = 'hidden';
    } else {
      console.error('[SuriinAI Privacy Modal] ✗ Cannot show modal - element not found!');
    }
  }

  hide() {
    if (this.modal) {
      this.modal.classList.add('modal--hidden');
      document.body.style.overflow = '';
    }
  }

  attachListeners() {
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.decline());
    }
    if (this.backdrop) {
      this.backdrop.addEventListener('click', () => this.decline());
    }
    if (this.declineBtn) {
      this.declineBtn.addEventListener('click', () => this.decline());
    }
    if (this.agreeBtn) {
      this.agreeBtn.addEventListener('click', () => this.agree());
    }
  }

  agree() {
    // Save agreement to localStorage
    localStorage.setItem('privacy_policy_agreed', 'true');
    this.hasAgreed = true;
    this.hide();
    
    console.log('[SuriinAI Auth] User agreed to privacy policy');
    
    // Check if user is already authenticated — if so, redirect to dashboard immediately
    // Otherwise, show the login form to let them sign in
    if (authInstance && authInstance.currentUser) {
      console.log('[SuriinAI Auth] User already authenticated, redirecting to dashboard...');
      // Just reload the page — onAuthStateChanged will handle redirect now that privacy is agreed
      window.location.reload();
    } else {
      // Show login form for unauthenticated users
      if (this.loginWrapper) {
        this.loginWrapper.style.display = '';
      }
    }
  }

  decline() {
    // Show message about agreement requirement
    const message = 'You must agree to our Privacy Policy to use Suriin AI. You will be redirected away.';
    alert(message);
    
    // Redirect to safe external page
    window.location.href = 'https://www.google.com/search?q=Google.com';
  }
}

// Initialize and show on page load
console.log('[SuriinAI Auth] Creating privacy modal instance...');
const privacyModal = new PrivacyAgreementModal();

console.log('[SuriinAI Auth] Document readyState:', document.readyState);

if (document.readyState === 'loading') {
  console.log('[SuriinAI Auth] Document still loading, waiting for DOMContentLoaded...');
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[SuriinAI Auth] DOMContentLoaded fired - setting up privacy modal');
    privacyModal.attachListeners();
    privacyModal.showIfNeeded();
  });
} else {
  console.log('[SuriinAI Auth] Document already loaded - setting up privacy modal immediately');
  privacyModal.attachListeners();
  privacyModal.showIfNeeded();
}

// ── Login Form Handler ────────────────────────────────────────────────────────
const loginForm = document.getElementById('login-form');
if (loginForm && authInstance) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const emailInput    = document.getElementById('login-email');
    const passwordInput = document.getElementById('login-password');
    const loginBtn      = document.getElementById('login-btn');
    const errorBox      = document.getElementById('login-error');

    const email    = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showLoginError('Please enter both email and password.');
      return;
    }

    // Clear previous errors
    if (errorBox) {
      errorBox.classList.remove('visible');
      errorBox.textContent = '';
    }

    // Set loading state
    loginBtn.classList.add('loading');
    loginBtn.disabled = true;

    try {
      const credential = await authInstance.signInWithEmailAndPassword(email, password);
      const signedInUser = credential.user;

      // Explicit RBAC routing right after successful sign-in.
      const profile = await fetchUserProfile(signedInUser);
      const role = profile.role;
      const privacyAgreed = localStorage.getItem('privacy_policy_agreed') === 'true';

      if (profile.suspended) {
        alert('Your account has been suspended. Please contact an administrator.');
        await authInstance.signOut();
        return;
      }

      if (privacyAgreed) {
        window.location.href = getDashboardPathForRole(role);
      }

      // If privacy is not yet agreed, onAuthStateChanged keeps user on login so the modal can proceed.
    } catch (err) {
      console.error('[SuriinAI Auth] Login error:', err);
      loginBtn.classList.remove('loading');
      loginBtn.disabled = false;

      // User-friendly error messages
      const errorMessages = {
        'auth/user-not-found':       'No account found with this email address.',
        'auth/wrong-password':       'Incorrect password. Please try again.',
        'auth/invalid-email':        'Please enter a valid email address.',
        'auth/too-many-requests':    'Too many failed attempts. Please try again later.',
        'auth/invalid-credential':   'Invalid email or password. Please try again.',
        'auth/network-request-failed':'Network error. Check your internet connection.',
        'auth/user-disabled':        'This account has been disabled.',
      };

      const code    = err.code || '';
      const message = errorMessages[code] || `Sign-in failed: ${err.message}`;
      showLoginError(message);
    }
  });
}

// ── Forgot Password Modal Controller ───────────────────────────────────────────
class ForgotPasswordModal {
  constructor() {
    this.modal = document.getElementById('forgot-password-modal');
    this.backdrop = document.querySelector('.modal__backdrop');
    this.closeBtn = document.querySelector('.modal__close');
    this.form = document.getElementById('forgot-password-form');
    this.emailInput = document.getElementById('forgot-email');
    this.submitBtn = document.getElementById('forgot-password-submit');
    this.errorBox = document.getElementById('forgot-password-error');
    this.emailError = document.getElementById('forgot-email-error');
    this.step1 = document.getElementById('forgot-password-step-1');
    this.step2 = document.getElementById('forgot-password-step-2');
    this.closeLoginBtn = document.getElementById('forgot-password-close-btn');
    this.retryBtn = document.getElementById('forgot-password-retry-btn');
    this.emailDisplay = document.getElementById('forgot-email-display');
    this.forgotLink = document.getElementById('forgot-password-link');

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Open modal on "Forgot Password?" link click
    if (this.forgotLink) {
      this.forgotLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.open();
      });
    }

    // Close modal on backdrop click
    if (this.backdrop) {
      this.backdrop.addEventListener('click', () => this.close());
    }

    // Close modal on close button (X) click
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.close());
    }

    // Close modal on "Back to Login" button (from success screen)
    if (this.closeLoginBtn) {
      this.closeLoginBtn.addEventListener('click', () => this.close());
    }

    // Retry sending password reset email
    if (this.retryBtn) {
      this.retryBtn.addEventListener('click', () => this.retryPasswordReset());
    }

    // Handle form submission
    if (this.form) {
      this.form.addEventListener('submit', (e) => this.handleSubmit(e));
    }

    // Validate email on input
    if (this.emailInput) {
      this.emailInput.addEventListener('input', () => this.validateEmail());
      this.emailInput.addEventListener('blur', () => this.validateEmail());
    }

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.isModalHidden()) {
        this.close();
      }
    });
  }

  open() {
    if (this.modal) {
      this.modal.classList.remove('modal--hidden');
      this.emailInput?.focus();
    }
  }

  close() {
    if (this.modal) {
      this.modal.classList.add('modal--hidden');
      this.resetToStep1();
    }
  }

  isModalHidden() {
    return this.modal?.classList.contains('modal--hidden') !== false;
  }

  validateEmail() {
    const email = this.emailInput?.value.trim() || '';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!email) {
      this.setEmailError('Please enter your email address.');
      return false;
    }

    if (!emailRegex.test(email)) {
      this.setEmailError('Please enter a valid email address.');
      return false;
    }

    this.clearEmailError();
    return true;
  }

  setEmailError(message) {
    if (this.emailError) {
      this.emailError.textContent = message;
      this.emailError.classList.add('visible');
    }
  }

  clearEmailError() {
    if (this.emailError) {
      this.emailError.textContent = '';
      this.emailError.classList.remove('visible');
    }
  }

  async handleSubmit(e) {
    e.preventDefault();

    // Validate email format
    if (!this.validateEmail()) {
      return;
    }

    const email = this.emailInput.value.trim();

    // Clear previous error
    if (this.errorBox) {
      this.errorBox.classList.remove('visible');
      this.errorBox.textContent = '';
    }

    // Set loading state
    if (this.submitBtn) {
      this.submitBtn.classList.add('loading');
      this.submitBtn.disabled = true;
    }

    try {
      console.log('[SuriinAI Auth] Sending password reset email to:', email);
      
      // Call Firebase password reset
      if (!authInstance) {
        throw new Error('Firebase not initialized');
      }
      
      await authInstance.sendPasswordResetEmail(email);
      console.log('[SuriinAI Auth] Password reset email sent successfully ✅');

      // Store email for display in success message
      if (this.emailDisplay) {
        this.emailDisplay.textContent = email;
      }

      // Show success step
      this.showSuccessStep();
    } catch (err) {
      console.error('[SuriinAI Auth] Forgot password error:', err);

      const errorMessages = {
        'auth/user-not-found':        'No account found with this email address.',
        'auth/invalid-email':         'Please enter a valid email address.',
        'auth/too-many-requests':     'Too many password reset requests. Please try again in a few minutes.',
        'auth/network-request-failed':'Network error. Please check your internet connection and try again.',
        'auth/invalid-credential':    'This email is not associated with any account.',
      };

      const code = err.code || '';
      const message = errorMessages[code] || `Failed to send reset email: ${err.message}`;
      
      if (this.errorBox) {
        this.errorBox.textContent = message;
        this.errorBox.classList.add('visible');
      }
    } finally {
      // Remove loading state
      if (this.submitBtn) {
        this.submitBtn.classList.remove('loading');
        this.submitBtn.disabled = false;
      }
    }
  }

  showSuccessStep() {
    if (this.step1) {
      this.step1.classList.remove('modal__step--active');
    }
    if (this.step2) {
      this.step2.classList.add('modal__step--active');
    }
  }

  resetToStep1() {
    // Clear form
    if (this.emailInput) {
      this.emailInput.value = '';
    }
    this.clearEmailError();
    
    if (this.errorBox) {
      this.errorBox.classList.remove('visible');
      this.errorBox.textContent = '';
    }

    if (this.submitBtn) {
      this.submitBtn.classList.remove('loading');
      this.submitBtn.disabled = false;
    }

    // Show step 1
    if (this.step1) {
      this.step1.classList.add('modal__step--active');
    }
    if (this.step2) {
      this.step2.classList.remove('modal__step--active');
    }
  }

  retryPasswordReset() {
    // Keep the email for quick retry, just clear errors and go back to Step 1
    this.clearEmailError();
    
    if (this.errorBox) {
      this.errorBox.classList.remove('visible');
      this.errorBox.textContent = '';
    }

    if (this.submitBtn) {
      this.submitBtn.classList.remove('loading');
      this.submitBtn.disabled = false;
    }

    // Show step 1 with email pre-filled
    if (this.step1) {
      this.step1.classList.add('modal__step--active');
      this.emailInput?.focus();
    }
    if (this.step2) {
      this.step2.classList.remove('modal__step--active');
    }

    console.log('[SuriinAI Auth] Retrying password reset for:', this.emailInput?.value);
  }
}


// Initialize Forgot Password Modal
function initForgotPasswordModal() {
  // Only initialize on login page and if modal element exists
  if (currentPage === 'login' && document.getElementById('forgot-password-modal')) {
    try {
      new ForgotPasswordModal();
      console.log('[SuriinAI Auth] Forgot password modal initialized successfully');
    } catch (err) {
      console.error('[SuriinAI Auth] Error initializing forgot password modal:', err);
    }
  }
}

// Initialize modal: immediately if DOM is ready, or wait for it
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initForgotPasswordModal);
} else {
  initForgotPasswordModal();
}

// ── Logout Handler ────────────────────────────────────────────────────────────
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn && authInstance) {
  logoutBtn.addEventListener('click', async () => {
    try {
      console.log('[SuriinAI Auth] Logging out...');
      logoutBtn.disabled = true;
      logoutBtn.textContent = 'Signing out...';
      clearProfileCache(authInstance.currentUser?.uid);
      await authInstance.signOut();
      console.log('[SuriinAI Auth] Logout successful ✅');
      // onAuthStateChanged will redirect to login
    } catch (err) {
      console.error('[SuriinAI Auth] Logout error:', err);
      logoutBtn.disabled = false;
      logoutBtn.textContent = 'Sign Out';
      // Show error in console but continue (user may refresh)
    }
  });
}

// ── Auth Mode Switcher ─────────────────────────────────────────────────────────
const authTabs = document.querySelectorAll('.auth-tab');
const authForms = document.querySelectorAll('.auth-form');
const errorBox = document.getElementById('login-error');

authTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    
    // Update tabs
    authTabs.forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-pressed', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-pressed', 'true');
    
    // Update forms
    authForms.forEach(form => form.classList.remove('active'));
    if (mode === 'signin') {
      document.getElementById('login-form').classList.add('active');
    } else {
      document.getElementById('signup-form').classList.add('active');
    }
    
    // Clear any previous errors
    if (errorBox) {
      errorBox.classList.remove('visible');
      errorBox.textContent = '';
    }
  });
});

// ── Password Strength Meter (compact) ────────────────────────────────────────
function checkPasswordPolicy(pw) {
  return {
    length:  pw.length >= 8,
    upper:   /[A-Z]/.test(pw),
    lower:   /[a-z]/.test(pw),
    digit:   /[0-9]/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw)
  };
}

const _PW_REQS = [
  { key: 'upper',   label: 'A–Z' },
  { key: 'lower',   label: 'a–z' },
  { key: 'digit',   label: '0–9' },
  { key: 'special', label: 'symbol' },
  { key: 'length',  label: '8+ chars' }
];

function updatePasswordMeter(pw) {
  const bar     = document.getElementById('password-strength-bar');
  const barWrap = document.getElementById('password-strength-bar-wrap');
  const reqWrap = document.getElementById('pw-requirements');
  const reqInline = document.getElementById('req-inline');
  const reqLabel  = document.getElementById('req-label');

  if (!bar) return;
  const show = pw.length > 0;
  if (barWrap) barWrap.style.display = show ? '' : 'none';
  if (reqWrap) reqWrap.style.display = show ? '' : 'none';
  if (!show) return;

  const p = checkPasswordPolicy(pw);
  const score = Object.values(p).filter(Boolean).length;

  // Bar
  const pct = (score / 5) * 100;
  const clr = score <= 1 ? '#ef4444' : score <= 2 ? '#f59e0b' : score <= 3 ? '#eab308' : score <= 4 ? '#84cc16' : '#22c55e';
  const strengthText = score <= 1 ? 'Very Weak' : score <= 2 ? 'Weak' : score <= 3 ? 'Fair' : score <= 4 ? 'Good' : 'Strong';
  bar.style.width = pct + '%';
  bar.style.background = clr;

  // Compact inline hints
  if (reqLabel) { reqLabel.textContent = strengthText + ':'; reqLabel.style.color = clr; }
  if (reqInline) {
    reqInline.innerHTML = _PW_REQS.map(r => {
      const ok = p[r.key];
      return `<span style="color:${ok ? '#22c55e' : 'var(--clr-text-muted)'};">${ok ? '✓' : '✗'} ${r.label}</span>`;
    }).join('<span style="margin:0 3px;opacity:0.4;">·</span>');
  }
}

(function initPasswordMeter() {
  const pwInput   = document.getElementById('signup-password');
  const cfmInput  = document.getElementById('signup-password-confirm');
  const cfmErr    = document.getElementById('signup-confirm-error');
  const togglePw  = document.getElementById('toggle-signup-password');
  const toggleCfm = document.getElementById('toggle-signup-confirm');

  if (pwInput) {
    pwInput.addEventListener('input', () => {
      updatePasswordMeter(pwInput.value);
      clearFieldError('signup-password', 'error-password');
    });
  }
  if (cfmInput && pwInput && cfmErr) {
    cfmInput.addEventListener('input', () => {
      if (cfmInput.value && cfmInput.value !== pwInput.value) {
        cfmErr.textContent = 'Passwords do not match.';
        cfmErr.style.display = '';
      } else {
        cfmErr.textContent = '';
        cfmErr.style.display = 'none';
      }
    });
  }
  if (togglePw && pwInput) {
    togglePw.addEventListener('click', () => { pwInput.type = pwInput.type === 'password' ? 'text' : 'password'; });
  }
  if (toggleCfm && cfmInput) {
    toggleCfm.addEventListener('click', () => { cfmInput.type = cfmInput.type === 'password' ? 'text' : 'password'; });
  }

  const phoneInput = document.getElementById('signup-phone');
  if (phoneInput) {
    phoneInput.addEventListener('input', () => {
      const cleaned = phoneInput.value.replace(/[^0-9+\s\-]/g, '');
      if (phoneInput.value !== cleaned) {
        const pos = phoneInput.selectionStart - (phoneInput.value.length - cleaned.length);
        phoneInput.value = cleaned;
        try { phoneInput.setSelectionRange(pos, pos); } catch { }
      }
    });
  }
})();

// ── Per-field error helpers ───────────────────────────────────────────────────
function setFieldError(inputId, errorId, msg) {
  const input = document.getElementById(inputId);
  const errEl = document.getElementById(errorId);
  if (input) input.classList.add('input--error');
  if (errEl) { errEl.textContent = msg; errEl.style.display = ''; }
}

function clearFieldError(inputId, errorId) {
  const input = document.getElementById(inputId);
  const errEl = document.getElementById(errorId);
  if (input) input.classList.remove('input--error');
  if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
}

function clearAllSignupErrors() {
  [['signup-first-name','error-first-name'],['signup-last-name','error-last-name'],
   ['signup-email','error-email'],['signup-phone','error-phone'],
   ['signup-password','error-password'],['signup-password-confirm','signup-confirm-error']
  ].forEach(([id, eid]) => clearFieldError(id, eid));
}

// Clear errors on input
['signup-first-name','signup-last-name','signup-email'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => clearFieldError(id, 'error-' + id.replace('signup-', '')));
});

// ── Sign Up Form Handler ───────────────────────────────────────────────────────
const signupForm = document.getElementById('signup-form');
if (signupForm && authInstance) {
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const firstNameInput  = document.getElementById('signup-first-name');
    const lastNameInput   = document.getElementById('signup-last-name');
    const emailInput      = document.getElementById('signup-email');
    const phoneInput      = document.getElementById('signup-phone');
    const passwordInput   = document.getElementById('signup-password');
    const confirmInput    = document.getElementById('signup-password-confirm');
    const signupBtn       = document.getElementById('signup-btn');
    const errorBox        = document.getElementById('login-error');

    const firstName = (firstNameInput?.value || '').trim();
    const lastName  = (lastNameInput?.value  || '').trim();
    const email     = emailInput.value.trim();
    const phone     = (phoneInput?.value || '').trim();
    const password  = passwordInput.value;
    const confirmPassword = confirmInput.value;

    const displayName = `${firstName} ${lastName}`.trim();

    // Per-field validation
    clearAllSignupErrors();
    let hasError = false;

    if (!firstName) { setFieldError('signup-first-name', 'error-first-name', 'First name is required.'); hasError = true; }
    if (!lastName)  { setFieldError('signup-last-name',  'error-last-name',  'Last name is required.');  hasError = true; }
    if (!email)     { setFieldError('signup-email', 'error-email', 'Email address is required.'); hasError = true; }
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setFieldError('signup-email', 'error-email', 'Enter a valid email address.'); hasError = true; }

    if (phone) {
      const cleanPhone = phone.replace(/[\s\-\+]/g, '');
      if (!/^\d{7,15}$/.test(cleanPhone)) { setFieldError('signup-phone', 'error-phone', 'Enter a valid phone number (digits only, 7–15 digits).'); hasError = true; }
    }

    if (!password) { setFieldError('signup-password', 'error-password', 'Password is required.'); hasError = true; }
    else {
      const policy = checkPasswordPolicy(password);
      if (!Object.values(policy).every(Boolean)) {
        setFieldError('signup-password', 'error-password', 'Password must be 8+ chars with A–Z, a–z, 0–9 and a symbol.');
        hasError = true;
      }
    }

    if (!confirmPassword) {
      const cfmErr = document.getElementById('signup-confirm-error');
      const cfmInput = document.getElementById('signup-password-confirm');
      if (cfmInput) cfmInput.classList.add('input--error');
      if (cfmErr) { cfmErr.textContent = 'Please confirm your password.'; cfmErr.style.display = ''; }
      hasError = true;
    } else if (password !== confirmPassword) {
      const cfmErr = document.getElementById('signup-confirm-error');
      const cfmInput = document.getElementById('signup-password-confirm');
      if (cfmInput) cfmInput.classList.add('input--error');
      if (cfmErr) { cfmErr.textContent = 'Passwords do not match.'; cfmErr.style.display = ''; }
      hasError = true;
    }

    if (hasError) return;

    // Set loading state
    signupBtn.classList.add('loading');
    signupBtn.disabled = true;
    errorBox.classList.remove('visible');

    try {
      console.log('[SuriinAI Auth] Creating new user account...');
      const userCredential = await authInstance.createUserWithEmailAndPassword(email, password);
      const user = userCredential.user;

      await user.updateProfile({ displayName });

      const userDoc = {
        email,
        displayName,
        firstName,
        lastName,
        role: 'user',
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      };
      if (phone) userDoc.phone = phone;

      await dbInstance.collection('Users').doc(user.uid).set(userDoc);

      console.log('[SuriinAI Auth] User account created successfully ✅');
    } catch (err) {
      console.error('[SuriinAI Auth] Sign-up error:', err);
      signupBtn.classList.remove('loading');
      signupBtn.disabled = false;

      const errorMessages = {
        'auth/email-already-in-use':    'This email is already registered. Try logging in instead.',
        'auth/invalid-email':           'Please enter a valid email address.',
        'auth/weak-password':           'Password is too weak. Please use a stronger password.',
        'auth/network-request-failed':  'Network error. Check your internet connection and try again.',
        'auth/too-many-requests':       'Too many requests. Please try again later.',
        'auth/operation-not-allowed':   'Account creation is temporarily disabled.',
      };

      showLoginError(errorMessages[err.code] || `Sign-up failed: ${err.message}`);
    }
  });
}

// ── Initialize Google Sign-In Button (After Firebase Ready) ─────────────────
function setupGoogleSignIn() {
  // Only setup on login page
  if (currentPage !== 'login') {
    console.log('[SuriinAI Auth] Not on login page, skipping Google button setup');
    return;
  }

  const googleSigninBtn = document.getElementById('google-signin-btn');
  
  if (!googleSigninBtn) {
    console.warn('[SuriinAI Auth] Google sign-in button not found on login page, retrying...');
    setTimeout(setupGoogleSignIn, 500);
    return;
  }
  
  if (!authInstance || !dbInstance) {
    console.warn('[SuriinAI Auth] Firebase not initialized yet, retrying...');
    setTimeout(setupGoogleSignIn, 500);
    return;
  }

  // Prevent duplicate listeners
  if (googleSigninBtn.dataset.setupDone === 'true') {
    console.log('[SuriinAI Auth] Google button already set up');
    return;
  }
  googleSigninBtn.dataset.setupDone = 'true';

  googleSigninBtn.addEventListener('click', async () => {
    try {
      console.log('[SuriinAI Auth] Starting Google sign-in...');
      
      // Show loading state
      googleSigninBtn.classList.add('loading');
      googleSigninBtn.disabled = true;
      
      const provider = new firebase.auth.GoogleAuthProvider();
      await authInstance.signInWithPopup(provider);
      console.log('[SuriinAI Auth] Google sign-in completed - onAuthStateChanged will handle the rest');
      // onAuthStateChanged will handle the Firestore write and redirect
    } catch (err) {
      console.error('[SuriinAI Auth] Google sign-in error:', err);
      console.error('[SuriinAI Auth] Error code:', err.code);
      console.error('[SuriinAI Auth] Error message:', err.message);

      // Remove loading state on error
      googleSigninBtn.classList.remove('loading');
      googleSigninBtn.disabled = false;

      // Handle different error scenarios
      const errorMessages = {
        'auth/popup-closed-by-user': 'Sign-in was cancelled. Please try again.',
        'auth/popup-blocked': 'The sign-in popup was blocked. Please check your browser settings.',
        'auth/cancelled-popup-request': 'The sign-in popup was cancelled.',
        'auth/unauthorized-domain': 'This domain is not authorized for Google sign-in. Check Firebase settings.',
        'auth/network-request-failed': 'Network error. Please check your internet connection and try again.',
        'auth/operation-not-allowed': 'Google sign-in is not enabled. Contact support.',
      };

      const userFriendlyMsg = errorMessages[err.code];
      const message = userFriendlyMsg || `Sign-in failed: ${err.message}`;
      
      showLoginError(message);
      console.error('[SuriinAI Auth] User-facing error:', message);
    }
  });
  
  console.log('[SuriinAI Auth] Google sign-in button initialized successfully');
}

// Setup Google button once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupGoogleSignIn);
} else {
  setupGoogleSignIn();
}


// ── Helper Functions ──────────────────────────────────────────────────────────

function showLoginError(message) {
  const errorBox = document.getElementById('login-error');
  if (errorBox) {
    errorBox.textContent = message;
    errorBox.classList.add('visible');
    // Re-trigger animation
    errorBox.style.animation = 'none';
    errorBox.offsetHeight; // Force reflow
    errorBox.style.animation = '';
  }
}

function populateUserInfo(user) {
  // ── Email: hide from permanent navbar (now lives only in dropdown) ─────────
  const emailEl = document.getElementById('user-email');
  if (emailEl) emailEl.style.display = 'none';

  const avatarEl        = document.getElementById('user-avatar');
  const avatarMenu      = document.getElementById('avatar-menu');
  const avatarDropdown  = document.getElementById('avatar-dropdown');
  const userInfoSlot    = document.getElementById('avatar-dropdown-user-info');
  const avatarLogoutBtn = document.getElementById('avatar-logout-btn');

  // ── Populate user-info slot inside dropdown ───────────────────────────────
  if (userInfoSlot) {
    const displayName = user.displayName || user.email.split('@')[0] || 'User';
    userInfoSlot.innerHTML = `
      <div class="avatar-dropdown__name">${displayName}</div>
      <div class="avatar-dropdown__email">${user.email || ''}</div>
    `;
  }

  // ── Avatar: render photo or initials ─────────────────────────────────────
  function renderAvatar(photoURL) {
    if (!avatarEl) return;
    if (photoURL) {
      avatarEl.innerHTML = `<img src="${photoURL}" alt="Profile photo">`;
    } else {
      const initials = (user.displayName || user.email || 'U')
        .split('@')[0].substring(0, 2).toUpperCase();
      avatarEl.textContent = initials;
    }
  }

  // Read photoURL: try dedicated avatar cache first (instant), then Firestore
  const cachedAvatar = (() => {
    try { return sessionStorage.getItem(AVATAR_CACHE_KEY(user.uid)) || null; }
    catch (e) { return null; }
  })();

  if (cachedAvatar) {
    renderAvatar(cachedAvatar);
  } else {
    // Show initials immediately so the avatar is never empty (prevents layout reflow)
    renderAvatar(null);
    // Then fetch photo from Firestore and swap in when ready
    const db = window.__suriinFirestore;
    if (db) {
      db.collection('Users').doc(user.uid).get()
        .then((doc) => {
          const firestorePhoto = doc.exists ? doc.data().photoURL : null;
          if (firestorePhoto) {
            try { sessionStorage.setItem(AVATAR_CACHE_KEY(user.uid), firestorePhoto); } catch (e) {}
            renderAvatar(firestorePhoto);
          }
        })
        .catch(() => {});
    }
  }

  // ── Avatar dropdown toggle ─────────────────────────────────────────────────
  if (avatarEl && avatarDropdown && !avatarEl.dataset.dropdownInit) {
    avatarEl.dataset.dropdownInit = 'true';

    avatarEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = avatarDropdown.style.display !== 'none';
      // Close notification dropdown if open (mutual exclusion)
      if (!isOpen) {
        const notifDropdown = document.getElementById('notification-dropdown');
        if (notifDropdown) notifDropdown.style.display = 'none';
      }
      avatarDropdown.style.display = isOpen ? 'none' : 'block';
      avatarEl.setAttribute('aria-expanded', String(!isOpen));
    });

    document.addEventListener('click', (e) => {
      if (avatarMenu && !avatarMenu.contains(e.target)) {
        avatarDropdown.style.display = 'none';
        if (avatarEl) avatarEl.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        avatarDropdown.style.display = 'none';
        if (avatarEl) avatarEl.setAttribute('aria-expanded', 'false');
      }
    });
  }

  if (avatarLogoutBtn && authInstance && !avatarLogoutBtn.dataset.logoutInit) {
    avatarLogoutBtn.dataset.logoutInit = 'true';
    avatarLogoutBtn.addEventListener('click', async () => {
      try {
        clearProfileCache(authInstance.currentUser?.uid);
        await authInstance.signOut();
      } catch (err) {
        console.error('[SuriinAI Auth] Logout error:', err);
      }
    });
  }
}

/**
 * Utility: Get the current user's Firebase ID token.
 * Used by dashboard.js when calling protected API endpoints.
 * @returns {Promise<string>}
 */
async function getIdToken() {
  const user = authInstance.currentUser;
  if (!user) throw new Error('Not authenticated');
  return user.getIdToken();
}

// Expose for dashboard.js
window.__suriinGetIdToken = getIdToken;
