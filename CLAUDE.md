# MacroLens — Project Context for Claude

## Live URLs
- **Web app:** https://personal-health-tracking.vercel.app
- **GitHub:** https://github.com/samgrimes8-ui/personal-health-tracking

## Infrastructure
- **Supabase project:** rwrcklqpvfvuvwatpbxh
- **Supabase URL:** https://rwrcklqpvfvuvwatpbxh.supabase.co
- **Supabase PAT:** (in Vercel env vars as SUPABASE_PAT)
- **Anthropic API key:** (in Vercel env vars as ANTHROPIC_API_KEY)
- **Resend API key:** (in Vercel env vars as RESEND_API_KEY)
- **Webhook secret:** macrolens-c9524079d80852f403308a0a83c150cd
- **Admin email:** sam.grimes8@gmail.com

## Stack
- **Frontend:** Vanilla JS (no framework), Vite build, ~5000 lines in src/pages/app.js
- **Backend:** Supabase (Postgres + Auth + Storage), Vercel Edge Functions
- **AI:** Anthropic Claude via /api/analyze.js proxy (always force-refresh JWT before calls)
- **Mobile:** Capacitor (iOS/Android wrapper), PWA manifest added

## Key Files
- `src/pages/app.js` — entire frontend (~5000 lines, single file by design)
- `src/lib/db.js` — all Supabase DB functions
- `src/lib/ai.js` — all AI/Claude proxy functions
- `src/lib/capacitor.js` — native platform bridge
- `src/style.css` — all styles
- `api/analyze.js` — Vercel AI proxy (validates JWT, calls Claude)
- `api/og.js` — OG metadata scraper for recipe links
- `api/recipe/[token].js` — public shared recipe page (no auth)
- `api/notify-signup.js` — new user email via Resend
- `api/barcode.js` — Open Food Facts proxy

## Database Tables (public schema)
- `user_profiles` — user data
- `goals` — daily macro targets (one row per user, upsert with onConflict:'user_id')
- `meal_log` — food entries (has meal_type, servings_consumed, base_macros, food_item_id, recipe_id)
- `meal_planner` — weekly meal plan (has actual_date, planned_servings, meal_type, recipe_id)
- `recipes` — recipes (has ingredients jsonb, instructions jsonb, source_url, share_token, is_shared, og_cache)
- `food_items` — saved food items (has components jsonb)
- `body_metrics` — current body stats per user (one row, upsert)
- `checkins` — weekly check-in history (has scan_date, all InBody/DEXA metrics, scan_data jsonb)
- `token_usage` — AI usage tracking
- `model_pricing` — cost per model
- `admin_allowlist` — admin users
- `error_logs` — 14-day rolling error log
- `storage bucket: body-scans` — InBody/DEXA scan files (private, 2yr retention)

## Patterns & Conventions
- **Single file app:** All UI in src/pages/app.js. Don't split unless absolutely necessary.
- **State:** Global `state` object. No framework reactivity.
- **Rendering:** innerHTML assignments. Use string concatenation (not nested template literals) for complex HTML to avoid parser issues.
- **Event delegation:** Use data attributes (data-log-id, data-plan-id) + one listener on container rather than inline onclick for dynamic lists.
- **DB queries:** Always use `onConflict:'user_id'` for user-scoped upserts.
- **AI calls:** Always `await supabase.auth.refreshSession()` before any Claude API call.
- **Units:** Stored as metric (kg/cm) internally. Display converts to imperial if `state.units === 'imperial'`. Saved to localStorage.
- **Meal types:** Breakfast (5-10am), Lunch (10am-2pm), Snack (2-5pm), Dinner (5-10pm). Auto-assigned from log time, editable.
- **Error handling:** logError() for AI failures. Global window.onerror handler. 14-day cleanup runs on session start.

## Mobile / Capacitor
- **App ID:** app.macrolens
- **Web dir:** dist
- **iOS:** `npx cap add ios` then open in Xcode
- **Android:** `npx cap add android` then open in Android Studio
- **Sync after build:** `npm run build && npx cap sync`
- **Safe areas:** CSS env(safe-area-inset-*) applied to .app, .sidebar, .modal-box

## Pending Items
- Meal planner day offset timezone bug (needs desktop console debug)
- Google OAuth still in "Testing" mode (needs production verification)
- Custom domain macrolens.app
- Stripe billing
- Apple Health integration via native Swift HealthKit module
- Dietitian scheduling (Phase 3, after Stripe)
