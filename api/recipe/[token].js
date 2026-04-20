import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
)

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderPage(recipe) {
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : []
  const instructions = Array.isArray(recipe.instructions) ? recipe.instructions : []
  const macros = recipe.macros || {}

  const ingredientRows = ingredients.map(ing => `
    <div class="ing-row">
      <span class="ing-amount">${esc(ing.amount || '')} ${esc(ing.unit || '')}</span>
      <span class="ing-name">${esc(ing.name || '')}</span>
    </div>`).join('')

  const instructionRows = instructions.map((step, i) => `
    <div class="step-row">
      <div class="step-num">${i + 1}</div>
      <div class="step-text">${esc(typeof step === 'string' ? step : step.text || step.step || '')}</div>
    </div>`).join('')

  const macroItems = [
    { label: 'Calories', value: macros.calories ? Math.round(macros.calories) : null, unit: 'kcal', color: '#E8C547' },
    { label: 'Protein',  value: macros.protein  ? Math.round(macros.protein)  : null, unit: 'g',    color: '#4CAF82' },
    { label: 'Carbs',    value: macros.carbs     ? Math.round(macros.carbs)    : null, unit: 'g',    color: '#5B9CF6' },
    { label: 'Fat',      value: macros.fat       ? Math.round(macros.fat)      : null, unit: 'g',    color: '#F5924E' },
  ].filter(m => m.value != null)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(recipe.name)} — MacroLens</title>
  <meta property="og:title" content="${esc(recipe.name)}">
  <meta property="og:description" content="${macroItems.map(m => `${m.value}${m.unit} ${m.label}`).join(' · ')}">
  <meta property="og:site_name" content="MacroLens">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #141414; color: #E8E8E8;
      min-height: 100vh; padding: 0 0 80px;
    }
    .header {
      background: #1A1A1A; border-bottom: 1px solid #2A2A2A;
      padding: 14px 20px; display: flex; align-items: center; gap: 12px;
    }
    .logo { font-size: 18px; font-weight: 700; color: #E8C547; letter-spacing: -0.3px; }
    .logo-sub { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
    .container { max-width: 600px; margin: 0 auto; padding: 24px 20px; }
    h1 { font-size: 26px; font-weight: 700; color: #F0F0F0; margin-bottom: 8px; line-height: 1.2; }
    .meta { font-size: 13px; color: #666; margin-bottom: 20px; }
    .macros {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
      background: #1E1E1E; border-radius: 12px; padding: 16px; margin-bottom: 24px;
    }
    .macro-item { text-align: center; }
    .macro-val { font-size: 22px; font-weight: 700; }
    .macro-label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
    .servings-row {
      display: flex; align-items: center; gap: 12px; margin-bottom: 20px;
      background: #1E1E1E; border-radius: 10px; padding: 12px 16px;
    }
    .servings-label { font-size: 13px; color: #888; }
    .servings-ctrl { display: flex; align-items: center; gap: 10px; margin-left: auto; }
    .servings-btn {
      width: 28px; height: 28px; border-radius: 50%; border: 1px solid #333;
      background: #2A2A2A; color: #E8E8E8; font-size: 16px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; line-height: 1;
    }
    .servings-btn:hover { border-color: #E8C547; color: #E8C547; }
    .servings-val { font-size: 16px; font-weight: 600; min-width: 24px; text-align: center; }
    .section { background: #1E1E1E; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .section-title {
      font-size: 11px; font-weight: 600; color: #888; text-transform: uppercase;
      letter-spacing: 1px; margin-bottom: 12px;
    }
    .ing-row {
      display: flex; gap: 12px; padding: 7px 0;
      border-bottom: 1px solid #2A2A2A; align-items: baseline;
    }
    .ing-row:last-child { border-bottom: none; }
    .ing-amount { font-size: 13px; color: #E8C547; font-weight: 600; min-width: 80px; flex-shrink: 0; }
    .ing-name { font-size: 13px; color: #E0E0E0; }
    .step-row { display: flex; gap: 14px; padding: 10px 0; border-bottom: 1px solid #2A2A2A; }
    .step-row:last-child { border-bottom: none; }
    .step-num {
      width: 24px; height: 24px; border-radius: 50%; background: #E8C547;
      color: #1A1A1A; font-size: 12px; font-weight: 700; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .step-text { font-size: 13px; color: #D0D0D0; line-height: 1.5; padding-top: 2px; }
    .cta {
      position: fixed; bottom: 0; left: 0; right: 0;
      background: #1A1A1A; border-top: 1px solid #2A2A2A;
      padding: 14px 20px; display: flex; gap: 10px; align-items: center;
    }
    .cta-text { font-size: 12px; color: #666; flex: 1; }
    .cta-btn {
      background: #E8C547; color: #1A1500; border: none; border-radius: 10px;
      padding: 12px 20px; font-size: 14px; font-weight: 700;
      font-family: inherit; cursor: pointer; white-space: nowrap; text-decoration: none;
      display: inline-block;
    }
    .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
    .tab {
      padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
      cursor: pointer; border: none; font-family: inherit;
      background: #1E1E1E; color: #888;
    }
    .tab.active { background: #E8C547; color: #1A1500; }
    .notes { font-size: 13px; color: #888; font-style: italic; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">MacroLens</div>
      <div class="logo-sub">AI Nutrition Tracker</div>
    </div>
  </div>

  <div class="container">
    <h1>${esc(recipe.name)}</h1>
    ${recipe.description ? `<div class="meta">${esc(recipe.description)}</div>` : ''}
    ${recipe.source_url ? `<div class="meta">Source: <a href="${esc(recipe.source_url)}" style="color:#E8C547" target="_blank">${esc(recipe.source_url)}</a></div>` : ''}

    ${macroItems.length ? `
    <div class="macros" id="macros-display">
      ${macroItems.map(m => `
        <div class="macro-item">
          <div class="macro-val" style="color:${m.color}">${m.value}</div>
          <div class="macro-label">${m.unit === 'kcal' ? m.label : m.label}</div>
        </div>`).join('')}
    </div>` : ''}

    ${recipe.servings ? `
    <div class="servings-row">
      <span class="servings-label">Servings</span>
      <div class="servings-ctrl">
        <button class="servings-btn" onclick="changeServings(-1)">−</button>
        <span class="servings-val" id="servings-display">${recipe.servings}</span>
        <button class="servings-btn" onclick="changeServings(1)">+</button>
      </div>
    </div>` : ''}

    ${ingredients.length || instructions.length ? `
    <div class="tabs">
      ${ingredients.length ? `<button class="tab active" id="tab-ing" onclick="showTab('ing')">📋 Ingredients</button>` : ''}
      ${instructions.length ? `<button class="tab ${!ingredients.length ? 'active' : ''}" id="tab-steps" onclick="showTab('steps')">👨‍🍳 Instructions</button>` : ''}
    </div>` : ''}

    ${ingredients.length ? `
    <div class="section" id="panel-ing">
      ${ingredientRows}
    </div>` : ''}

    ${instructions.length ? `
    <div class="section" id="panel-steps" style="display:none">
      ${instructionRows}
    </div>` : ''}

    ${recipe.notes ? `
    <div class="section">
      <div class="section-title">Notes</div>
      <div class="notes">${esc(recipe.notes)}</div>
    </div>` : ''}
  </div>

  <div class="cta">
    <div class="cta-text">Track your macros with MacroLens</div>
    <a href="https://personal-health-tracking.vercel.app" class="cta-btn">Save to MacroLens →</a>
  </div>

  <script>
    const baseServings = ${recipe.servings || 1}
    const baseMacros = ${JSON.stringify({ calories: macros.calories, protein: macros.protein, carbs: macros.carbs, fat: macros.fat })}
    const baseIngredients = ${JSON.stringify(ingredients)}
    let currentServings = baseServings

    function changeServings(delta) {
      currentServings = Math.max(1, currentServings + delta)
      document.getElementById('servings-display').textContent = currentServings
      const mult = currentServings / baseServings
      // Update macros
      const macroEls = document.querySelectorAll('.macro-val')
      const vals = [baseMacros.calories, baseMacros.protein, baseMacros.carbs, baseMacros.fat].filter(v => v != null)
      macroEls.forEach((el, i) => { if (vals[i] != null) el.textContent = Math.round(vals[i] * mult) })
      // Update ingredient amounts
      const amtEls = document.querySelectorAll('.ing-amount')
      amtEls.forEach((el, i) => {
        const ing = baseIngredients[i]
        if (!ing) return
        const raw = parseFloat(ing.amount)
        if (isNaN(raw)) return
        const scaled = raw * mult
        const disp = scaled % 1 === 0 ? scaled : +scaled.toFixed(2)
        el.textContent = disp + ' ' + (ing.unit || '')
      })
    }

    function showTab(tab) {
      document.getElementById('panel-ing') && (document.getElementById('panel-ing').style.display = tab === 'ing' ? '' : 'none')
      document.getElementById('panel-steps') && (document.getElementById('panel-steps').style.display = tab === 'steps' ? '' : 'none')
      document.getElementById('tab-ing') && document.getElementById('tab-ing').classList.toggle('active', tab === 'ing')
      document.getElementById('tab-steps') && document.getElementById('tab-steps').classList.toggle('active', tab === 'steps')
    }
  </script>
</body>
</html>`
}

export default async function handler(req, res) {
  const { token } = req.query

  if (!token) {
    return res.status(400).send('Missing token')
  }

  const { data: recipe, error } = await supabase
    .from('recipes')
    .select('*')
    .eq('share_token', token)
    .eq('is_shared', true)
    .maybeSingle()

  if (error || !recipe) {
    return res.status(404).send(`<!DOCTYPE html>
<html><head><title>Recipe not found — MacroLens</title>
<style>body{background:#141414;color:#E8E8E8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
h1{color:#E8C547;font-size:24px;margin-bottom:8px}.sub{color:#666;font-size:14px}</style></head>
<body><div><h1>Recipe not found</h1><div class="sub">This link may have expired or been removed.</div></div></body></html>`)
  }

  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Cache-Control', 'public, max-age=60')
  return res.status(200).send(renderPage(recipe))
}
