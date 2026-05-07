# MacroLens TODO

Living backlog. Items move out as they ship.

Last updated: 2026-05-07. The session since 2026-04-30 shipped 106 commits
across iOS native, web, DB, and the TestFlight pipeline. See **Recently
Shipped** for what landed and **Backlog** for what's still ahead.

---

## Recently Shipped (since 2026-04-30)

### iOS Native — Phase 0/1/2 ported (TestFlight live, v0.3.0)

**Foundation + tab shell** — all 8 tabs are native; the webview fallback
era is over.
  - 8-tab TabView + AppShell forwarders (`bb9d870`, `07649ec`)
  - Pre-declared worker DB shapes + load methods + state slices
    (`83097af`, `0b346af`)
  - Shared `DBService.swift` write surface + UI primitives (`180635f`,
    `9aac253`, bumped to v0.2.0)
  - Slide-out nav replaces "More" overflow, matches desktop tab order
    (`7df9564`)
  - Scrollable bottom bar + swipe-to-page content (`2e05492`)

**Recipes tab** (`6fdf156` and follow-ups)
  - Library list, detail view with swipe-through pager (`7d9a662`)
  - Add-recipe parity: 4 paths with method picker (`07b197e`)
  - AI-generated instructions + save (`65d0f6e`)
  - Public sharing via token + native share sheet (`53279a6`,
    in-place from detail `54b6138`)
  - Cooking mode + premium TTS, eager-prefetch (`2bf83a8`, `d4e329b`),
    silent by default with opt-in voice (`151fc7e`)
  - Plan-from-recipe sheet, plan-this-recipe in-place (`993b641`,
    `5984df6`)
  - OG preview card for source URL (`053ff5e`)
  - Quick-tag context menu + user-editable tag order (`cf60633`,
    `2945988`)
  - Fix: Recipes tab not loading (`345c120`)

**Goals tab** (`b045917`, `e6880e4`)
  - Body Metrics detail view (push from summary card) (`834949c`)
  - Daily Targets detail view + lock-to-balance + methodology
    (`bf4c8af`)
  - Body Metrics save can also log weight via checkbox (`9669f0a`)
  - Detailed scan history → ScanDetailView (`2f63953`)
  - Scan extract pipeline: Service + Models + storage (`af90e2b`)
  - Scan upload UI in LogWeightSheet (`82d5119`)
  - Delete-checkin confirmation dialog (`dcdef95`)
  - Equal-width stat tiles + tight weight-chart y-axis (`cd89012`)
  - Clip weight chart fill to card bounds (`72cfb21`)
  - Fix: daily targets weren't persisting / returning null (`3735edc`)

**Dashboard**
  - Editable meal entries + Quick Log full history (`976b2e5`)
  - Quick Log live search across food_items + meal_log + AI describe
    fallback (`c69a5b7`, `e602c93` ilike fix)
  - Quick Log scope: 2 meals + 2 foods (`b9c339e`)
  - Quick Log composite ranking (match + personal + global + USDA)
    (`0e7a7a9`); personal-item rank boost + tap=preview/+=instant
    (`22e9c9b`)
  - Search generic_foods before AI fallback (`5672d63`)
  - Combo prompt for multi-component foods (`ed9e8c8`)
  - Past-day meal logging via date nav (`6a8bed4`); meal edit sheet
    supports retroactive date (`92fc497`)
  - Show planned meals with check-off-to-consume (`d000d00`)
  - Group today's meals by meal type, fix TZ filter (`2dc7a08`)
  - Analyze: full barcode→label→classify fallback chain + JSON-vs-HTML
    guard (`c32e919`)
  - Uniform font sizing across macro count cards (`9669f0a`,
    `2a5b3db` wrap fix)
  - Keyboard dismiss (`b9c339e`)

**Planner tab** (`69b37da`)
  - Smart paired-meal drag (auto-move + prompt for ambiguous case)
    (`c673cf0`)
  - Clearer copy on leftovers move prompt (`47cf64b`)

