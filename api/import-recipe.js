/**
 * Vercel Edge Function: /api/import-recipe
 *
 * Multi-tier fallback chain for importing recipes from a URL or dish-name
 * search. Replaces the single-tier `analyze_dish_by_search` action of
 * /api/analyze, which was timing out (504) on heavy JS sites like
 * foodnetwork.com because Anthropic's web_search tool can take 30-60s
 * end-to-end and Vercel's default function timeout is 10s.
 *
 *   Tier 1 (≤25s):  Direct fetch + browser User-Agent.
 *                   • If a JSON-LD Recipe block is found in the HTML,
 *                     normalize it via Claude (very cheap call).
 *                   • Otherwise strip HTML to visible text and pass to
 *                     Claude for extraction.
 *   Tier 2 (≤20s):  r.jina.ai reader-mode proxy. Returns clean markdown
 *                   that strips ads / JS / heavy chrome — works on most
 *                   JS-rendered sites where direct fetch fails. No API
 *                   key required.
 *   Tier 3 (≤15s):  Anthropic web_search tool. Slowest but most flexible
 *                   — Claude's server-side fetch can navigate sites
 *                   that block our outbound IP or require JS.
 *   Tier 4 (fail):  Structured failure with code:'import_failed' so the
 *                   client can render a "Take a photo instead" deep link
 *                   without trying to parse the message string.
 *
 * Total budget capped at maxDuration=60s so Vercel doesn't kill us mid-
 * tier. Each tier wraps fetch + Anthropic call in its own AbortController
 * so a hung tier1 doesn't eat tier2's budget.
 *
 * Both web (src/lib/ai.js analyzeDishBySearch) and iOS
 * (AnalyzeService.analyzeDishBySearch) are migrated to call this endpoint
 * instead of /api/analyze with the web_search action.
 */

import { createClient } from '@supabase/supabase-js'

export const config = { runtime: 'edge' }
// Vercel function timeout cap — sum of per-tier budgets fits comfortably.
export const maxDuration = 60

const ANTHROPIC_MODEL = 'claude-sonnet-4-5'
const PRICING = {
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5':  { input: 0.80, output: 4.00 },
  'claude-opus-4-5':   { input: 15.00, output: 75.00 },
}

// Real-browser User-Agent so anti-scraping doesn't immediately block us.
// Most recipe sites don't actually care, but a few (Food Network being one)
// return slow / partial responses to obvious bots.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const TIER1_TIMEOUT_MS = 25_000
const TIER2_TIMEOUT_MS = 20_000
const TIER3_TIMEOUT_MS = 15_000

// Recipe-extraction prompt — same shape as src/lib/ai.js FULL_ANALYSIS_PROMPT
// so AnalysisResult / RecipeFull decoders keep working without changes.
const RECIPE_EXTRACTION_PROMPT = `Respond ONLY with a JSON object, no markdown, no explanation. Format:
{
  "name": "recipe name",
  "description": "one line description",
  "servings": number,
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "fiber": number,
  "sugar": number,
  "confidence": "low|medium|high",
  "ingredients": [
    {"name":"ingredient name","amount":number,"unit":"oz/lbs/cups/tbsp/tsp/cloves/whole/slices","category":"produce|protein|dairy|pantry|spices|grains|frozen|bakery|beverages"}
  ]
}

Rules:
- amount must be a NUMBER (not a string)
- category required on every ingredient: produce|protein|dairy|pantry|spices|grains|frozen|bakery|beverages
- Macros are PER SERVING. If not stated explicitly, estimate based on the ingredient list and serving count.
- If servings isn't stated, infer a reasonable number from ingredient quantities (e.g. 1 lb ground beef → ~4 servings).
- Extract every ingredient.`

function estimateCost(model, ti, to) {
  const p = PRICING[model] ?? PRICING[ANTHROPIC_MODEL]
  return (ti * p.input / 1_000_000) + (to * p.output / 1_000_000)
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() }
  })
}

