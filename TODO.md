# MacroLens TODO

Living backlog. Items move out as they ship.

## iOS native migration roadmap

The Capacitor build at `ios/` was Phase 1 — proved we could get on a
phone but felt like a webview wrapper (because it was). We're rewriting
section by section in SwiftUI under `ios-native/`. Hybrid model: the
native shell hosts both native screens and `WKWebView` fallbacks for
not-yet-migrated pages, so the app is fully usable at every phase.
When the last webview tab flips to native, we delete `ios/` and the
`server.url` line from the old `capacitor.config.json`.

### Definition of "done" for a screen

A screen is migrated when:
- The native view replaces its webview tab in `AppShell.SignedInShell`
- All interactive paths the web version supports work natively (CRUD,
  drag/drop where applicable, modals, validation)
- It reads + writes Supabase via `supabase-swift` (no proxying through
  the Vercel app)
- Vercel-hosted edge functions (`/api/analyze`, `/api/tts`, etc.) it
  needs are reached via `URLSession` with the user's Supabase JWT
- Pull-to-refresh works
- It honors the same color tokens (Theme.swift) so light/dark parity
  is trivial later

### Phase status

- **Phase 0 — Foundation: ✅ DONE**
  Project scaffold, supabase-swift wired, AuthManager + AuthView,
  AppShell with auth gate, Theme.swift (light palette).

- **Phase 1 — App shell + webview fallbacks: 🚧 IN PROGRESS**
  Add a `WebViewTab` (UIViewRepresentable around WKWebView) and wire
  TabView with: Dashboard (native, partial), Goals (webview), Planner
  (webview), Recipes (webview), Account (webview). Webview tabs load
  `vercel.app/?page=<name>&embed=1` so the web app picks the right
  page and hides its own nav (sidebar/hamburger) since the native tab
  bar replaces them. Auth is forwarded via URL fragment
  `#access_token=...&refresh_token=...` so users don't sign in twice.

- **Phase 2 — Dashboard finish:**
  Today's Dashboard ships only the macro-counts row + Today's meals
  list. Remaining sections, ordered by daily-use signal:
  1. Quick log (search recipes + history → tap to log) — small
  2. Daily charts (Charts framework, donut + goal-progress bars) — small
  3. Analytics widget (last-7-day stat tiles + sparklines) — small
  4. Analyze food (camera + photo picker + `/api/analyze` upload +
     result card + Log button) — biggest single piece, probably an
     evening on its own

- **Phase 3 — Goals page:**
  Body metrics (collapsible card), Goal settings (collapsible card),
  weekly check-in with the tiered weekly/monthly/yearly history view
  + scan callouts, weight chart with auto-y axis. Reads checkins,
  body_metrics, goals from Supabase. Reuses the existing `?page=goals`
  webview while the native version is in flight.

- **Phase 4 — Planner page:**
  Week grid (7 columns desktop / responsive on mobile), drag-and-drop
  meal moves between days/slots, Share-week modal, Grocery-list view
  with per-meal include/exclude toggles. The drag interaction needs
  careful native UX — SwiftUI's `.draggable` + `.dropDestination` is
  the right primitive but worth a focused session.

- **Phase 5 — Recipes page:**
  Recipe library list, recipe detail modal, recipe edit screen,
  ingredient extraction (existing `/api/analyze`-backed flows),
  read-aloud entry point.

- **Phase 6 — Foods page:**
  Food items library, barcode lookup, custom food create.

- **Phase 7 — Account page:**
  Theme picker, body metrics summary, providers/follows,
  spending/usage display, sign-out, admin panel (admin users only).

- **Phase 8 — Cooking mode:**
  Read-aloud step navigator with the speechify text transform and
  voice-off mode. Audio playback can still proxy through `/api/tts`
  for premium voices. Native AVAudioPlayer for MP3 fallback.

- **Phase 9 — Retire Capacitor:**
  Delete `ios/`, remove `server.url` from `capacitor.config.json` (or
  delete the file entirely), remove `@capacitor/*` deps from
  package.json. Submit to App Store.