**Foods tab** (`2f926f3`)
  - Auto-save logged foods to food_items library (`3a3fbcb`)
  - Apply per-component qty when logging combo by component (`8731742`)
  - Refine existing food via barcode / label / AI with per-field diff
    acceptance (`19fe0c7`)

**Account tab** (`9df3326`)
  - Full nutrition label opt-in (toggle + expanded UI) (`bf2b327`)
  - Rename "AI Bucks" → "Computer Calories" (`b47823c`)

**Providers tab** (`71f2f56`) — directory, follow, channel editor

**HealthKit two-way sync**
  - Push macros + weight, pull weight with 12mo backfill, source-based
    dedup (`1dec465`)
  - Switch macro push to daily-total samples + 90-day backfill
    migration (`9722934`)
  - Fix daily-total drift (root cause: UTC-prefix grouping + non-self-
    healing push) (`cfc7470`)
  - Foreground weight pull + background delivery (root cause: `.task`
    fires once per view lifetime) (`dff07cb`)
  - Request READ permission for bodyMass (root cause: typesToRead was
    empty) (`5082c34`)
  - Tolerance dedup guard in insertHealthKitWeight (`6a0f841`)

**Auth + Nav**
  - Native Apple Sign-In (already in place pre-session)
  - Slide-out nav replaces overflow menu (`7df9564`)

**Photo + meal-input UX**
  - Standardized photo input across all surfaces — camera default +
    library icon (`3cd611d`, web parity `6962261`)
  - Meal preview sheet before save, reusable for new + edit
    (`b382aaf`, `350f283`)
  - Tap-to-select-all numeric inputs + dropdown unit picker
    (`e880f24`)
  - Detect parsed quantity in Analyze Describe + scale entry
    (`415dfb3`)
  - Fix amount field focus stealing on existing-entry edit
    (`29ab4cd`)
  - Keyboard dismissal — scroll-to-dismiss + Done toolbar across all
    text inputs (`0226057`)

### Web App
  - Quick Log composite ranking parity (`db74e34`)
  - Quick Log searches generic_foods before AI fallback (`67123e6`)
  - Full nutrition label opt-in mirror (`94146ed`); reads
    `user_profiles.track_full_nutrition` (`4440bfa`)
  - Pass full-label fields through addMealEntry + upsertFoodItem
    (`0306719`)
  - Quick Log AI fallback uses describeFoodCandidates picker
    (`133e27c`)
  - Body Metrics save can also log today's weigh-in (`401d00c`)
  - showResult prefers serving_description (`f920e11`)
  - Meal preview modal before save (`09f22eb`)

### Database / Infrastructure
  - `track_full_nutrition` column on `user_profiles` (`095c7b8`)
  - 13 nullable full-label columns on `meal_log`, `food_items`,
    `generic_foods` (saturated_fat, trans_fat, cholesterol, sodium,
    fiber, sugar_total, sugar_added, vitamin_a/c/d, calcium, iron,
    potassium); goals.sodium_mg_max / fiber_g_min /
    saturated_fat_g_max / sugar_added_g_max
  - `generic_foods` table for USDA-sourced common foods (`badb22c`);
    USDA FDC import script (`892a8b7`)
  - `global_log_count` + `distinct_users` columns + trigger + backfill
    on food_items (`5f4921f`)
  - Serving-units backfill SQL + AI-fallback script + soft constraint
    (`f5da201`); enforce describe-style fields server-side + require
    in form (`7836a62`); surface tap-to-set affordance for legacy NULL
    (`77d240e`)
  - Multi-provider pricing migration (Apr 26, pre-session, but TTS
    rows now in use): token_usage + provider/units_used/unit_type/
    rate snapshots; model_pricing + unit_type/effective_from/until;
    record_usage / calculate_request_cost_v2 RPCs

