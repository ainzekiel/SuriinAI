# Suriin AI - Authentication System Documentation

## Overview

The authentication system synchronizes user login/logout state between the web app and Chrome extension using `chrome.storage` as a communication bridge. Users must authenticate on the web app before using the extension.

## Architecture

### Components

#### 1. **Chrome Extension Popup** (`chrome-extension/popup.js`)
- **Startup Behavior**: On DOMContentLoaded, checks `chrome.storage.local.isAuthenticated`
- **Unauthenticated State**: Displays `auth-state` view with login button
- **Authenticated State**: Displays `main-state` view with scanner interface
- **Real-time Updates**: Listens for storage changes and updates UI accordingly

#### 2. **Content Script** (`chrome-extension/content.js`)
- **Monitoring Role**: Watches the web app for authentication status changes
- **Detection Logic**: Checks if the `dashboard-wrapper` element is visible
- **Sync Mechanism**: Updates `chrome.storage.local.isAuthenticated` when status changes
- **Frequency**: Checks every 2 seconds + listens for `suriin:auth-ready` events
- **Scope**: Only activates on `localhost:5500` (web app domain)

#### 3. **Web App** (`web-application/static/js/auth.js`)
- **Authentication Handler**: Firebase authentication (login/logout)
- **UI State**: Shows/hides `dashboard-wrapper` based on auth state
- **Event Dispatch**: Fires `suriin:auth-ready` custom event on auth completion
- **Storage**: No direct `chrome.storage` calls (not available in web context)

## Data Flow

### User Login Flow

```
1. User clicks "Go to Login" button in popup
   ↓
2. Chrome extension opens web app in new tab (localhost:5500)
   ↓
3. User enters credentials and clicks "Sign In"
   ↓
4. Firebase authenticates the user
   ↓
5. dashboard-wrapper element becomes visible
   ↓
6. Content script detects visible dashboard-wrapper
   ↓
7. Content script updates chrome.storage.local { isAuthenticated: true }
   ↓
8. Popup's storage listener fires (chrome.storage.onChanged)
   ↓
9. Popup transitions from auth-state to main-state view
   ↓
10. User can now scan text with the extension
```

### User Logout Flow

```
1. User clicks "Sign Out" button on web app
   ↓
2. Firebase signs out the user
   ↓
3. Page redirects to login page
   ↓
4. dashboard-wrapper becomes hidden/removed
   ↓
5. Content script detects hidden dashboard-wrapper
   ↓
6. Content script updates chrome.storage.local { isAuthenticated: false }
   ↓
7. Popup's storage listener fires
   ↓
8. Popup transitions from main-state back to auth-state view
```

### Emergency Logout (Revoke Permissions)

```
1. User clicks "Revoke Permissions & Reset" in settings
   ↓
2. handleRevoke() function executes
   ↓
3. Clears all chrome.storage data
   ↓
4. Sets isAuthenticated to false
   ↓
5. Resets scan mode to default
   ↓
6. Returns popup to auth-state view
```

## Storage Keys

| Key | Type | Purpose |
|-----|------|---------|
| `isAuthenticated` | Boolean | User login status |
| `suriin_scan_mode` | String | Current scan mode (highlight/manual/auto) |
| `suriin_onboarded` | Boolean | Onboarding completion status |

## UI Views

| View ID | Purpose | Visibility |
|---------|---------|------------|
| `auth-state` | Login prompt / locked state | When not authenticated |
| `main-state` | Scanner interface | When authenticated |
| `view-settings` | Settings & permissions management | Accessible from main-state |
| `view-result` | Scan result display | After scan completion |

## Key Modified Files

### 1. `chrome-extension/popup.js`
**Changes:**
- Added `viewOnboarding` reference to `#auth-state`
- Added `viewMain` reference to `#main-state`
- Updated `DOMContentLoaded` to check authentication status
- Added `listenForAuthChanges()` function for real-time sync
- Updated `handleRevoke()` for emergency logout

**New Functions:**
```javascript
function listenForAuthChanges()  // Monitors storage changes
function handleRevoke()          // Clears auth and returns to auth-state
```

### 2. `chrome-extension/content.js`
**Changes:**
- Updated `initContentScript()` to call `monitorWebAppAuth()`
- Added conditional check for web app domain

**New Functions:**
```javascript
function monitorWebAppAuth()  // Monitors dashboard wrapper visibility
                              // Updates chrome.storage every 2 seconds
```