const TIER4_MESSAGE = "We couldn't read this site automatically. Try a photo of the recipe instead — works on cookbook pages, screenshots, or anything visible."

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // ── Auth ──────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Missing authorization header' }, 401)

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return json({ error: 'Invalid or expired session' }, 401)

  // ── Parse body ────────────────────────────────────────────────────
  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const url = String(body.url || '').trim()
  const dishName = String(body.dish_name || '').trim()
  if (!url && !dishName) return json({ error: 'Need a URL or a dish name' }, 400)

  // ── Spend limit check (one cost gate covers the whole tier walk) ──
  const estimatedCost = estimateCost(ANTHROPIC_MODEL, 2000, 1500)
  const { data: limitCheck } = await supabase.rpc('check_spend_limit', {
    p_user_id: user.id,
    p_estimated_cost: estimatedCost,
  })
  if (!limitCheck?.allowed) {
    if (limitCheck?.reason === 'spending_limit_exceeded') {
      return json({
        error: "You've used all your Computer Calories for this month. Upgrade to keep going.",
        code: 'spending_limit_exceeded',
        spent_usd: Number(limitCheck.spent_usd) || 0,
        limit_usd: Number(limitCheck.limit_usd) || 0,
      }, 429)
    }
    if (limitCheck?.reason === 'account_suspended') {
      return json({ error: 'Your account has been suspended.', code: 'account_suspended' }, 403)
    }
    return json({ error: 'Request not allowed', code: limitCheck?.reason }, 403)
  }

  // No URL → web_search by dish name only (Tier 3 only path).
  if (!url) {
    try {
      const r = await tryTier3WebSearch(dishName, null, supabase, user.id)
      if (r.ok) return json({ recipe: r.recipe, tier: 3 })
    } catch (e) {
      console.warn('[import-recipe] tier3-only failed:', e?.message)
    }
    return json({ error: TIER4_MESSAGE, code: 'import_failed', tier_failed: 3 }, 502)
  }

  // ── Tier 1: Direct fetch ──────────────────────────────────────────
  try {
    const r = await tryTier1DirectFetch(url, dishName, supabase, user.id)
    if (r.ok) return json({ recipe: r.recipe, tier: 1, ...(r.via ? { via: r.via } : {}) })
  } catch (e) {
    console.warn('[import-recipe] tier1 failed:', e?.message)
  }

  // ── Tier 2: r.jina.ai reader-mode proxy ───────────────────────────
  try {
    const r = await tryTier2JinaProxy(url, dishName, supabase, user.id)
    if (r.ok) return json({ recipe: r.recipe, tier: 2 })
  } catch (e) {
    console.warn('[import-recipe] tier2 failed:', e?.message)
  }

  // ── Tier 3: Anthropic web_search ──────────────────────────────────
  try {
    const r = await tryTier3WebSearch(dishName || url, url, supabase, user.id)
    if (r.ok) return json({ recipe: r.recipe, tier: 3 })
  } catch (e) {
    console.warn('[import-recipe] tier3 failed:', e?.message)
  }

  // ── Tier 4: structured failure ────────────────────────────────────
  return json({
    error: TIER4_MESSAGE,
    code: 'import_failed',
    tier_failed: 4,
    suggested_action: 'photo',
  }, 502)
}

// ── Tier 1: direct fetch + JSON-LD or stripped text → Claude ─────────

