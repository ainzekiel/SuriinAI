/**
 * auth.js — Suriin AI Authentication & Session Management
 * ═══════════════════════════════════════════════════════════════════════════
 * Handles:
 *   1. Firebase Client SDK initialization
 *   2. Email/password sign-in on the login page
 *   3. Auth state persistence (onAuthStateChanged)
 *   4. Role-based redirection (general → user-dashboard, expert → admin-dashboard)
 *   5. Auth guard on dashboard pages (redirect to login if unauthenticated)
 *   6. Logout functionality
 *   7. Privacy Policy Agreement Modal (with localStorage & reset support)
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
  if (path.includes('admin-dashboard'))                return 'admin-dashboard';
  if (path.includes('scam-awareness'))                 return 'scam-awareness';
  if (path.includes('settings'))                       return 'settings';
  if (path.includes('privacy'))                        return 'privacy';
  if (path.includes('help'))                           return 'help';
  return 'unknown';
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
      const userDocRef = dbInstance.collection('Users').doc(user.uid);
      const userDocSnap = await userDocRef.get();

      if (!userDocSnap.exists) {
        // New user (first time signing in) — create profile in Firestore
        console.log('[SuriinAI Auth] New user detected - creating profile in Firestore...');
        await userDocRef.set({
          email: user.email,
          displayName: user.displayName || 'User',
          role: 'general',
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString()
        });
        console.log('[SuriinAI Auth] User profile created successfully in Firestore');
      } else {
        // Existing user — update last login
        console.log('[SuriinAI Auth] Existing user - updating last login...');
        await userDocRef.update({
          lastLogin: new Date().toISOString()
        });
        console.log('[SuriinAI Auth] Last login updated');
      }

      // Fetch role from Firestore Users collection
      const userDoc = await userDocRef.get();
      const role    = userDoc.exists ? userDoc.data().role : 'general';

      if (currentPage === 'login') {
        // Redirect to the correct dashboard
        if (role === 'expert') {
          window.location.href = '/admin-dashboard';
        } else {
          window.location.href = '/user-dashboard';
        }
        return; // Stop — page will redirect
      }

      // ── Auth guard: ensure user is on the correct dashboard ─────────
      if (currentPage === 'admin-dashboard' && role !== 'expert') {
        window.location.href = '/user-dashboard';
        return;
      }

      // ── Populate user info on dashboard pages ──────────────────────
      populateUserInfo(user);

      // Show the dashboard, hide loading
      const dashWrapper = document.getElementById('dashboard-wrapper');
      if (dashWrapper) dashWrapper.style.display = '';
      if (overlay) overlay.classList.add('hidden');

      // Expose for dashboard.js
      window.__suriinAuth = { user, role };

      // Dispatch a custom event so dashboard.js can start fetching data
      window.dispatchEvent(new CustomEvent('suriin:auth-ready', {
        detail: { user, role }
      }));

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
      if (dashWrapper) dashWrapper.style.display = '';
      if (overlay) overlay.classList.add('hidden');

      // Expose with default role
      window.__suriinAuth = { user, role: 'general' };
      window.dispatchEvent(new CustomEvent('suriin:auth-ready', {
        detail: { user, role: 'general' }
      }));
    }
  } else {
    // ── User is NOT signed in ──────────────────────────────────────────
    if (currentPage !== 'login') {
      // Redirect to login
      window.location.href = '/';
      return;
    }

    // Show the login form, hide loading
    const loginWrapper = document.getElementById('login-wrapper');
    if (loginWrapper) loginWrapper.style.display = '';
    if (overlay) overlay.classList.add('hidden');
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
    
    // Check for reset parameter (?reset-privacy=1 to test modal)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('reset-privacy')) {
      console.log('[SuriinAI Privacy] 🔄 Reset parameter detected - clearing localStorage');
      localStorage.removeItem('privacy_policy_agreed');
      // Remove param from URL so it doesn't persist
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    // Check if user has already agreed
    this.hasAgreed = localStorage.getItem('privacy_policy_agreed') === 'true';
    
    // Debug logging
    console.log('[SuriinAI Privacy] ═══════════════════════════════════════════════════════════');
    console.log('[SuriinAI Privacy] Privacy Modal Initialization');
    console.log('[SuriinAI Privacy] Modal element found:', !!this.modal ? '✓' : '✗');
    console.log('[SuriinAI Privacy] localStorage value:', localStorage.getItem('privacy_policy_agreed'));
    console.log('[SuriinAI Privacy] hasAgreed (boolean):', this.hasAgreed);
    console.log('[SuriinAI Privacy] ═══════════════════════════════════════════════════════════');
    if (!this.hasAgreed) {
      console.log('[SuriinAI Privacy] ✓ Privacy modal WILL be shown on page load');
    } else {
      console.log('[SuriinAI Privacy] ⊘ Privacy modal WILL NOT be shown (previously agreed)');
      console.log('[SuriinAI Privacy] ℹ️ To reset for testing, use one of these methods:');
      console.log('[SuriinAI Privacy]    1. Visit: http://127.0.0.1:5000?reset-privacy=1');
      console.log('[SuriinAI Privacy]    2. Run in console: localStorage.removeItem("privacy_policy_agreed"); location.reload();');
    }
  }

  showIfNeeded() {
    if (!this.hasAgreed && this.modal) {
      console.log('[SuriinAI Privacy] ✓ Showing privacy modal now');
      this.show();
      // Hide login/signup forms until privacy is agreed
      if (this.loginWrapper) {
        this.loginWrapper.style.display = 'none';
      }
    } else if (this.hasAgreed && this.loginWrapper) {
      // Show login form if already agreed
      console.log('[SuriinAI Privacy] ✓ User already agreed - showing login form');
      this.loginWrapper.style.display = '';
    }
  }

  show() {
    if (this.modal) {
      this.modal.classList.remove('modal--hidden');
      document.body.style.overflow = 'hidden';
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
    
    // Show login form now that privacy is agreed
    if (this.loginWrapper) {
      this.loginWrapper.style.display = '';
    }
    
    console.log('[SuriinAI Auth] ✓ User agreed to privacy policy');
  }

  decline() {
    // Show message about agreement requirement
    const message = 'You must agree to our Privacy Policy to use Suriin AI. You will be redirected away.';
    alert(message);
    
    // Redirect to safe external page
    console.log('[SuriinAI Auth] User declined privacy policy - redirecting to Google');
    window.location.href = 'https://www.google.com/search?q=Google.com';
  }
}

// Initialize and show on page load
const privacyModal = new PrivacyAgreementModal();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    privacyModal.attachListeners();
    privacyModal.showIfNeeded();
  });
} else {
  privacyModal.attachListeners();
  privacyModal.showIfNeeded();
}

// ── Login Form Handler ────────────────────────────────────────────────────────
