/**
 * Vercel Edge Function: /api/analyze
 *
 * Validates the user's Supabase JWT, checks their spend limit,
 * calls Anthropic with the server-side API key, records usage,
 * and returns the result. The Anthropic key never reaches the browser.
 */

import { createClient } from '@supabase/supabase-js'

export const config = { runtime: 'edge' }

const ANTHROPIC_MODEL = 'claude-sonnet-4-5'

// Pricing per 1M tokens — must match model_pricing table
const PRICING = {
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5':  { input: 0.80, output: 4.00 },
  'claude-opus-4-5':   { input: 15.00, output: 75.00 },
}

function estimateCost(model, inputTokens, outputTokens) {
  const p = PRICING[model] ?? PRICING[ANTHROPIC_MODEL]
  return (inputTokens * p.input / 1_000_000) + (outputTokens * p.output / 1_000_000)
}

export default async function handler(req) {
  // ── CORS ──────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: cors()
    })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  // ── Auth: validate Supabase JWT ───────────────────────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization header' }, 401)
  }

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )

  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) {
    return json({ error: 'Invalid or expired session' }, 401)
  }

  // ── Parse request body ────────────────────────────────────────────
  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { feature, messages, tools, max_tokens = 2000, action, input_type } = body
  const clampedTokens = Math.min(max_tokens, 4000)

  if (!feature || !messages) {
    return json({ error: 'Missing required fields: feature, messages' }, 400)
  }

  // ── Spend limit check ─────────────────────────────────────────────
  const estimatedCost = estimateCost(ANTHROPIC_MODEL, 1000, 500)
  const { data: limitCheck } = await supabase.rpc('check_spend_limit', {
    p_user_id: user.id,
    p_estimated_cost: estimatedCost
  })

  if (!limitCheck?.allowed) {
    const reason = limitCheck?.reason
    if (reason === 'spending_limit_exceeded') {
      // Return structured error payload — the client intercepts this and
      // renders a proper upgrade modal. Message string is a fallback for
      // any older clients that haven't been updated to render the modal.
      return json({
        error: "You've used all your Computer Calories for this month. Upgrade to keep going.",
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

  // ── Call Anthropic ────────────────────────────────────────────────
  const anthropicBody = {
    model: ANTHROPIC_MODEL,
    max_tokens: clampedTokens,
    messages,
    ...(tools ? { tools } : {})
  }

  // Wall-clock time tracking, so we can later diagnose slow/stuck calls
  // (e.g. tool-use loops that silently retry). Measured around the fetch
  // only, not the usage-recording step below — that's not what the user
  // actually waits for.
  const startedAt = Date.now()
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody)
  })
  const durationMs = Date.now() - startedAt

  const anthropicData = await anthropicRes.json()

  if (anthropicData.error) {
    return json({ error: anthropicData.error.message }, 502)
  }

  // ── Record actual usage ───────────────────────────────────────────
  const inputTokens = anthropicData.usage?.input_tokens ?? 0
  const outputTokens = anthropicData.usage?.output_tokens ?? 0

  // Extract which tools were actually invoked by the model during this
  // request. Anthropic returns tool use blocks in `content` with type
  // 'tool_use'. web_search in particular is a big cost driver because
  // it expands into multiple under-the-hood requests.
  const toolsUsed = Array.isArray(anthropicData.content)
    ? [...new Set(
        anthropicData.content
          .filter(b => b?.type === 'tool_use' && b.name)
          .map(b => b.name)
      )]
    : []

  // Fire-and-forget. Failing to record usage is a non-fatal annoyance
  // (we lose visibility on one call) but should never fail the whole
  // user request. Previously this was awaited; keeping await but catching
  // so a DB hiccup doesn't surface as an API error.
  try {
    await supabase.rpc('record_usage', {
      p_user_id: user.id,
      p_model: ANTHROPIC_MODEL,
      p_feature: feature,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_action: action ?? null,
      p_input_type: input_type ?? null,
      p_tools_used: toolsUsed.length ? toolsUsed : null,
      p_duration_ms: durationMs
    })
  } catch (err) {
    console.error('[analyze] record_usage failed:', err?.message || err)
  }

  // ── Return result ─────────────────────────────────────────────────
  return json(anthropicData)
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() }
  })
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}
