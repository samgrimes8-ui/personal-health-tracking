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

  const { feature, messages, tools, max_tokens = 1500 } = body

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
      return json({
        error: `Monthly spending limit reached ($${Number(limitCheck.limit_usd).toFixed(2)}). ` +
               `You've used $${Number(limitCheck.spent_usd).toFixed(4)} this month. ` +
               `Resets on the 1st.`
      }, 429)
    }
    if (reason === 'account_suspended') {
      return json({ error: 'Your account has been suspended.' }, 403)
    }
    return json({ error: 'Request not allowed: ' + (reason ?? 'unknown') }, 403)
  }

  // ── Call Anthropic ────────────────────────────────────────────────
  const anthropicBody = {
    model: ANTHROPIC_MODEL,
    max_tokens,
    messages,
    ...(tools ? { tools } : {})
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody)
  })

  const anthropicData = await anthropicRes.json()

  if (anthropicData.error) {
    return json({ error: anthropicData.error.message }, 502)
  }

  // ── Record actual usage ───────────────────────────────────────────
  const inputTokens = anthropicData.usage?.input_tokens ?? 0
  const outputTokens = anthropicData.usage?.output_tokens ?? 0

  await supabase.rpc('record_usage', {
    p_user_id: user.id,
    p_model: ANTHROPIC_MODEL,
    p_feature: feature,
    p_input_tokens: inputTokens,
    p_output_tokens: outputTokens
  })

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