### Open architectural questions for this migration

- **API base URL config**: every native call to a Vercel edge function
  uses `Config.apiBaseURL`. For App Store submission we'll likely want
  a debug/release split so dev builds can hit a staging branch URL.
  Defer until we set up a Vercel preview environment.
- **Supabase realtime subscriptions**: web doesn't use them today.
  Adding native realtime updates (e.g., live planner changes across
  two devices) would be nice — but ties to Phase 4. Decide then.
- **Apple Health integration**: phase 8+ or its own thing. Will need
  a `HKHealthStore` wrapper. Real value is two-way sync (push our
  weight/macros into Health, pull workout calories back).
- **In-App Purchases**: required by App Store before anyone can pay
  for Premium. StoreKit 2. Same Premium-flag-on-user logic the web
  Stripe path will use; just a different billing source.

### Webview-tab plumbing (Phase 1 details)

For the hybrid model to work cleanly, two web-app changes are needed:

1. `?page=<name>` URL param → `state.currentPage` on init (overrides
   the sessionStorage `macrolens_page` restore). Tabs use this to
   point at the right page.
2. `?embed=1` URL param → hide the sidebar + hamburger so the native
   tab bar isn't competing with web nav. Add a `body.embed` class
   that `display: none`s `.sidebar`, `.sidebar-overlay`, `.hamburger`.

The native side passes session tokens via URL fragment so Supabase's
`detectSessionInUrl` auto-restores the session in the webview — same
mechanism Supabase OAuth callbacks use. Means users sign in once
natively and the webview tabs are already authenticated.

## Account linking + merge across providers

Lets a user who signed up with one provider attach another (the
typical case: Apple-on-iPhone user wants to also sign in via Google
on their desktop). Two flavors that look similar but mean different
things:

**A. Link identity (additive — same auth.users row).**
The user is signed in. They tap "Link Google" in Account → Sign-in
methods. The web app calls `supabase.auth.linkIdentity({ provider:
'google' })`, opens the Google OAuth flow in either ASWebAuthenticationSession
(native) or a redirect (web). On success, Google becomes a linked
identity on the current auth.users row. Same user_id, same data;
they can now sign in with either method.

Caveat for Apple-private-relay users: the Apple identity provides a
relay address as the user's email. Linking Google adds a Google
identity with a different email. Supabase tolerates this — auth.users
keeps the original (relay) email as the primary, identities table
tracks both. UX-wise the user just sees their providers list.

**B. Merge two accounts (separate auth.users rows → one).**
Rare but real: user signs up on iOS with Apple (relay@privaterelay…),
then signs up on web with Google + a different email. They want to
combine. Manual flow:
  1. Sign in to the account they want to keep (account A).
  2. Tap "Merge from another account" → modal asks them to sign in
     to account B in a popup.
  3. We get account B's session, transfer everything: meal_log,
     recipes, food_items, planner, body_metrics, goals, checkins,
     meal_plan_shares, recipe_shares, ingredient_synonyms — repoint
     user_id from B to A.
  4. Delete account B (reuse delete_my_account but parameterized).

Conflicts to handle: same recipe name on both, overlapping planner
rows on the same date, meal_log entries on the same `logged_at`.
Probably let A win on conflict and keep B's row alongside (not
deduped). Document the behavior in a confirmation step.

UI sketch (Account → "Sign-in methods"):
- Primary email shown clearly so private-relay users know their
  identity address (lets them use it for password reset on desktop
  if they choose).
- List of linked providers with provider name + email per identity.
- "Link Google" / "Link Apple" buttons (Apple only on iOS native).
- "Unlink" per non-primary identity (with confirmation).
- "Merge from another account" — separate flow.
- "Delete my account" already shipped (Apr 30).

Implementation notes:
- Supabase has linkIdentity / unlinkIdentity since v2.16. Need
  `Manual Linking` enabled at project level in Supabase Auth.
- Native Apple Sign-In already uses signInWithIdToken — for linking
  we'd use a different SDK call (linkIdentity isn't directly
  exposed via the iOS SDK at time of writing; might need to call
  the Auth REST API directly).