### TestFlight Pipeline (end-to-end automation)
  - `ios-native/testflight.sh` orchestrates archive + upload (worker-
    testflight session)
  - Release config uses Apple Distribution cert (`d3e72be`, then
    reverted `ad791e4` after a workflow tweak — current path differs)
  - 1024×1024 app icon set + wired
    `ASSETCATALOG_COMPILER_APPICON_NAME` (`95e0bdf`)
  - `PrivacyInfo.xcprivacy` for App Store submission (`dd35132`)
  - `MARKETING_VERSION` bumped 0.2.0 → 0.3.0 for first TestFlight
    release (`bf00fad`)
  - Dropped `processing` from UIBackgroundModes — fixes ASC validator
    error 90771 (`a442030`)
  - `ITSAppUsesNonExemptEncryption=false` to skip ASC compliance
    prompt (`15f85c6`)

### AI / Backend
  - `meal_log` analyze→log path always satisfies `serving_present`
    constraint (default + AI prompt) (`80514f9`)
  - `describeFood` includes serving description + grams + oz;
    candidates endpoint added (`3f5cfc0`)
  - Pick natural single servings + detect parsed quantity in describe
    queries (`313d4e1`)

---

## In Flight (workers active)

  - **worker-grocery-parity** — porting grocery-list view to iOS
    native Planner (started 2026-05-07). Uncommitted Xcode project
    changes (`ios/App/App.xcodeproj/project.pbxproj` modified +
    `project.xcworkspace/` untracked) are likely from this work or a
    stale Xcode open — investigate before committing or discarding.
  - 30+ stale tmux worker sessions from prior days are still alive
    but their commits have all landed; safe to `tmux kill-session`
    when convenient (do not auto-kill — confirm with user).

---

## Backlog / Next Up

### Monetization foundation
  - **Apple Small Business Program enrollment** — drops Apple's IAP
    fee from 30% → 15% for orgs under $1M/yr. Apply before first
    paid transaction.
  - **StoreKit 2 + Stripe + Supabase subscription wiring** — paywall
    foundation. Same Premium-flag-on-user logic on both billing
    sources. `handleUpgradeClick` is still a placeholder.
  - **Soft warning banner at 80% AI Bucks / Computer Calories** —
    friendly heads-up before paywall hits.

### App Store submission prep
  - Screenshots (all device sizes), description, age rating
  - Privacy policy URL
  - Custom domain `macrolens.app`
  - Google OAuth still in "Testing" mode — needs production
    verification before public launch
  - **Bundled web assets + configurable API base URL** — only
    relevant if we keep the legacy Capacitor `ios/` build alive for
    Android. Phase 9 plan is to delete `ios/` once iOS native is
    feature-complete; if Android lags, we still need to bundle
    `dist/` into the Capacitor build before any Play Store
    submission.

### iOS native — remaining work
  - **PDF scan upload route** — deferred during goals parity;
    currently only image scans extract. PDF flow needs MIME +
    pdf→image conversion (or PDF text extraction) before Claude
    upload.
  - **Background HealthKit delivery hardening** — some edge cases
    deferred (worker-healthkit replies). Daily-total drift fix
    landed but needs validation across timezone changes + app
    suspension scenarios.
  - **Account linking + merge across providers** — Apple-on-iPhone
    + Google-on-desktop is the typical case. See Reference doc
    below for the full plan.

### Email + integrations
  - **Email integration (Gmail send via API)** — for artifacts /
    reports. Per user memory; Resend is already wired for signup
    notifications, but transactional + outbound user-facing email
    is still pending.
  - **Resend integration** — better transactional email beyond the
    current signup notify.

### Phase 3 (post-Stripe)
  - **Dietitian scheduling** — calendaring + provider availability +
    booking flow. Blocked on Providers tab being live (✅) and
    Stripe being live (❌).

