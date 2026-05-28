// ── Privacy Policy Agreement Modal (UPDATED) ─────────────────────────────────────
// This replaces the PrivacyAgreementModal class and initialization in auth.js

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
      console.log('[SuriinAI Privacy] Reset parameter detected - clearing localStorage');
      localStorage.removeItem('privacy_policy_agreed');
      // Also update the URL to remove the param so it doesn't cause issues
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    // Check if user has already agreed
    this.hasAgreed = localStorage.getItem('privacy_policy_agreed') === 'true';
    
    // Debug logging
    console.log('[SuriinAI Privacy] ═══════════════════════════════════════════');
    console.log('[SuriinAI Privacy] Modal element found:', !!this.modal);
    console.log('[SuriinAI Privacy] localStorage "privacy_policy_agreed":', localStorage.getItem('privacy_policy_agreed'));
    console.log('[SuriinAI Privacy] hasAgreed:', this.hasAgreed);
    console.log('[SuriinAI Privacy] ═══════════════════════════════════════════');
    if (!this.hasAgreed) {
      console.log('[SuriinAI Privacy] ✓ Privacy modal WILL be shown');
    } else {
      console.log('[SuriinAI Privacy] ⊘ Privacy modal WILL NOT be shown (already agreed)');
      console.log('[SuriinAI Privacy] To reset: localStorage.removeItem("privacy_policy_agreed"); location.reload();');
      console.log('[SuriinAI Privacy] Or visit with: ?reset-privacy=1');
    }
  }

  showIfNeeded() {
    if (!this.hasAgreed && this.modal) {
      console.log('[SuriinAI Privacy] Showing privacy modal...');
      this.show();
      // Hide login/signup forms until privacy is agreed
      if (this.loginWrapper) {
        this.loginWrapper.style.display = 'none';
      }
    } else if (this.hasAgreed && this.loginWrapper) {
      // Show login form if already agreed
      console.log('[SuriinAI Privacy] User already agreed, showing login form');
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