- Merge step needs a SECURITY DEFINER function similar to
  delete_my_account that takes (a_user_id, b_user_id), verifies
  the caller has a session for both (passes refresh tokens for
  both), and does the row-by-row repoint inside one transaction.

## Cooking mode — paid voices

**Status:** ✅ SHIPPED (code) — Apr 28 session. Pending: `OPENAI_API_KEY`
in Vercel env, and the `recipe_audio.sql` migration to run in Supabase
before going live. Once those land, premium voices appear in the voice
picker under "✨ Premium voices" and route through `/api/tts` with
per-recipe MP3 caching. Graceful fallback to browser SpeechSynthesis on
network failure or spend-cap hits.

User feedback after launching free read-aloud (Apr 26 session):
"sounds like Stephen hawking ... we might need to upgrade to paid
voices how much we talking?"

### Cost analysis

**ElevenLabs** (gold standard for natural-sounding TTS — closest to
"Margot Robbie" though obviously not literally her voice):
- Pricing tiers (as of pricing page check; verify before commit):
  - Starter: $5/mo, 30k chars/mo  → ~$0.000167/char
  - Creator: $22/mo, 100k chars/mo → ~$0.00022/char
  - Pay-as-you-go above tier: ~$0.30 per 1k chars
- Typical recipe instruction: ~30 words × 6 steps = ~1100 chars
  → roughly $0.30 per recipe read-through at PAYG rates
- A premium user reading 30 recipes/month: ~$9 in TTS alone

**OpenAI TTS** (cheaper, decent quality but more "AI-sounding"):
- $15 per 1M chars (tts-1) or $30 per 1M (tts-1-hd)
- Same recipe: ~$0.0165 per read at tts-1, $0.033 at tts-1-hd
- Way cheaper but voices are noticeably less expressive

**Google Cloud TTS Wavenet/Neural2:**
- $16 per 1M chars
- Similar economics to OpenAI

### Design decisions to make

1. **Which provider?**
   - ElevenLabs sounds best, costs most
   - OpenAI tts-1-hd is the value play — 10x cheaper, 80% as good
   - Could start with OpenAI, add ElevenLabs as a "premium voice"
     option for users who want the best