### Smaller deferred items (preserved from pre-session)
  - **Provider application flow** — currently alerts "coming soon"
  - **Real `tags` table** — currently derived from `recipes.tags` +
    `state._stagedCustomTags`; should be first-class
  - **Save-pipeline normalization** — `parseAmount` applied at write
    time, not just read time, so DB stores clean numbers
  - **Refresh snapshot on personal meal-plan shares** — today a
    share is a static snapshot at create-time. Add a "Refresh"
    button that re-captures the current week's planner state into
    the same share row. Caveat: public landing page caches ~60s.
  - **Native Google Sign-In on Capacitor iOS** — only relevant if we
    keep `ios/` alive for some reason. The native iOS rewrite uses
    Apple Sign-In; Google Sign-In on the native side is unbuilt
    (web users still get Google via OAuth).
  - **Supabase MCP setup** — direct DB access from Claude desktop
    (the Supabase MCP server is already wired in this Claude Code
    session — this item likely refers to the desktop client).

---

## Known Issues / Tech Debt

  - **Password reset broken** — reported 2026-04-28. Reset flow does
    not work for `sam.grimes8@yahoo.com`. Need to repro: check
    whether the reset email sends at all (Resend logs / Supabase
    auth logs), whether the link's redirect URL is correct, and
    whether the new password actually persists. Yahoo deliverability
    is also a likely suspect — compare against a Gmail account.
  - **Meal planner day offset timezone bug** — listed in CLAUDE.md
    Pending Items. Needs desktop console debug session to repro.
  - **Uncommitted Xcode project changes** — `project.pbxproj`
    modified + `project.xcworkspace/` untracked since this session
    started. Likely worker-grocery-parity in flight or stale Xcode
    state — investigate before committing.

---

## Done — pre-session items still meaningful

  - **Cooking mode paid voices** — code shipped Apr 28; iOS native
    cooking mode now uses it (`2bf83a8`, `151fc7e`, eager prefetch
    `d4e329b`). `OPENAI_API_KEY` is live in Vercel; recipe_audio
    migration ran. Working in production.
  - **Multi-provider pricing infrastructure** — shipped Apr 26.
    `token_usage` + `model_pricing` extended for unit-based pricing
    (per-character TTS) + effective_from/effective_until ranges.
    `calculate_request_cost_v2` dispatches on (provider, model,
    unit_type). All historical cost_usd values stay accurate
    through rate changes.
  - **Account deletion** — `delete_my_account` SECURITY DEFINER
    shipped Apr 30.
  - **Apple Health integration** — was listed in CLAUDE.md Pending
    Items; shipped via HealthKit two-way sync (`1dec465` +
    follow-ups). CLAUDE.md should be updated to reflect this.

---

## Reference docs (preserved from earlier planning)

The sections below are kept for context — they pre-date this
session's work but the design choices documented here still
inform current code.

### iOS native migration roadmap

The Capacitor build at `ios/` was Phase 1 — proved we could get on a
phone but felt like a webview wrapper (because it was). We rewrote
section by section in SwiftUI under `ios-native/`. As of 2026-05-07
all 8 tabs are native (Dashboard, Goals, Planner, Recipes, Foods,
Account, Providers, Analytics). Remaining: delete `ios/`, drop
`server.url` from `capacitor.config.json`, remove `@capacitor/*`
deps from `package.json`, App Store submission (Phase 9).

### Definition of "done" for a screen
  - Native view replaces its webview tab in `AppShell.SignedInShell`
  - All interactive paths the web version supports work natively
  - Reads + writes Supabase via `supabase-swift` (no proxying)
  - Vercel-hosted edge functions reached via `URLSession` with the
    user's Supabase JWT
  - Pull-to-refresh works
  - Honors Theme.swift color tokens

### Open architectural questions
  - **API base URL config** — debug/release split for staging
    branch URL. Defer until Vercel preview env exists.
  - **Supabase realtime subscriptions** — not used today. Live
    planner sync across two devices would be nice — decide when
    Planner has enough usage to warrant it.
  - **In-App Purchases** — StoreKit 2; required by App Store
    before anyone can pay for Premium.

### Account linking + merge across providers

Lets a user who signed up with one provider attach another (typical
case: Apple-on-iPhone user wants to also sign in via Google on
desktop). Two flavors:

