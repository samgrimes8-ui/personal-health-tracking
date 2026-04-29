/**
 * Vercel Edge Function: /api/tts
 *
 * Cache-first text-to-speech for cooking mode.
 *
 *   1. Validates the user's Supabase JWT.
 *   2. Looks up recipe_audio for (recipe, step, servings, voice, version).
 *      Cache hit → return the existing public MP3 URL with cached:true.
 *      No OpenAI call, no record_usage, no spend.
 *   3. Cache miss → check the user's spend limit, scale the step text
 *      with the same regex the client uses for display, call OpenAI TTS,
 *      upload the MP3 to the recipe-audio storage bucket, insert a
 *      recipe_audio row, record usage at the per-character TTS rate,
 *      and return the new URL.
 *
 * The OpenAI key never reaches the browser. Auth is required even for
 * cache hits — we don't want anonymous users hammering us to enumerate
 * recipe IDs.
 */

import { createClient } from '@supabase/supabase-js'

export const config = { runtime: 'edge' }

// Voices we expose to the client. Free voices use browser SpeechSynthesis
// and never hit this endpoint — these are the OpenAI premium picks only.
const SUPPORTED_VOICES = new Set(['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'])

// tts-1-hd is the value play (10x cheaper than ElevenLabs, ~80% as good).
// Pricing row for openai/tts-1-hd is seeded in multi_provider_pricing.sql
// at $30 per 1M chars.
const OPENAI_MODEL = 'tts-1-hd'
const STORAGE_BUCKET = 'recipe-audio'

