# Authentication layout assignment

The supplied PDF's assignment was adapted to Suriin AI. Embedded sample prompts were treated as reference content.

- Branch: `codex/auth-column-layout` (local; GitHub publication was blocked by automatic approval review).
- Project instructions: `AGENTS.md`.
- Custom skills, read and applied: `.agents/skills/suriin-auth-layout/SKILL.md` and `.agents/skills/suriin-auth-review/SKILL.md`.
- Provider skills: existing OpenAI PDF skill used to extract all nine pages and render the reference; OpenAI skill-creator used for custom skill creation. Both were already installed.
- Auth page: responsive brand/form columns, an illustrative scan panel, mobile stacking, accessible selected mode buttons, and existing theme tokens. Auth-only CSS lives in `web-application/static/css/auth-layout.css`.

Headless Edge verified both modes at 1440, 768, 390, and 320 pixels: selected form visible, button state correct, no horizontal overflow. Desktop and mobile screenshots were reviewed. JavaScript syntax check passed. UI checks used the real template/CSS and actual mode-switcher code in an isolated preview. Real Supabase login, OAuth, account creation, and reset emails were not exercised.

The skill validator could not run because PyYAML is missing; skill frontmatter and instructions were manually reviewed. Existing unrelated checkout changes were preserved. Changes remain uncommitted.
