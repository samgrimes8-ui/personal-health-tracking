/**
 * /api/health-sync
 *
 * Webhook for iOS Shortcuts to POST weight/health data to MacroLens.
 * Accepts either:
 *   - A single reading: { weight_lbs, date, source }
 *   - A batch: { readings: [{ weight_lbs, date }], source }
 *
 * Auth: user_id + api_key (a simple token stored in user_profiles)
 * The Shortcut sends: { user_id, api_key, weight_lbs, date }
 */

import { createClient } from '@supabase/supabase-js'

export const config = { runtime: 'edge' }

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { user_id, api_key, weight_lbs, date, readings, source = 'apple_health' } = body

  if (!user_id || !api_key) {
    return json({ error: 'user_id and api_key required' }, 401)
  }

  // Validate api_key against user_profiles
  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles')
    .select('user_id, health_sync_key')
    .eq('user_id', user_id)
    .eq('health_sync_key', api_key)
    .maybeSingle()

  if (profileErr || !profile) {
    return json({ error: 'Invalid credentials' }, 401)
  }

  // Build list of readings to upsert
  const toInsert = []

  if (readings && Array.isArray(readings)) {
    // Batch import
    for (const r of readings) {
      if (!r.weight_lbs || !r.date) continue
      toInsert.push(buildCheckin(user_id, r.weight_lbs, r.date, source))
    }
  } else if (weight_lbs && date) {
    // Single reading
    toInsert.push(buildCheckin(user_id, weight_lbs, date, source))
  } else {
    return json({ error: 'weight_lbs and date required' }, 400)
  }

  if (!toInsert.length) {
    return json({ error: 'No valid readings provided' }, 400)
  }

  // Upsert — conflict on (user_id, checked_in_at date)
  const { error: insertErr } = await supabase
    .from('checkins')
    .upsert(toInsert, {
      onConflict: 'user_id,checked_in_at',
      ignoreDuplicates: false
    })

  if (insertErr) {
    console.error('health-sync insert error:', insertErr)
    return json({ error: 'Failed to save' }, 500)
  }

  return json({
    ok: true,
    saved: toInsert.length,
    message: `Saved ${toInsert.length} reading${toInsert.length > 1 ? 's' : ''}`
  })
}

function buildCheckin(user_id, weight_lbs, date, source) {
  const weight_kg = +(parseFloat(weight_lbs) / 2.20462).toFixed(2)
  // Normalize date to ISO timestamp at noon to avoid timezone shifts
  const checked_in_at = date.includes('T') ? date : `${date}T12:00:00Z`
  return {
    user_id,
    weight_kg,
    checked_in_at,
    source: source || 'apple_health',
    notes: `Auto-synced from ${source || 'Apple Health'}`
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  })
}