// Cap per-step text length. A typical step is ~200 chars; we allow generous
// headroom for verbose recipes but reject obviously-pathological inputs so a
// single rogue request can't drain the spend cap. 2000 chars × $30/M = $0.06.
const MAX_STEP_CHARS = 2000

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  // ── Auth ──────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization header' }, 401)
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const supabase = createClient(
    supabaseUrl,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) {
    return json({ error: 'Invalid or expired session' }, 401)
  }

  // ── Parse body ────────────────────────────────────────────────────
  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const recipeId = String(body.recipe_id || '')
  const stepIndex = Number.isInteger(body.step_index) ? body.step_index : -1
  const servingsRaw = Number(body.servings)
  const voiceId = String(body.voice_id || '').toLowerCase()
  const instructionsVersion = Number.isInteger(body.instructions_version) ? body.instructions_version : -1

  if (!recipeId || stepIndex < 0 || !(servingsRaw > 0) || !voiceId || instructionsVersion < 1) {
    return json({ error: 'Missing required fields: recipe_id, step_index, servings, voice_id, instructions_version' }, 400)
  }
  if (!SUPPORTED_VOICES.has(voiceId)) {
    return json({ error: `Unsupported voice. Pick one of: ${[...SUPPORTED_VOICES].join(', ')}` }, 400)
  }
  // Quantize servings to 2dp to match numeric(6,2) and avoid cache misses
  // from float weirdness (1.4999999 vs 1.5).
  const servings = Math.round(servingsRaw * 100) / 100

  // ── Cache check ───────────────────────────────────────────────────
  // Look up an existing row for this exact (recipe, step, servings, voice, version).
  // Hit → return immediately, no spend, no OpenAI call.
  {
    const { data: cached, error: cacheErr } = await supabase
      .from('recipe_audio')
      .select('mp3_url')
      .eq('recipe_id', recipeId)
      .eq('step_index', stepIndex)
      .eq('servings', servings)
      .eq('voice_id', voiceId)
      .eq('instructions_version', instructionsVersion)
      .maybeSingle()
    if (cacheErr) {
      // Don't fail the user request on a cache-table read error — fall
      // through to a fresh generation. We log and continue.
      console.error('[tts] cache lookup failed:', cacheErr.message)
    } else if (cached?.mp3_url) {
      return json({ url: cached.mp3_url, cached: true })
    }
  }

  // ── Load the recipe + verify the version matches ──────────────────
  // We refuse to generate against a stale instructions_version. If the
  // client passes an old number, the user has edited the recipe in
  // another tab and should refetch — generating now would just waste
  // money on text that no longer exists.
  const { data: recipe, error: recipeErr } = await supabase
    .from('recipes')
    .select('id, user_id, servings, instructions, instructions_version, is_shared')
    .eq('id', recipeId)
    .maybeSingle()
  if (recipeErr || !recipe) {
    return json({ error: 'Recipe not found' }, 404)
  }
  // Owners can always read their own recipes; shared recipes are readable
  // by anyone authenticated (matches how share links work elsewhere).
  if (recipe.user_id !== user.id && !recipe.is_shared) {
    return json({ error: 'Not authorized for this recipe' }, 403)
  }
  if (recipe.instructions_version !== instructionsVersion) {
    return json({
      error: 'Recipe instructions have changed. Reload to regenerate audio.',
      code: 'stale_version',
      current_version: recipe.instructions_version,
    }, 409)
  }

  const steps = Array.isArray(recipe.instructions?.steps) ? recipe.instructions.steps : []
  const rawStep = steps[stepIndex]
  if (!rawStep || typeof rawStep !== 'string') {
    return json({ error: 'Step not found' }, 404)
  }
  // Spoken form: "0.5 tbsp" → "half a tablespoon", "350°F" → "350 degrees
  // Fahrenheit", etc. Same scaling as the display path but rendered for TTS
  // so the OpenAI model doesn't recite "zero point five tee bee ess pee."
  const stepText = speechifyStepText(rawStep, recipe.servings || 1, servings)
  if (!stepText.trim()) {
    return json({ error: 'Step is empty' }, 400)
  }
  if (stepText.length > MAX_STEP_CHARS) {
    return json({ error: `Step too long (${stepText.length} chars, max ${MAX_STEP_CHARS})` }, 400)
  }

  // ── Spend limit check (rough estimate before the call) ────────────
  // tts-1-hd is $30 per 1M chars. We pass the scaled step length as the
  // estimated cost so the cap is honest about what this request will burn.
  const estimatedCost = stepText.length * 30 / 1_000_000
  const { data: limitCheck } = await supabase.rpc('check_spend_limit', {
    p_user_id: user.id,
    p_estimated_cost: estimatedCost,
  })
  if (!limitCheck?.allowed) {
    const reason = limitCheck?.reason
    if (reason === 'spending_limit_exceeded') {
      return json({
        error: "You've used all your AI Bucks for this month. Upgrade to keep going.",
        code: 'spending_limit_exceeded',
        spent_usd: Number(limitCheck.spent_usd) || 0,
        limit_usd: Number(limitCheck.limit_usd) || 0,
      }, 429)
    }
    if (reason === 'account_suspended') {
      return json({ error: 'Your account has been suspended.', code: 'account_suspended' }, 403)
    }
    return json({ error: 'Request not allowed: ' + (reason ?? 'unknown'), code: reason }, 403)
  }

  // ── Call OpenAI TTS ───────────────────────────────────────────────
  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) {
    return json({ error: 'OpenAI API key not configured' }, 503)
  }

  const startedAt = Date.now()
  let openaiRes
  try {
    openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        voice: voiceId,
        input: stepText,
        response_format: 'mp3',
      }),
    })
  } catch (err) {
    return json({ error: 'TTS provider unreachable' }, 502)
  }
  const durationMs = Date.now() - startedAt

  if (!openaiRes.ok) {
    const errText = await openaiRes.text().catch(() => '')
    console.error('[tts] OpenAI error', openaiRes.status, errText.slice(0, 500))
    return json({ error: 'TTS generation failed' }, 502)
  }

  const audioBuffer = await openaiRes.arrayBuffer()
  if (!audioBuffer.byteLength) {
    return json({ error: 'TTS returned empty audio' }, 502)
  }

  // ── Upload to Supabase Storage ────────────────────────────────────
  // Path is recipe-scoped so a recipe delete cascade can sweep them via
  // a future cleanup job. Filename includes the cache-key tuple so the
  // file itself is human-debuggable.
  const storagePath = `${recipeId}/v${instructionsVersion}/step${stepIndex}-s${servings}-${voiceId}.mp3`

  const { error: uploadErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, audioBuffer, {
      contentType: 'audio/mpeg',
      upsert: true,
    })
  if (uploadErr) {
    console.error('[tts] storage upload failed:', uploadErr.message)
    return json({ error: 'Failed to store audio' }, 500)
  }

  const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath)
  const mp3Url = pub?.publicUrl
  if (!mp3Url) {
    return json({ error: 'Failed to resolve audio URL' }, 500)
  }

  // ── Insert cache row ──────────────────────────────────────────────
  // ON CONFLICT DO NOTHING: if a concurrent request beat us to the same
  // cache key, fine — both rows have valid audio, the unique index keeps
  // us consistent, and the duplicate storage object gets cleaned up by
  // the next nightly sweep. (We could LRU and delete it now, but the
  // simpler path is fine.)
  const { error: insertErr } = await supabase
    .from('recipe_audio')
    .insert({
      recipe_id: recipeId,
      step_index: stepIndex,
      servings,
      voice_id: voiceId,
      instructions_version: instructionsVersion,
      mp3_url: mp3Url,
      storage_path: storagePath,
      char_count: stepText.length,
    })
  if (insertErr && !/duplicate key/i.test(insertErr.message || '')) {
    console.error('[tts] cache insert failed:', insertErr.message)
    // Non-fatal: the audio is uploaded and playable, the user just won't
    // hit the cache next time. Continue rather than failing.
  }

  // ── Record usage at TTS per-character rate ────────────────────────
  // Snapshot rate gets pulled by record_usage from the openai/tts-1-hd
  // pricing row (multi_provider_pricing.sql). Spend cap accumulates
  // across all providers via the unified cost_usd column.
  try {
    await supabase.rpc('record_usage', {
      p_user_id: user.id,
      p_model: OPENAI_MODEL,
      p_feature: 'cooking_mode_tts',
      p_input_tokens: null,
      p_output_tokens: null,
      p_action: voiceId,
      p_input_type: 'text',
      p_tools_used: null,
      p_duration_ms: durationMs,
      p_provider: 'openai',
      p_units_used: stepText.length,
      p_unit_type: 'characters',
    })
  } catch (err) {
    console.error('[tts] record_usage failed:', err?.message || err)
  }

  return json({ url: mp3Url, cached: false })
}

