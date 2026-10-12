---
name: suriin-auth-review
description: Verify Suriin AI authentication presentation and mode switching after UI changes without creating real accounts.
---
# Authentication UI review
Inspect sign-in and signup at desktop and mobile widths. Check overflow, labels, keyboard focus, password toggle spacing, loading/error states, and reset-password dialog. Confirm mode buttons expose selected state and only the selected form is visible.
Preserve Supabase session, role redirect, consent, and validation behavior. Use isolated browser stubs when credentials are unavailable and distinguish UI checks from backend authentication. Do not create accounts or send reset emails for layout checks. Record observed results and limitations.
