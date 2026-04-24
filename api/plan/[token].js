import { createClient } from '@supabase/supabase-js'

// Use service-role key so we can read published broadcasts regardless of
// RLS policies on provider_broadcasts. The is_published=true filter below
// is the actual security check — only published plans are ever returned.
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
)

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

function macroBar(label, val, color) {
  return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
    <div style="font-size:11px;color:#888;width:50px">${label}</div>
    <div style="flex:1;height:4px;background:#2a2a2a;border-radius:2px;overflow:hidden">
      <div style="height:100%;background:${color};border-radius:2px;width:${Math.min(100,val)}%"></div>
    </div>
    <div style="font-size:11px;color:#ccc;width:36px;text-align:right">${Math.round(val)}g</div>
  </div>`
}

export default async function handler(req, res) {
  const { token } = req.query

  // Config sanity check — if env vars aren't set, we'd silently return "not found"
  // forever. Return a 500 with a clear message so it's obvious what's wrong.
  if (!process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(500).send(`<!DOCTYPE html><html><body style="background:#0f0e0d;color:#fff;font-family:sans-serif;padding:40px;text-align:center">
      <div style="font-size:18px">Server config error</div>
      <div style="font-size:12px;color:#888;margin-top:8px">Supabase URL not configured</div>
    </body></html>`)
    return
  }

  // Fetch broadcast by share token
  const { data: broadcast, error } = await supabase
    .from('provider_broadcasts')
    .select('*')
    .eq('share_token', token)
    .eq('is_published', true)
    .maybeSingle()

  if (error) {
    // Surface the actual DB error to server logs so you can see what's wrong in Vercel
    console.error('[/api/plan/[token]] Supabase error:', { token, error })
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(500).send(`<!DOCTYPE html><html><body style="background:#0f0e0d;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="text-align:center"><div style="font-size:48px">⚠️</div><div style="font-size:18px;margin-top:16px">Something went wrong</div><div style="font-size:12px;color:#888;margin-top:8px">Please try again later</div></div>
    </body></html>`)
    return
  }

  if (!broadcast) {
    console.warn('[/api/plan/[token]] no broadcast found — token may be wrong or unpublished:', token)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(404).send(`<!DOCTYPE html><html><body style="background:#0f0e0d;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="text-align:center"><div style="font-size:48px">🍽️</div><div style="font-size:18px;margin-top:16px">Meal plan not found</div><div style="font-size:12px;color:#888;margin-top:8px">The link may have been removed or unpublished.</div></div>
    </body></html>`)
    return
  }

  // Fetch provider profile separately. user_profiles is keyed by user_id,
  // not id. Column-by-column selects with progressive fallback so missing
  // columns (older user_profiles schemas) don't blow up the whole request.
  let providerProfile = {}
  try {
    const { data: p } = await supabase
      .from('user_profiles')
      .select('provider_name, provider_specialty, provider_bio, provider_slug, provider_avatar_url')
      .eq('user_id', broadcast.provider_id)
      .maybeSingle()
    if (p) providerProfile = p
  } catch (e) {
    // Some columns may not exist on older schemas — retry with the minimal set
    try {
      const { data: p } = await supabase
        .from('user_profiles')
        .select('provider_name, provider_specialty')
        .eq('user_id', broadcast.provider_id)
        .maybeSingle()
      if (p) providerProfile = p
    } catch (e2) {
      console.warn('[/api/plan/[token]] could not fetch provider profile:', e2?.message)
    }
  }

  // Attach the profile under the same shape the rest of the template expects
  broadcast.user_profiles = providerProfile

  try {
    const provider = broadcast.user_profiles || {}
    const plan = Array.isArray(broadcast.plan_data) ? broadcast.plan_data : []

    // Parse week_start defensively — handle null, date-only, or full timestamp
    let weekStart = new Date()
    if (broadcast.week_start) {
      const ws = String(broadcast.week_start)
      weekStart = new Date(ws.includes('T') ? ws : ws + 'T12:00:00')
      if (isNaN(weekStart.getTime())) weekStart = new Date()
    }

    // Group meals by day — use explicit string keys so day_of_week=0 (Sunday)
    // isn't swallowed by the || fallback
    const byDay = {}
    plan.forEach(meal => {
      let key
      if (meal.actual_date) key = meal.actual_date
      else if (meal.day_of_week != null) key = `dow-${meal.day_of_week}`
      else key = 'unsorted'
      if (!byDay[key]) byDay[key] = []
      byDay[key].push(meal)
    })

    // Calculate weekly totals. Macros in meal rows are already the total
    // for planned_servings — do NOT multiply again. This matches how the
    // main planner/log display works.
    const totals = plan.reduce((acc, m) => {
      acc.calories += (m.calories || 0)
      acc.protein += (m.protein || 0)
      acc.carbs += (m.carbs || 0)
      acc.fat += (m.fat || 0)
      return acc
    }, { calories: 0, protein: 0, carbs: 0, fat: 0 })

    const appUrl = `https://personal-health-tracking.vercel.app`
    const shareUrl = `${appUrl}/api/plan/${token}`

    const dayKeys = Object.keys(byDay).sort()
    // Average per planned day, not always per 7. A 3-day plan shouldn't
    // show kcal/day divided by 7 (makes it look way lower than reality).
    const daysInPlan = Math.max(dayKeys.length, 1)

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(broadcast.title)} — MacroLens</title>
  <meta name="description" content="${esc(broadcast.description || `Weekly meal plan by ${provider.provider_name}`)}" />
  <meta property="og:title" content="${esc(broadcast.title)}" />
  <meta property="og:description" content="${esc(broadcast.description || `${plan.length} meals planned · by ${provider.provider_name}`)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${shareUrl}" />
  <meta name="theme-color" content="#0f0e0d" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { background: #0f0e0d; color: #f0ede8; font-family: 'DM Sans', -apple-system, sans-serif; min-height: 100vh; padding-bottom: 100px }
    .container { max-width: 640px; margin: 0 auto; padding: 0 16px }
    .header { padding: 24px 0 20px; border-bottom: 1px solid #222 }
    .logo { font-size: 12px; font-weight: 700; color: #E8C547; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 16px }
    .plan-title { font-size: 26px; font-weight: 700; color: #f0ede8; line-height: 1.2; margin-bottom: 6px }
    .plan-desc { font-size: 14px; color: #888; line-height: 1.5 }
    .provider-row { display: flex; align-items: center; gap: 10px; margin-top: 14px }
    .provider-avatar { width: 36px; height: 36px; background: rgba(76,175,130,0.2); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0 }
    .provider-name { font-size: 13px; font-weight: 600; color: #f0ede8 }
    .provider-spec { font-size: 11px; color: #4CAF82 }
    .week-label { font-size: 11px; color: #666; margin-top: 4px }
    .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 16px 0; border-bottom: 1px solid #222 }
    .stat { text-align: center; padding: 12px 8px; background: #161514; border-radius: 10px }
    .stat-val { font-size: 18px; font-weight: 700; margin-bottom: 2px }
    .stat-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px }
    .day-section { margin-top: 20px }
    .day-header { font-size: 12px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #1e1e1e }
    .meal-card { background: #161514; border-radius: 12px; padding: 14px; margin-bottom: 8px; border: 1px solid #222 }
    .meal-name { font-size: 14px; font-weight: 600; color: #f0ede8; margin-bottom: 4px }
    .meal-type { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px }
    .meal-macros { display: flex; gap: 6px; flex-wrap: wrap }
    .pill { font-size: 11px; padding: 3px 8px; border-radius: 20px; font-weight: 500 }
    .pill-cal { background: rgba(232,197,71,0.12); color: #E8C547 }
    .pill-p { background: rgba(76,175,130,0.12); color: #4CAF82 }
    .pill-c { background: rgba(91,156,246,0.12); color: #5B9CF6 }
    .pill-f { background: rgba(245,146,78,0.12); color: #F5924E }
    .servings { font-size: 11px; color: #555; margin-top: 4px }
    .cta { position: fixed; bottom: 0; left: 0; right: 0; background: linear-gradient(to top, #0f0e0d 80%, transparent); padding: 20px 16px 28px }
    .cta-inner { max-width: 640px; margin: 0 auto; display: flex; gap: 10px }
    .btn-primary { flex: 1; background: #E8C547; color: #1a1500; border: none; border-radius: 12px; padding: 14px; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; text-align: center; text-decoration: none; display: block }
    .btn-copy { flex-shrink: 0; background: #1e1e1e; color: #ccc; border: 1px solid #333; border-radius: 12px; padding: 14px 16px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; white-space: nowrap }
    .notes { margin-top: 12px; padding: 14px; background: #161514; border-radius: 10px; border: 1px solid #222; font-size: 13px; color: #888; line-height: 1.5 }
    .empty-day { padding: 12px; font-size: 12px; color: #444; text-align: center; font-style: italic }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">MacroLens</div>
      <div class="plan-title">${esc(broadcast.title)}</div>
      ${broadcast.description ? `<div class="plan-desc">${esc(broadcast.description)}</div>` : ''}
      <div class="provider-row">
        <div class="provider-avatar">
          ${provider.provider_avatar_url
            ? `<img src="${esc(provider.provider_avatar_url)}" alt="${esc(provider.provider_name || '')}" style="width:36px;height:36px;border-radius:50%;object-fit:cover" onerror="this.style.display='none'" />`
            : '🩺'}
        </div>
        <div>
          <div class="provider-name">${esc(provider.provider_name || 'Provider')}</div>
          <div class="provider-spec">${esc(provider.provider_specialty || 'Dietitian')}</div>
        </div>
        <div class="week-label" style="margin-left:auto">Week of ${weekStart.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}</div>
      </div>
    </div>

    <!-- Weekly totals -->
    <div class="stats-row">
      <div class="stat"><div class="stat-val" style="color:#E8C547">${Math.round(totals.calories / daysInPlan)}</div><div class="stat-label">kcal/day</div></div>
      <div class="stat"><div class="stat-val" style="color:#4CAF82">${Math.round(totals.protein / daysInPlan)}g</div><div class="stat-label">Protein</div></div>
      <div class="stat"><div class="stat-val" style="color:#5B9CF6">${Math.round(totals.carbs / daysInPlan)}g</div><div class="stat-label">Carbs</div></div>
      <div class="stat"><div class="stat-val" style="color:#F5924E">${Math.round(totals.fat / daysInPlan)}g</div><div class="stat-label">Fat</div></div>
    </div>

    <!-- Meals by day -->
    ${dayKeys.length ? dayKeys.map(key => {
      const meals = byDay[key]
      // key formats: 'YYYY-MM-DD' date, 'dow-N' day_of_week, or 'unsorted'
      const isDate = /^\d{4}-\d{2}-\d{2}$/.test(key)
      const isDow = key.startsWith('dow-')
      const dayLabel = isDate
        ? new Date(key + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
        : isDow
          ? (DAYS[parseInt(key.slice(4))] || key)
          : 'Other'

      return `<div class="day-section">
        <div class="day-header">${esc(dayLabel)}</div>
        ${meals.map(m => {
          const srv = m.planned_servings || 1
          // Macros are already totals for the planned servings — don't multiply
          const cal = Math.round(m.calories || 0)
          const pro = Math.round(m.protein || 0)
          const car = Math.round(m.carbs || 0)
          const fat = Math.round(m.fat || 0)
          const mealTypeLabels = { breakfast: '🌅 Breakfast', lunch: '☀️ Lunch', snack: '🍎 Snack', dinner: '🌙 Dinner' }
          const typeLabel = mealTypeLabels[m.meal_type] || ''
          // Pull meal name from the common shapes used by broadcasts
          const mealName = m.meal_name || m.recipe_name || m.name || 'Meal'
          return `<div class="meal-card">
            ${typeLabel ? `<div class="meal-type">${typeLabel}</div>` : ''}
            <div class="meal-name">${esc(mealName)}</div>
            <div class="meal-macros">
              <span class="pill pill-cal">${cal} kcal</span>
              <span class="pill pill-p">${pro}g P</span>
              <span class="pill pill-c">${car}g C</span>
              <span class="pill pill-f">${fat}g F</span>
            </div>
            ${srv !== 1 ? `<div class="servings">${srv} serving${srv !== 1 ? 's' : ''}</div>` : ''}
          </div>`
        }).join('')}
      </div>`
    }).join('') : `<div style="padding:40px 0;text-align:center;color:#444">No meals added yet</div>`}

    ${broadcast.notes ? `<div class="notes">📝 ${esc(broadcast.notes)}</div>` : ''}
  </div>

  <!-- Sticky CTA -->
  <div class="cta">
    <div class="cta-inner">
      <a href="${appUrl}" class="btn-primary">📲 Add to my meal plan</a>
      <button class="btn-copy" onclick="sharePlan()">↗ Share</button>
    </div>
  </div>

  <script>
    // Native share sheet when available (iOS/Android), clipboard fallback
    // otherwise. Title only — no text field, since iOS Copy action would
    // grab the text instead of the URL.
    async function sharePlan() {
      const url = ${JSON.stringify(shareUrl)}
      const title = ${JSON.stringify(broadcast.title || 'Meal plan')}
      if (navigator.share) {
        try { await navigator.share({ title, url }); return }
        catch (err) { if (err && err.name === 'AbortError') return }
      }
      try {
        await navigator.clipboard.writeText(url)
        const btn = document.querySelector('.btn-copy')
        btn.textContent = '✓ Copied!'
        setTimeout(() => btn.textContent = '↗ Share', 2000)
      } catch {}
    }
  </script>
</body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    res.status(200).send(html)
  } catch (renderErr) {
    console.error('[/api/plan/[token]] render error:', {
      token,
      message: renderErr?.message,
      stack: renderErr?.stack?.split('\n').slice(0, 5).join('\n'),
      broadcastId: broadcast?.id,
      week_start: broadcast?.week_start,
      plan_data_type: typeof broadcast?.plan_data,
      plan_data_length: Array.isArray(broadcast?.plan_data) ? broadcast.plan_data.length : 'not array',
    })
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(500).send(`<!DOCTYPE html><html><body style="background:#0f0e0d;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="text-align:center"><div style="font-size:48px">⚠️</div><div style="font-size:18px;margin-top:16px">Couldn't render this plan</div><div style="font-size:12px;color:#888;margin-top:8px">Details logged — please contact the provider.</div></div>
    </body></html>`)
  }
}