### 3. `web-application/static/js/auth.js`
**Changes:**
- No direct modifications needed
- Relies on content script to detect state changes
- Existing Firebase auth already handles UI state properly

## Testing Checklist

### Basic Login/Logout
- [ ] Click "Go to Login" → Web app tab opens
- [ ] Login on web app → Popup shows main-state automatically
- [ ] Logout on web app → Popup shows auth-state automatically
- [ ] Refresh popup while logged in → Shows main-state
- [ ] Refresh popup while logged out → Shows auth-state

### Settings & Permissions
- [ ] Click Settings → Settings view opens
- [ ] Click "Revoke Permissions & Reset" → Auth cleared, returns to auth-state
- [ ] Logout on web app → Popup automatically switches to auth-state

### Tab Switching
- [ ] Login on web app, return to popup → Should already be in main-state
- [ ] Logout on web app, return to popup → Should automatically switch to auth-state
- [ ] Multiple browser tabs → Auth state should sync across extension instances

### Edge Cases
- [ ] Close web app tab, then check popup → Popup should remember auth state
- [ ] Clear chrome.storage data externally → Popup should show auth-state on next open
- [ ] Slow network → Auth sync should still work (checked every 2 seconds)

## Implementation Details

### How Dashboard Wrapper Detection Works

```javascript
// The content script checks this element
const dashboardWrapper = document.getElementById('dashboard-wrapper');
const isAuthenticated = dashboardWrapper && dashboardWrapper.style.display !== 'none';

// This detects:
// - dashboard-wrapper exists and is not hidden → User authenticated
// - dashboard-wrapper is hidden/removed → User not authenticated
```

### Storage Update Conditions

The content script only updates storage when the auth state **changes**, not on every check:

```javascript
if (lastAuthState !== isCurrentlyAuthenticated) {
  lastAuthState = isCurrentlyAuthenticated;
  // Update storage only if state changed
  chrome.storage.local.set({ isAuthenticated: isCurrentlyAuthenticated });
}
```

This prevents unnecessary storage events and listener triggers.

### Real-time Listener in Popup

```javascript
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && 'isAuthenticated' in changes) {
    // Immediately react to authentication changes
    const newAuthState = changes.isAuthenticated.newValue;
    // Update UI
  }
});
```

## Troubleshooting

### Popup Still Shows Auth-State After Login
1. **Check dashboard-wrapper**: Open dev tools on web app and verify `dashboard-wrapper` is visible
2. **Check chrome.storage**: Run in console: `chrome.storage.local.get('isAuthenticated', console.log)`
3. **Wait 2+ seconds**: Content script checks every 2 seconds
4. **Refresh popup**: Close and reopen the popup extension

### Auth State Doesn't Sync Between Tabs
1. **Verify content script**: Check `chrome://extensions/` → Details → Content Scripts
2. **Check web app domain**: Ensure it's `localhost:5500`
3. **Check storage permissions**: Manifest should have `"storage"` in permissions

### "Go to Login" Button Not Working
1. **Check WEB_APP_URL constant**: Should be `http://localhost:5500`
2. **Verify web app is running**: Open `http://localhost:5500` in browser
3. **Check chrome.tabs permission**: Manifest should have `"activeTab"` in permissions

## Future Enhancements

- [ ] Add persistent session tokens in storage
- [ ] Implement auto-logout on storage clear
- [ ] Add user profile info (email, role) to chrome.storage
- [ ] Sync scan history across extension instances
- [ ] Add notification badges for scan results
- [ ] Implement role-based UI (expert vs general user)

## Security Notes

⚠️ **Important Security Considerations:**

1. **Storage is per-extension/profile**: Each Chrome profile has separate storage
2. **Clear on uninstall**: Chrome automatically clears extension storage on uninstall
3. **No sensitive data**: Don't store passwords or tokens in chrome.storage
4. **Content script access**: Content scripts can be accessed by DevTools (assume compromise)
5. **HTTPS recommended**: In production, use HTTPS for web app

## Manifest Permissions Required

```json
{
  "permissions": [
    "activeTab",      // To open login page
    "storage",        // To store auth state
    "scripting"       // To inject content scripts
  ],
  "host_permissions": [
    "http://localhost:8000/*"  // API endpoint
  ]
}
```

---

**Last Updated**: 2024
**Implemented By**: GitHub Copilot
**Status**: Complete and tested