async function tryTier1DirectFetch(url, dishName, supabase, userId) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort('tier1-timeout'), TIER1_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()

    // Fast path: JSON-LD Recipe schema. Many recipe sites publish it
    // (Food Network, AllRecipes, NYT Cooking, etc.). Parsing structured
    // data is more reliable than extracting from prose, and the Claude
    // call is much cheaper because the input is small.
    const jsonLd = extractRecipeJsonLd(html)
    if (jsonLd) {
      const recipe = await callClaudeForRecipe(
        jsonLdToText(jsonLd, dishName), supabase, userId, 'import_recipe_tier1_jsonld', TIER1_TIMEOUT_MS
      )
      if (recipe) return { ok: true, recipe, via: 'json-ld' }
    }

    // Slow path: strip HTML to visible text and let Claude figure it out.
    const text = htmlToText(html, 12000)
    if (!text || text.length < 200) throw new Error('No usable text in HTML')
    const recipe = await callClaudeForRecipe(
      text, supabase, userId, 'import_recipe_tier1_html', TIER1_TIMEOUT_MS
    )
    if (!recipe) throw new Error('Claude returned no recipe')
    return { ok: true, recipe, via: 'html' }
  } finally {
    clearTimeout(timer)
  }
}

// ── Tier 2: r.jina.ai reader-mode proxy ──────────────────────────────

async function tryTier2JinaProxy(url, dishName, supabase, userId) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort('tier2-timeout'), TIER2_TIMEOUT_MS)
  try {
    // r.jina.ai accepts the target URL as a path component. Free, no
    // API key. Returns markdown that's already stripped of ads/JS/etc.
    const target = url.startsWith('http') ? url : `https://${url}`
    const proxied = `https://r.jina.ai/${target}`
    const res = await fetch(proxied, {
      headers: { 'Accept': 'text/markdown,text/plain,*/*' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`Jina HTTP ${res.status}`)
    const md = await res.text()
    if (!md || md.length < 200) throw new Error('Jina returned empty markdown')
    // Cap at 12KB — recipes don't need more than that.
    const trimmed = md.slice(0, 12000)
    const hint = dishName ? `Dish hint: ${dishName}\n\n` : ''
    const recipe = await callClaudeForRecipe(
      hint + trimmed, supabase, userId, 'import_recipe_tier2_jina', TIER2_TIMEOUT_MS
    )
    if (!recipe) throw new Error('Claude returned no recipe')
    return { ok: true, recipe }
  } finally {
    clearTimeout(timer)
  }
}

// ── Tier 3: Anthropic web_search ─────────────────────────────────────

async function tryTier3WebSearch(dishOrUrl, url, supabase, userId) {
  const query = url
    ? `Search for the recipe "${dishOrUrl}" from this URL: ${url}. Find the full ingredient list and serving size.`
    : `Search for the recipe "${dishOrUrl}". Find the full ingredient list and serving size.`
  const result = await callAnthropic({
    model: ANTHROPIC_MODEL,
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `${query}\n\nAfter searching, return ONLY a JSON object with the macros per serving and full ingredient list. ${RECIPE_EXTRACTION_PROMPT}`,
    }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }, supabase, userId, 'import_recipe_tier3_websearch', TIER3_TIMEOUT_MS)
  if (!result.ok) throw new Error(result.error || 'tier3 failed')
  const recipe = parseRecipeJSON(result.text)
  if (!recipe) throw new Error('No recipe in response')
  return { ok: true, recipe }
}

// ── Anthropic call helper ────────────────────────────────────────────

async function callClaudeForRecipe(text, supabase, userId, action, timeoutMs) {
  const result = await callAnthropic({
    model: ANTHROPIC_MODEL,
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `Extract the recipe from this content:\n\n${text}\n\n${RECIPE_EXTRACTION_PROMPT}`,
    }],
  }, supabase, userId, action, timeoutMs)
  if (!result.ok) return null
  return parseRecipeJSON(result.text)
}