2. **Who pays?**
   - Bundle into AI Bucks (read-aloud burns Bucks per char) — fairest
     but discourages use of the feature
   - Premium-only feature with unlimited reads — simplest UX, eats
     into the Premium tier margin
   - Standalone microtransaction ($1 to "unlock premium voice for
     this recipe" or for the month) — annoying

3. **Caching strategy**
   - Generate audio per recipe step, store as MP3 in Supabase Storage
   - Re-use across reads of the same recipe (massive cost savings —
     1 generation per recipe per voice forever)
   - Re-generate only when instructions change
   - Storage cost is negligible compared to TTS cost

### Recommendation when we revisit

Start with **OpenAI tts-1-hd + per-recipe caching**. ~$0.033 first
read, $0 every subsequent read of the same recipe. Burn rate is
manageable even with heavy use. Can layer ElevenLabs on top later
as a "premium voice" upgrade if users explicitly want better.

Voice options would be: Alloy, Echo, Fable, Nova, Onyx, Shimmer.
Nova is the warm-female one most users gravitate toward.

### Implementation sketch

- New table: `recipe_audio(recipe_id, step_index, servings, voice_id, instructions_version, mp3_url, char_count, created_at)`
  - **Cache key includes servings** because instruction text scales with serving size (scaleStepText regex-replaces quantities). Same recipe at 4 vs 6 servings produces different text → different audio. Without `servings` in the key, scaled-up reads would play wrong numbers.
  - **Cache key includes instructions_version** for cache invalidation on edit. See "Edit invalidation" below.
  - Servings is `numeric(6,2)` to handle 0.5, 1.5, 2.5 etc.
  - `voice_id` indexed because we'll likely settle on Nova for everyone but want flexibility to add ElevenLabs voices later.
- New column on recipes: `instructions_version int default 1`. Bumped (`+= 1`) on every recipe save. The save itself IS the invalidation — atomic, concurrent-safe, no cleanup race conditions.
- New endpoint: `api/tts.js` that takes (recipe_id, step_index, servings, voice_id, instructions_version), checks cache, generates if missing via OpenAI tts-1-hd, uploads MP3 to Supabase Storage, returns URL
- Cooking mode: instead of `speakStep()` calling browser TTS, fetch the MP3 URL and play it via `<audio>` element
- Pass `state.recipeServings` (or recipe.servings if null) AND `recipe.instructions_version` into the fetch so the cache key matches the current recipe state
- Fallback: if api/tts is unavailable or user is over budget, fall back to current free browser TTS (graceful degrade)
- Voice picker: add "Premium voices" section above the device voices

### Edit invalidation

If a user listens to instructions, finds an error, edits the recipe, and re-opens cooking mode, they MUST hear the corrected version — not a cached MP3 with the old wrong text. Stale audio while cooking is way worse than spending another $0.033 to regenerate.

**Trigger: bump `recipes.instructions_version` on every recipe save.** Hooks into the existing upsertRecipe path — no new save flows to wire. Cache rows referencing the old version become unreachable. New reads at the new version trigger regeneration.

Why a version counter rather than `DELETE FROM recipe_audio WHERE recipe_id = X` on save:
- **Atomic with the save.** No crash window between delete and write that leaves stale rows cached.
- **Concurrent-safe.** Two users editing simultaneously don't trample each other.
- **Storage cleanup is async.** A nightly job (or cron) sweeps `recipe_audio` rows where `instructions_version != recipes.instructions_version` and deletes the orphaned MP3s from Supabase Storage. Doesn't block any user flow.

Bump triggers (anywhere we already write to the recipes table — these all go through upsertRecipe so it's one place):
- User edits an instruction step manually
- User taps "✨ Regenerate instructions" (AI rewrites)
- User edits ingredients (conservative — might affect a referenced quantity)
- User changes the recipe name or other fields (cheap to over-invalidate vs. risk of stale audio)

The only edits that DON'T need invalidation are tags, share toggles, and serving label (these don't appear in scaleStepText). Could exempt those for marginal cost savings, but probably not worth the complexity — let everything bump.

### Cost math with servings caching + invalidation

- Storage cost per recipe: ~50KB per MP3 × 6 steps × 5 typical serving sizes = 1.5MB. At Supabase $0.021/GB/mo → effectively $0 even at 10k recipes.
- Each unique (recipe, servings, version) combo costs ~$0.033 ONCE, then $0 for all subsequent reads (across all users).
- Edits that bump the version → re-pay for that recipe's reads going forward. But edits are infrequent — most recipes are read many more times than they're edited.
- Most users use 1-2 serving sizes per recipe (base + doubled). So a typical recipe's lifetime TTS cost is $0.07-$0.10 even with occasional edits.
- Edge case: weird custom servings (e.g. user types 7) → cache miss → $0.033 → one-time. Acceptable.

### Tracking infrastructure changes (✅ DONE — Apr 26 session)

Schema migration shipped: supabase/migrations/multi_provider_pricing.sql
ran successfully against production.

What ships:
- token_usage: + provider, units_used, unit_type, input_rate_snapshot,
  output_rate_snapshot, unit_rate_snapshot. Backfilled to 'anthropic'/'tokens'.
- model_pricing: + provider, unit_type, unit_cost_per_1m, effective_from,
  effective_until. Old NOT NULL on input/output cost columns dropped to
  allow per-character (unit-based) pricing rows.
- record_usage RPC extended with p_provider / p_units_used / p_unit_type
  (with defaults so existing analyze.js calls unchanged).
- calculate_request_cost_v2 dispatches on (provider, model, unit_type)
  and looks up the pricing row that was effective at the call timestamp.
  Old 3-arg signature preserved as wrapper for backward compat.
- Pricing data refreshed:
  • Stale Opus 4.5 row at $15/$75 marked as effective_until=now()
  • New Opus 4.5 row at $5/$25 effective from 2025-11-24
  • Added claude-opus-4-6, claude-sonnet-4-6, claude-opus-4-7 (current flagship)
  • Added openai/tts-1 ($15/M chars) and openai/tts-1-hd ($30/M chars)
    placeholders for the upcoming paid voice work

Behavior change: unknown model now returns $0 instead of silently
treating as Sonnet pricing. Old default was a footgun for non-Anthropic
providers.

Future rate change procedure (when Anthropic raises Sonnet, etc):
```sql
update public.model_pricing
   set effective_until = now()
 where provider = 'anthropic' and model = 'claude-sonnet-4-6'
   and effective_until is null;

insert into public.model_pricing (provider, model, input_cost_per_1m,
  output_cost_per_1m, unit_type, effective_from, updated_at)
values ('anthropic', 'claude-sonnet-4-6', 4.00, 20.00, 'tokens', now(), now());
```
Two SQL statements. No code deploy. Historical cost_usd values stay
accurate. Calls before the change keep their old rates (snapshotted).

Spend cap continues to work — total_spent_usd accumulates uniformly
across providers via the unified cost_usd column.

### Cache hit cost

When we serve audio from cache, we DON'T call record_usage at all
— no cost, no tracking. Only the FIRST generation per (recipe,
servings, version, voice) records usage. This is what keeps the
average cost per user low even with persistent caching.

---

## Known bugs

- **Password reset broken** — reported 2026-04-28. Reset flow does
  not work for `sam.grimes8@yahoo.com`. Need to repro: check whether
  the reset email sends at all (Resend logs / Supabase auth logs),
  whether the link's redirect URL is correct, and whether the new
  password actually persists. Yahoo deliverability is also a likely
  suspect — may need to compare against a Gmail account.

## Other deferred items

- **Stripe wiring** — handleUpgradeClick is a placeholder; real
  Premium upgrades aren't wired yet
- **Provider application flow** — currently alerts "coming soon"
- **Resend integration** — better transactional email
- **Supabase MCP setup** — direct DB access from Claude desktop
- **Soft warning banner at 80% AI Bucks** — friendly heads-up
  before paywall hits
- **Real `tags` table** — currently derived from recipes.tags +
  state._stagedCustomTags; should be first-class
- **Save-pipeline normalization** — parseAmount applied at write
  time, not just read time, so DB stores clean numbers
- **Refresh snapshot on personal meal-plan shares** — today a share
  is a static snapshot at create-time. Add a "Refresh" button on
  each share row in the planner's share modal that re-captures the
  current week's planner state into the same share row (same URL,
  same token, just updated `plan_data` + `updated_at`). Saves users
  from generating a new link every time they tweak a meal. Caveat:
  the public landing page caches for ~60s, so recipients might see
  a brief lag after a refresh — acceptable.
- **Native Google Sign-In on iOS (Capacitor)** — web OAuth opens
  Safari and never redirects back into the app. For now we hide the
  Google button when running natively (isNative() check in auth.js)
  so users only see email/password. Proper fix: install
  `@codetrix-studio/capacitor-google-auth` (or
  `@capacitor-firebase/authentication`), register an iOS OAuth
  client in Google Cloud Console, drop GoogleService-Info.plist
  into `ios/App/App/`, then call signInWithIdToken() against
  Supabase using the native id_token. Probably 1–2 hours end to
  end. Required before App Store submission since users will
  expect Google Sign-In on a nutrition app.
- **Bundled web assets + configurable API base URL** — Phase 1 mobile
  is loading the live Vercel origin via capacitor.config.json
  `server.url`. Apple rejects "just a website wrapper" under
  guideline 4.2, so before App Store submission we have to bundle
  `dist/` into the app (drop `server.url`) and replace every
  `fetch('/api/...')` with `fetch(API_BASE + '/api/...')` where
  API_BASE is the Vercel origin. Probably a `src/lib/api.js`
  wrapper that picks the right base based on `Capacitor.isNativePlatform()`.
