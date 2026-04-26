# MacroLens TODO

Living backlog. Items move out as they ship.

## Cooking mode — paid voices

**Status:** Deferred decision; deciding when ready.

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

- New table: `recipe_audio(recipe_id, step_index, voice_id, mp3_url, char_count, created_at)`
- New endpoint: `api/tts.js` that takes (recipe_id, step_index, voice_id), checks cache, generates if missing, returns URL
- Cooking mode: instead of `speakStep()` calling browser TTS, fetch the MP3 URL and play it via `<audio>` element
- Fallback: if api/tts is unavailable or user is over budget, fall back to current free browser TTS (graceful degrade)
- Voice picker: add "Premium voices" section above the device voices

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
