---
name: suriin-auth-layout
description: Improve Suriin AI login and signup layouts using its dark purple theme and Flask authentication markup.
---
# Authentication layout
Read templates/index.html, login styles in static/css/style.css, and the mode switcher in static/js/auth.js under web-application before editing.
Use a brand column beside the form on wide screens and stack on mobile. Allow scrolling on short screens and support 320px widths. Reuse existing theme tokens.
Keep input IDs, validation messages, password strength elements, Google sign-in, reset-password, and privacy dialog bindings intact. Scope new CSS to the auth page because password recovery shares login classes. Prefer CSS and SVG to new image dependencies. Avoid unsupported accuracy claims.
