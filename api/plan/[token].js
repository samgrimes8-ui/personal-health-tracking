import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
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

  // Fetch broadcast by share token (anon key, public)
  const { data: broadcast, error } = await supabase
    .from('provider_broadcasts')
    .select('*, user_profiles!provider_id(provider_name, provider_specialty, provider_bio, provider_slug)')
    .eq('share_token', token)
    .eq('is_published', true)
    .maybeSingle()

  if (error || !broadcast) {
    res.status(404).send(`<!DOCTYPE html><html><body style="background:#0f0e0d;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="text-align:center"><div style="font-size:48px">🍽️</div><div style="font-size:18px;margin-top:16px">Meal plan not found</div></div>
    </body></html>`)
    return
  }

  const provider = broadcast.user_profiles || {}
  const plan = broadcast.plan_data || []
  const weekStart = new Date(broadcast.week_start + 'T12:00:00')

  // Group meals by day
  const byDay = {}
  plan.forEach(meal => {
    const key = meal.actual_date || meal.day_of_week
    if (!byDay[key]) byDay[key] = []
    byDay[key].push(meal)
  })

  // Calculate weekly totals
  const totals = plan.reduce((acc, m) => {
    const cal = (m.calories || 0) * (m.planned_servings || 1)
    acc.calories += cal
    acc.protein += (m.protein || 0) * (m.planned_servings || 1)
    acc.carbs += (m.carbs || 0) * (m.planned_servings || 1)
    acc.fat += (m.fat || 0) * (m.planned_servings || 1)
    return acc
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 })

  const appUrl = `https://personal-health-tracking.vercel.app`
  const shareUrl = `${appUrl}/api/plan/${token}`

  const dayKeys = Object.keys(byDay).sort()

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
        <div class="provider-avatar">🩺</div>
        <div>
          <div class="provider-name">${esc(provider.provider_name || 'Provider')}</div>
          <div class="provider-spec">${esc(provider.provider_specialty || 'Dietitian')}</div>
        </div>
        <div class="week-label" style="margin-left:auto">Week of ${weekStart.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}</div>
      </div>
    </div>

    <!-- Weekly totals -->
    <div class="stats-row">
      <div class="stat"><div class="stat-val" style="color:#E8C547">${Math.round(totals.calories / 7)}</div><div class="stat-label">kcal/day</div></div>
      <div class="stat"><div class="stat-val" style="color:#4CAF82">${Math.round(totals.protein / 7)}g</div><div class="stat-label">Protein</div></div>
      <div class="stat"><div class="stat-val" style="color:#5B9CF6">${Math.round(totals.carbs / 7)}g</div><div class="stat-label">Carbs</div></div>
      <div class="stat"><div class="stat-val" style="color:#F5924E">${Math.round(totals.fat / 7)}g</div><div class="stat-label">Fat</div></div>
    </div>

    <!-- Meals by day -->
    ${dayKeys.length ? dayKeys.map(key => {
      const meals = byDay[key]
      // key might be a date string or day_of_week number
      const isDate = key.includes('-')
      const dayLabel = isDate
        ? new Date(key + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
        : (DAYS[parseInt(key)] || key)

      return `<div class="day-section">
        <div class="day-header">${esc(dayLabel)}</div>
        ${meals.map(m => {
          const srv = m.planned_servings || 1
          const cal = Math.round((m.calories || 0) * srv)
          const pro = Math.round((m.protein || 0) * srv)
          const car = Math.round((m.carbs || 0) * srv)
          const fat = Math.round((m.fat || 0) * srv)
          const mealTypeLabels = { breakfast: '🌅 Breakfast', lunch: '☀️ Lunch', snack: '🍎 Snack', dinner: '🌙 Dinner' }
          const typeLabel = mealTypeLabels[m.meal_type] || ''
          return `<div class="meal-card">
            ${typeLabel ? `<div class="meal-type">${typeLabel}</div>` : ''}
            <div class="meal-name">${esc(m.recipe_name || m.name || 'Meal')}</div>
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
      <button class="btn-copy" onclick="copyLink()">🔗 Copy link</button>
    </div>
  </div>

  <script>
    function copyLink() {
      navigator.clipboard.writeText('${shareUrl}').then(() => {
        const btn = document.querySelector('.btn-copy')
        btn.textContent = '✓ Copied!'
        setTimeout(() => btn.textContent = '🔗 Copy link', 2000)
      })
    }
  </script>
</body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  res.status(200).send(html)
}
