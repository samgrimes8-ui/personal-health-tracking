# MacroLens TODO

Living backlog. Items move out as they ship.

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