// ─────────────────────────────────────────────────────────────────────
// Speechify — converts a recipe step into TTS-friendly English, scaling
// quantities by servings on the way through. Strips HTML, expands unit
// abbreviations, spells fractions, and rephrases temperatures.
//
// Kept in sync with speechifyStepText() in src/pages/app.js. If you
// change either copy, change both.
// ─────────────────────────────────────────────────────────────────────
const UNIT_FORMS = {
  cup:['cup','cups'], cups:['cup','cups'],
  tbsp:['tablespoon','tablespoons'], tbsps:['tablespoon','tablespoons'],
  tablespoon:['tablespoon','tablespoons'], tablespoons:['tablespoon','tablespoons'],
  tsp:['teaspoon','teaspoons'], tsps:['teaspoon','teaspoons'],
  teaspoon:['teaspoon','teaspoons'], teaspoons:['teaspoon','teaspoons'],
  oz:['ounce','ounces'], ounce:['ounce','ounces'], ounces:['ounce','ounces'],
  lb:['pound','pounds'], lbs:['pound','pounds'],
  pound:['pound','pounds'], pounds:['pound','pounds'],
  g:['gram','grams'], kg:['kilogram','kilograms'],
  ml:['milliliter','milliliters'], l:['liter','liters'],
  liter:['liter','liters'], liters:['liter','liters'],
  litre:['liter','liters'], litres:['liter','liters'],
  clove:['clove','cloves'], cloves:['clove','cloves'],
  slice:['slice','slices'], slices:['slice','slices'],
  piece:['piece','pieces'], pieces:['piece','pieces'],
  can:['can','cans'], cans:['can','cans'],
  pint:['pint','pints'], pints:['pint','pints'],
  quart:['quart','quarts'], quarts:['quart','quarts'],
}
function phraseQty(q, unit, vowelStart) {
  const article = vowelStart ? 'an' : 'a'
  const r = Math.round(q * 4) / 4
  const whole = Math.floor(r)
  const frac = r - whole
  if (whole === 0 && frac === 0.5)  return `half ${article} ${unit}`
  if (whole === 0 && frac === 0.25) return `a quarter ${unit}`
  if (whole === 0 && frac === 0.75) return `three quarters of ${article} ${unit}`
  if (whole > 0  && frac === 0)     return `${whole} ${unit}`
  if (whole > 0  && frac === 0.5)   return `${whole} and a half ${unit}`
  if (whole > 0  && frac === 0.25)  return `${whole} and a quarter ${unit}`
  if (whole > 0  && frac === 0.75)  return `${whole} and three quarters ${unit}`
  return `${q} ${unit}`
}
function speechifyStepText(step, baseServings, targetServings) {
  if (!step) return ''
  let out = String(step).replace(/<[^>]*>/g, '')
  out = out.replace(/½/g, '0.5').replace(/¼/g, '0.25').replace(/¾/g, '0.75')
           .replace(/⅓/g, '0.333').replace(/⅔/g, '0.667')
  out = out.replace(/(\d+)\s*°\s*([FC])\b/g, (_, n, u) => `${n} degrees ${u === 'F' ? 'Fahrenheit' : 'Celsius'}`)
  const mult = (baseServings && targetServings) ? targetServings / baseServings : 1
  const re = /(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*(cups?|tbsps?|tablespoons?|tsps?|teaspoons?|oz|ounces?|lbs?|pounds?|\bg\b|kg|ml|l|liters?|litres?|cloves?|slices?|pieces?|cans?|pints?|quarts?)?/gi
  return out.replace(re, (match, qStr, uStr) => {
    let q
    const m = qStr.match(/^(\d+)\s+(\d+)\/(\d+)$/)
    if (m) q = parseInt(m[1], 10) + Number(m[2]) / Number(m[3])
    else if (qStr.includes('/')) { const [n, d] = qStr.split('/').map(Number); q = n / d }
    else q = parseFloat(qStr)
    if (!isFinite(q)) return match
    q = q * mult
    if (!uStr) return match
    const forms = UNIT_FORMS[uStr.toLowerCase()] || [uStr, uStr]
    const unit = forms[q !== 1 ? 1 : 0]
    return phraseQty(q, unit, /^[aeio]/i.test(unit))
  })
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  })
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}