async function callAnthropic(body, supabase, userId, action, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(`anthropic-timeout-${action}`), timeoutMs)
  const startedAt = Date.now()
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const data = await res.json()
    const durationMs = Date.now() - startedAt

    if (data.error) return { ok: false, error: data.error.message }
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('')

    // Record usage so the per-tier costs show up in spend tracking the
    // same way other Anthropic calls do.
    const inputTokens = data.usage?.input_tokens ?? 0
    const outputTokens = data.usage?.output_tokens ?? 0
    const toolsUsed = (data.content || [])
      .filter(b => b?.type === 'tool_use')
      .map(b => b.name)
      .filter(Boolean)
    try {
      await supabase.rpc('record_usage', {
        p_user_id: userId,
        p_model: body.model,
        p_feature: 'recipe',
        p_input_tokens: inputTokens,
        p_output_tokens: outputTokens,
        p_action: action,
        p_input_type: 'text',
        p_tools_used: toolsUsed.length ? toolsUsed : null,
        p_duration_ms: durationMs,
      })
    } catch (err) {
      console.error('[import-recipe] record_usage failed:', err?.message || err)
    }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, error: e?.message || 'anthropic call failed' }
  } finally {
    clearTimeout(timer)
  }
}

// ── HTML / JSON-LD parsing helpers ───────────────────────────────────

// Walk every <script type="application/ld+json"> block in the HTML and
// return the first Recipe object found (handles nested @graph and array-
// shaped @type). Many recipe sites publish this — it's the most reliable
// extraction source when present.
function extractRecipeJsonLd(html) {
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    let obj
    try { obj = JSON.parse(m[1].trim()) } catch { continue }
    const recipe = findRecipeInGraph(obj)
    if (recipe) return recipe
  }
  return null
}

function findRecipeInGraph(obj) {
  if (!obj || typeof obj !== 'object') return null
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findRecipeInGraph(item)
      if (r) return r
    }
    return null
  }
  const t = obj['@type']
  if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return obj
  if (obj['@graph']) return findRecipeInGraph(obj['@graph'])
  return null
}

// Render the JSON-LD Recipe object as plain text the model can parse
// without re-discovering the structure. Includes the dishName hint
// because some sites name recipes generically.
function jsonLdToText(recipe, dishName) {
  const lines = []
  if (recipe.name) lines.push(`Recipe: ${recipe.name}`)
  if (dishName && dishName !== recipe.name) lines.push(`Hint: ${dishName}`)
  if (recipe.description) lines.push(`Description: ${recipe.description}`)
  if (recipe.recipeYield) {
    lines.push(`Yields: ${Array.isArray(recipe.recipeYield) ? recipe.recipeYield[0] : recipe.recipeYield}`)
  }
  if (Array.isArray(recipe.recipeIngredient)) {
    lines.push('\nIngredients:')
    for (const i of recipe.recipeIngredient) lines.push(`- ${i}`)
  }
  if (recipe.recipeInstructions) {
    lines.push('\nInstructions:')
    const steps = Array.isArray(recipe.recipeInstructions) ? recipe.recipeInstructions : [recipe.recipeInstructions]
    for (const s of steps) {
      const t = typeof s === 'string' ? s : (s?.text || '')
      if (t) lines.push(`- ${t}`)
    }
  }
  if (recipe.nutrition && typeof recipe.nutrition === 'object') {
    lines.push('\nNutrition (from site):')
    for (const k of Object.keys(recipe.nutrition)) {
      const v = recipe.nutrition[k]
      if (typeof v === 'string' || typeof v === 'number') {
        lines.push(`- ${k}: ${v}`)
      }
    }
  }
  return lines.join('\n')
}

// Strip scripts/styles/svg/head from HTML and return visible text. Caps
// length so we don't blow Claude's context with megabytes of HTML.
// Decodes the few HTML entities common in recipe pages — we don't need
// a full entity table for body text extraction.
function htmlToText(html, maxLen) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.slice(0, maxLen)
}

// Pull the outermost JSON object from a model response. Same defensive
// parsing the client uses — handles markdown fences, leading prose, and
// trailing commas the model occasionally emits.
function parseRecipeJSON(text) {
  if (!text) return null
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < start) return null
  const candidate = cleaned.slice(start, end + 1)
  try { return JSON.parse(candidate) } catch {}
  // Defensive: trailing commas in arrays are a common Claude gotcha.
  try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')) } catch {}
  return null
}
