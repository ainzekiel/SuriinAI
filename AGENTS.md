# Suriin AI project guidance

Flask templates live in web-application/templates. Shared theme tokens live in web-application/static/css/style.css. Authentication uses static/js/auth.js and supabase-runtime.js.

For auth layouts, read .agents/skills/suriin-auth-layout/SKILL.md. For UI verification, read .agents/skills/suriin-auth-review/SKILL.md.

Preserve existing form IDs and runtime bindings. Scope auth styles so dashboards and password recovery remain unaffected. Preserve unrelated checkout changes. Stage only task changes and report checks actually performed.
