// Public landing page for personal meal-plan shares.
//
// Distinct from /api/plan/[token].js (which serves provider broadcasts):
// no provider branding, no follow flow, just "here's the week — copy it
// or don't." The CTA deep-links into the app at /?share=<token> so the
// app's authenticated copy modal can pick up the token.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY
)

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

export default async function handler(req, res) {
  const { token } = req.query

  if (!process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(500).send('<h1>Server config error</h1>')
    return
  }

  const { data: share, error } = await supabase
    .from('meal_plan_shares')
    .select('*')
    .eq('share_token', token)
    .eq('is_active', true)
    .maybeSingle()

  if (error) {
    console.error('[/api/share/[token]] db error:', { token, error })
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(500).send(`<!DOCTYPE html><html><body style="background:#0f0e0d;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="text-align:center"><div style="font-size:48px">⚠️</div><div style="font-size:18px;margin-top:16px">Something went wrong</div></div>
    </body></html>`)
    return
  }

  if (!share) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(404).send(`<!DOCTYPE html><html><body style="background:#0f0e0d;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div style="text-align:center"><div style="font-size:48px">🍽️</div><div style="font-size:18px;margin-top:16px">This share is no longer active</div><div style="font-size:12px;color:#888;margin-top:8px">The owner may have revoked the link.</div></div>
    </body></html>`)
    return
  }

  // Owner display name. We deliberately don't expose the email — fall back
  // to a generic "Someone" if no public-safe name is available. The owner
  // can label their share with a custom name at share time, which we use
  // when present (e.g., "Sam's meal plan").
  let ownerName = 'Someone'
  try {
    const { data: prof } = await supabase
      .from('user_profiles')
      .select('provider_name')
      .eq('user_id', share.owner_user_id)
      .maybeSingle()
    if (prof?.provider_name) ownerName = prof.provider_name
  } catch {}

  try {
    const plan = Array.isArray(share.plan_data) ? share.plan_data : []
    const weekStart = share.week_start ? new Date(share.week_start + 'T12:00:00') : new Date()
    const title = share.label || `${ownerName}'s meal plan`

    // Group meals by day_of_week (we always have it on personal shares).
    const byDay = {}
    plan.forEach(m => {
      const key = m.day_of_week ?? 0
      if (!byDay[key]) byDay[key] = []
      byDay[key].push(m)
    })
    const dayKeys = Object.keys(byDay).map(Number).sort((a, b) => a - b)

    const totals = plan.reduce((acc, m) => {
      const s = m.recipe_snapshot || {}
      acc.calories += Number(s.calories || 0)
      acc.protein  += Number(s.protein  || 0)
      acc.carbs    += Number(s.carbs    || 0)
      acc.fat      += Number(s.fat      || 0)
      return acc
    }, { calories: 0, protein: 0, carbs: 0, fat: 0 })

    const appUrl = `https://personal-health-tracking.vercel.app`
    const shareUrl = `${appUrl}/api/share/${token}`
    const copyUrl = `${appUrl}/?share=${encodeURIComponent(token)}`
    const daysInPlan = Math.max(dayKeys.length, 1)

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — MacroLens</title>
  <meta name="description" content="A meal plan shared with you${ownerName !== 'Someone' ? ` by ${esc(ownerName)}` : ''}." />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${plan.length} meals · shared via MacroLens" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${shareUrl}" />
  <meta name="theme-color" content="#0f0e0d" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { background: #0f0e0d; color: #f0ede8; font-family: 'DM Sans', -apple-system, sans-serif; min-height: 100vh; padding-bottom: 100px }
    .container { max-width: 640px; margin: 0 auto; padding: 0 16px }
    .header { padding: 24px 0 20px; border-bottom: 1px solid #222 }
    .logo { font-size: 12px; font-weight: 700; color: #E8C547; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 16px }
    .badge { display: inline-block; font-size: 10px; padding: 3px 9px; border-radius: 999px; background: rgba(135,189,240,0.15); color: #87bdf0; border: 1px solid rgba(135,189,240,0.3); letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 12px; font-weight: 600 }
    .plan-title { font-size: 26px; font-weight: 700; color: #f0ede8; line-height: 1.2; margin-bottom: 6px }
    .plan-sub { font-size: 13px; color: #888; line-height: 1.5; margin-top: 6px }
    .week-label { font-size: 12px; color: #666; margin-top: 14px }
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
    .pill-cal { background: rgba(135,189,240,0.12); color: #87bdf0 }
    .pill-p { background: rgba(224,110,110,0.12); color: #e06e6e }
    .pill-c { background: rgba(134,211,173,0.12); color: #86d3ad }
    .pill-f { background: rgba(234,203,87,0.12); color: #eacb57 }
    .servings { font-size: 11px; color: #555; margin-top: 4px }
    .leftover-tag { font-size: 10px; color: #87bdf0; margin-top: 4px }
    .meal-card details { margin-top: 10px; border-top: 1px solid #222; padding-top: 10px }
    .meal-card details > summary { cursor: pointer; font-size: 12px; color: #888; list-style: none; user-select: none; display: inline-flex; align-items: center; gap: 6px }
    .meal-card details > summary::-webkit-details-marker { display: none }
    .meal-card details > summary::before { content: '▸'; font-size: 9px; color: #666; transition: transform 0.15s; display: inline-block }
    .meal-card details[open] > summary::before { transform: rotate(90deg) }
    .meal-card details > summary:hover { color: #ccc }
    .recipe-section { margin-top: 12px }
    .recipe-section h4 { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 6px; font-weight: 600 }
    .recipe-section ul { list-style: none; padding: 0; margin: 0 }
    .recipe-section li { font-size: 13px; color: #ccc; line-height: 1.55; padding: 3px 0; padding-left: 14px; position: relative }
    .recipe-section li::before { content: '•'; position: absolute; left: 2px; color: #555 }
    .recipe-section ol { list-style: none; padding: 0; margin: 0; counter-reset: step }
    .recipe-section ol li { counter-increment: step; padding-left: 28px }
    .recipe-section ol li::before { content: counter(step); position: absolute; left: 0; top: 4px; font-size: 11px; font-weight: 700; color: #E8C547; background: rgba(232,197,71,0.1); border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center }
    .recipe-source { font-size: 11px; color: #555; margin-top: 10px; word-break: break-all }
    .recipe-source a { color: #87bdf0; text-decoration: none }
    .cta { position: fixed; bottom: 0; left: 0; right: 0; background: linear-gradient(to top, #0f0e0d 80%, transparent); padding: 20px 16px 28px }
    .cta-inner { max-width: 640px; margin: 0 auto; display: flex; gap: 10px }
    .btn-primary { flex: 1; background: #E8C547; color: #1a1500; border: none; border-radius: 12px; padding: 14px; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; text-align: center; text-decoration: none; display: block }
    .btn-copy { flex-shrink: 0; background: #1e1e1e; color: #ccc; border: 1px solid #333; border-radius: 12px; padding: 14px 16px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; white-space: nowrap }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">MacroLens</div>
      <span class="badge">Personal share</span>
      <div class="plan-title">${esc(title)}</div>
      <div class="plan-sub">${esc(ownerName)} shared their meal plan with you. Copy any meal you like into your own planner.</div>
      <div class="week-label">Week of ${weekStart.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}</div>
    </div>

    <div class="stats-row">
      <div class="stat"><div class="stat-val" style="color:#87bdf0">${Math.round(totals.calories / daysInPlan)}</div><div class="stat-label">kcal/day</div></div>
      <div class="stat"><div class="stat-val" style="color:#e06e6e">${Math.round(totals.protein / daysInPlan)}g</div><div class="stat-label">Protein</div></div>
      <div class="stat"><div class="stat-val" style="color:#86d3ad">${Math.round(totals.carbs / daysInPlan)}g</div><div class="stat-label">Carbs</div></div>
      <div class="stat"><div class="stat-val" style="color:#eacb57">${Math.round(totals.fat / daysInPlan)}g</div><div class="stat-label">Fat</div></div>
    </div>

    ${dayKeys.length ? dayKeys.map(dow => {
      const meals = byDay[dow]
      const dayLabel = DAYS[dow] || `Day ${dow}`
      return `<div class="day-section">
        <div class="day-header">${esc(dayLabel)}</div>
        ${meals.map(m => {
          const s = m.recipe_snapshot || {}
          const cal = Math.round(Number(s.calories || 0))
          const pro = Math.round(Number(s.protein || 0))
          const car = Math.round(Number(s.carbs || 0))
          const fat = Math.round(Number(s.fat || 0))
          const mealTypeLabels = { breakfast: '🌅 Breakfast', lunch: '☀️ Lunch', snack: '🍎 Snack', dinner: '🌙 Dinner' }
          const typeLabel = mealTypeLabels[m.meal_type] || ''
          const mealName = m.meal_name || s.name || 'Meal'
          const srv = m.planned_servings || 1
          // Recipe expansion: only render the details block when we actually
          // have ingredients or instructions to show. Leftovers point at the
          // original cook elsewhere in the week so we don't repeat the
          // recipe content here.
          const ingredients = Array.isArray(s.ingredients) ? s.ingredients : []
          const steps = Array.isArray(s.instructions?.steps) ? s.instructions.steps : []
          const tips = Array.isArray(s.instructions?.tips) ? s.instructions.tips : []
          const hasRecipe = !m.is_leftover && (ingredients.length || steps.length || s.description)

          const ingredientsHtml = ingredients.length ? `
            <div class="recipe-section">
              <h4>Ingredients</h4>
              <ul>
                ${ingredients.map(ing => {
                  const amt = ing.amount || ''
                  const unit = ing.unit || ''
                  const head = [amt, unit].filter(Boolean).join(' ')
                  return `<li>${esc([head, ing.name].filter(Boolean).join(' '))}</li>`
                }).join('')}
              </ul>
            </div>` : ''

          const instructionsHtml = steps.length ? `
            <div class="recipe-section">
              <h4>Instructions</h4>
              <ol>
                ${steps.map(step => `<li>${esc(step)}</li>`).join('')}
              </ol>
            </div>` : ''

          const tipsHtml = tips.length ? `
            <div class="recipe-section">
              <h4>Tips</h4>
              <ul>
                ${tips.map(t => `<li>${esc(t)}</li>`).join('')}
              </ul>
            </div>` : ''

          const descHtml = s.description ? `
            <div class="recipe-section" style="font-size:13px;color:#ccc;line-height:1.55">
              ${esc(s.description)}
            </div>` : ''

          const sourceHtml = s.source_url ? `
            <div class="recipe-source">Source: <a href="${esc(s.source_url)}" target="_blank" rel="noopener">${esc(s.source_url)}</a></div>
          ` : ''

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
            ${m.is_leftover ? `<div class="leftover-tag">↩ Planned as leftovers</div>` : ''}
            ${hasRecipe ? `
              <details>
                <summary>View recipe</summary>
                ${descHtml}
                ${ingredientsHtml}
                ${instructionsHtml}
                ${tipsHtml}
                ${sourceHtml}
              </details>
            ` : ''}
          </div>`
        }).join('')}
      </div>`
    }).join('') : `<div style="padding:40px 0;text-align:center;color:#444">This share is empty.</div>`}
  </div>

  <div class="cta">
    <div class="cta-inner">
      <a href="${copyUrl}" class="btn-primary">📲 Copy to my planner</a>
      <button class="btn-copy" onclick="sharePlan()">↗ Share</button>
    </div>
  </div>

  <script>
    async function sharePlan() {
      const url = ${JSON.stringify(shareUrl)}
      const title = ${JSON.stringify(title)}
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
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    res.status(200).send(html)
  } catch (renderErr) {
    console.error('[/api/share/[token]] render error:', renderErr?.message)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(500).send('<h1>Couldn\'t render this share</h1>')
  }
}