**A. Link identity (additive — same auth.users row).** Signed-in
user taps "Link Google" in Account → Sign-in methods. Web app calls
`supabase.auth.linkIdentity({ provider: 'google' })`, opens OAuth
in ASWebAuthenticationSession (native) or redirect (web). On
success, Google becomes a linked identity on the current
auth.users row.

Caveat for Apple-private-relay users: Apple identity provides a
relay address as the user's email. Linking Google adds a Google
identity with a different email. Supabase tolerates this.

**B. Merge two accounts (separate auth.users rows → one).** Rare
but real. Manual flow:
  1. Sign in to the account they want to keep (account A).
  2. Tap "Merge from another account" → modal asks them to sign in
     to account B in a popup.
  3. Get B's session, transfer everything: meal_log, recipes,
     food_items, planner, body_metrics, goals, checkins,
     meal_plan_shares, recipe_shares, ingredient_synonyms — repoint
     user_id from B to A.
  4. Delete B (parameterized delete_my_account).

Conflicts: same recipe name on both, overlapping planner rows,
meal_log entries on the same `logged_at`. Let A win on conflict;
keep B's row alongside (not deduped). Document in confirmation.

UI sketch (Account → "Sign-in methods"):
  - Primary email shown clearly so private-relay users know their
    identity address
  - List of linked providers with name + email per identity
  - "Link Google" / "Link Apple" buttons
  - "Unlink" per non-primary identity (with confirmation)
  - "Merge from another account" — separate flow
  - "Delete my account" — already shipped

Implementation notes:
  - Supabase has linkIdentity / unlinkIdentity since v2.16. Need
    `Manual Linking` enabled at project level.
  - Native Apple Sign-In already uses signInWithIdToken — for
    linking we'd use linkIdentity (might need REST API directly).
  - Merge step needs a SECURITY DEFINER function that takes
    (a_user_id, b_user_id), verifies the caller has a session for
    both, and does row-by-row repoint inside one transaction.

### Cooking mode TTS — design notes (shipped, kept for reference)

OpenAI `tts-1-hd` + per-recipe caching. ~$0.033 first read of a
(recipe, servings, version) combo, $0 every subsequent read.
ElevenLabs reserved as a future "premium voice" upgrade.

**Cache key includes servings** because instruction text scales
with serving size. Same recipe at 4 vs 6 servings → different
text → different audio.

**Cache key includes `instructions_version`** for cache
invalidation. `recipes.instructions_version` bumps on every save
through `upsertRecipe`. Atomic with the save, concurrent-safe;
storage cleanup is async (nightly sweep).

Edits that don't strictly need invalidation (tags, share toggles,
serving label) still bump — over-invalidation is cheap vs. risk
of stale audio.

**Cache hit cost = 0.** When we serve audio from cache we don't
call `record_usage` at all. Only the FIRST generation per
(recipe, servings, version, voice) records usage.

Schema:
  - `recipe_audio(recipe_id, step_index, servings, voice_id,
    instructions_version, mp3_url, char_count, created_at)` —
    `servings` is `numeric(6,2)` to handle 0.5, 1.5, etc.
  - `recipes.instructions_version int default 1`

Fallback: if `/api/tts` is unavailable or user is over budget,
fall back to browser SpeechSynthesis on web / native AVSpeech on
iOS.

Future rate change procedure (when Anthropic raises Sonnet, etc):
```sql
update public.model_pricing
   set effective_until = now()
 where provider = 'anthropic' and model = 'claude-sonnet-4-6'
   and effective_until is null;

insert into public.model_pricing (provider, model,
  input_cost_per_1m, output_cost_per_1m, unit_type,
  effective_from, updated_at)
values ('anthropic', 'claude-sonnet-4-6', 4.00, 20.00, 'tokens',
  now(), now());
```
Two SQL statements. No code deploy. Historical `cost_usd` values
stay accurate (rates were snapshotted at call time).
