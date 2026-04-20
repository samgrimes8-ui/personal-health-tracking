function buildSourceCard(url, og) {
  if (!url) return ''
  const domain = (() => { try { return new URL(url).hostname.replace('www.','') } catch { return url } })()
  const isInstagram = domain.includes('instagram.com')
  const isTikTok = domain.includes('tiktok.com')
  const isBlocked = og?.blocked || isInstagram || isTikTok
  const hasImage = og?.image && !isBlocked

  if (!og || isBlocked || !og.title) {
    return `<a href="${esc(url)}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:#1E1E1E;border:1px solid #2A2A2A;border-radius:12px;text-decoration:none;color:inherit;margin-bottom:16px">
      <span style="font-size:20px">${isInstagram ? '📸' : isTikTok ? '🎵' : '🔗'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:#E8C547;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${isInstagram ? 'View on Instagram' : isTikTok ? 'View on TikTok' : 'View original recipe'}</div>
        <div style="font-size:11px;color:#666;margin-top:1px">${esc(domain)}</div>
      </div>
      <span style="color:#666;font-size:13px">↗</span>
    </a>`
  }

  return `<a href="${esc(url)}" target="_blank" rel="noopener" style="display:block;border:1px solid #2A2A2A;border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;background:#1E1E1E;margin-bottom:16px">
    ${hasImage ? `<div style="width:100%;height:180px;overflow:hidden;background:#222"><img src="${esc(og.image)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.display='none'" /></div>` : ''}
    <div style="padding:12px 14px">
      ${og.siteName ? `<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:4px">${esc(og.siteName)}</div>` : ''}
      ${og.title ? `<div style="font-size:14px;font-weight:600;color:#F0F0F0;line-height:1.3;margin-bottom:4px">${esc(og.title)}</div>` : ''}
      ${og.description ? `<div style="font-size:12px;color:#888;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(og.description)}</div>` : ''}
      <div style="font-size:11px;color:#E8C547;margin-top:8px">View original recipe ↗</div>
    </div>
  </a>`
}

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
)

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Normalize instructions: handles array, {steps:[]}, or string
function getSteps(instructions) {
  if (!instructions) return []
  if (Array.isArray(instructions)) return instructions.map(s => typeof s === 'string' ? s : s.text || s.step || JSON.stringify(s))
  if (typeof instructions === 'object' && Array.isArray(instructions.steps)) return instructions.steps
  if (typeof instructions === 'string') return [instructions]
  return []
}

function getTips(instructions) {
  if (!instructions || typeof instructions !== 'object') return []
  return Array.isArray(instructions.tips) ? instructions.tips : []
}

function renderPage(recipe) {
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : []
  const steps = getSteps(recipe.instructions)
  const tips = getTips(recipe.instructions)
  const inst = recipe.instructions
  const prepTime = inst?.prep_time || null
  const cookTime = inst?.cook_time || null
  const macros = recipe.macros || {}
  const cal = recipe.calories || macros.calories
  const pro = recipe.protein  || macros.protein
  const carb = recipe.carbs   || macros.carbs
  const fat = recipe.fat      || macros.fat

  const macroItems = [
    { label: 'Calories', value: cal  ? Math.round(cal)  : null, unit: 'kcal', color: '#E8C547' },
    { label: 'Protein',  value: pro  ? Math.round(pro)  : null, unit: 'g',    color: '#4CAF82' },
    { label: 'Carbs',    value: carb ? Math.round(carb) : null, unit: 'g',    color: '#5B9CF6' },
    { label: 'Fat',      value: fat  ? Math.round(fat)  : null, unit: 'g',    color: '#F5924E' },
  ].filter(m => m.value != null)

  const ingredientRows = ingredients.map(ing => `
    <div class="ing-row">
      <span class="ing-amount">${esc(ing.amount || '')} ${esc(ing.unit || '')}</span>
      <span class="ing-name">${esc(ing.name || '')}</span>
    </div>`).join('')

  const stepRows = steps.map((step, i) => `
    <div class="step-row">
      <div class="step-num">${i + 1}</div>
      <div class="step-text">${esc(String(step))}</div>
    </div>`).join('')

  const tipRows = tips.map(tip => `
    <div class="tip-row">💡 ${esc(String(tip))}</div>`).join('')

  const hasTabs = ingredients.length > 0 && steps.length > 0

  // Embed recipe data for save functionality
  const recipeData = JSON.stringify({
    name: recipe.name,
    description: recipe.description,
    servings: recipe.servings,
    serving_label: recipe.serving_label,
    calories: cal, protein: pro, carbs: carb, fat: fat,
    fiber: recipe.fiber, sugar: recipe.sugar,
    ingredients: recipe.ingredients,
    instructions: recipe.instructions,
    notes: recipe.notes,
    source_url: recipe.source_url,
    source: 'shared',
  }).replace(/</g, '\\u003c')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(recipe.name)} — MacroLens</title>
  <meta property="og:title" content="${esc(recipe.name)}">
  <meta property="og:description" content="${macroItems.map(m => `${m.value}${m.unit === 'kcal' ? ' ' : 'g '}${m.label}`).join(' · ')}">
  <meta property="og:site_name" content="MacroLens">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #141414; color: #E8E8E8; min-height: 100vh; padding-bottom: 90px; }
    .header { background: #1A1A1A; border-bottom: 1px solid #2A2A2A;
      padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; }
    .logo { font-size: 18px; font-weight: 700; color: #E8C547; }
    .logo-sub { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px 16px; }
    h1 { font-size: 24px; font-weight: 700; color: #F0F0F0; margin-bottom: 6px; line-height: 1.2; }
    .meta { font-size: 13px; color: #666; margin-bottom: 4px; }
    .time-row { display: flex; gap: 12px; margin: 10px 0 16px; }
    .time-badge { font-size: 12px; color: #888; background: #1E1E1E; padding: 4px 10px; border-radius: 20px; }
    .macros { display: grid; grid-template-columns: repeat(4,1fr); gap: 8px;
      background: #1E1E1E; border-radius: 12px; padding: 14px; margin-bottom: 20px; }
    .macro-item { text-align: center; }
    .macro-val { font-size: 20px; font-weight: 700; }
    .macro-label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
    .servings-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
      background: #1E1E1E; border-radius: 10px; padding: 10px 14px; }
    .servings-label { font-size: 13px; color: #888; }
    .servings-ctrl { display: flex; align-items: center; gap: 10px; margin-left: auto; }
    .servings-btn { width: 28px; height: 28px; border-radius: 50%; border: 1px solid #333;
      background: #2A2A2A; color: #E8E8E8; font-size: 18px; cursor: pointer; line-height: 1;
      display: flex; align-items: center; justify-content: center; }
    .servings-btn:hover { border-color: #E8C547; color: #E8C547; }
    .servings-val { font-size: 16px; font-weight: 600; min-width: 24px; text-align: center; }
    .tabs { display: flex; gap: 6px; margin-bottom: 12px; }
    .tab { padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
      cursor: pointer; border: none; font-family: inherit; background: #1E1E1E; color: #888; }
    .tab.active { background: #E8C547; color: #1A1500; }
    .section { background: #1E1E1E; border-radius: 12px; padding: 14px; margin-bottom: 14px; }
    .section-title { font-size: 10px; font-weight: 600; color: #666; text-transform: uppercase;
      letter-spacing: 1px; margin-bottom: 10px; }
    .ing-row { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid #2A2A2A; }
    .ing-row:last-child { border-bottom: none; }
    .ing-amount { font-size: 13px; color: #E8C547; font-weight: 600; min-width: 90px; flex-shrink: 0; }
    .ing-name { font-size: 13px; color: #E0E0E0; }
    .step-row { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #2A2A2A; }
    .step-row:last-child { border-bottom: none; }
    .step-num { width: 24px; height: 24px; border-radius: 50%; background: #E8C547;
      color: #1A1500; font-size: 12px; font-weight: 700; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center; }
    .step-text { font-size: 13px; color: #D0D0D0; line-height: 1.55; padding-top: 2px; }
    .tip-row { font-size: 12px; color: #888; padding: 6px 0; border-bottom: 1px solid #2A2A2A; line-height: 1.4; }
    .tip-row:last-child { border-bottom: none; }
    .notes { font-size: 13px; color: #888; font-style: italic; line-height: 1.5; }
    .cta { position: fixed; bottom: 0; left: 0; right: 0; background: #1A1A1A;
      border-top: 1px solid #2A2A2A; padding: 12px 16px;
      display: flex; gap: 10px; align-items: center; }
    .cta-text { font-size: 12px; color: #555; flex: 1; line-height: 1.3; }
    .cta-btn { background: #E8C547; color: #1A1500; border: none; border-radius: 10px;
      padding: 12px 18px; font-size: 14px; font-weight: 700;
      font-family: inherit; cursor: pointer; white-space: nowrap; }
    .cta-btn:disabled { opacity: 0.6; cursor: default; }
    .saved-badge { background: #1E3A2F; color: #4CAF82; border: 1px solid #2A5A40;
      border-radius: 10px; padding: 12px 18px; font-size: 13px; font-weight: 600; white-space: nowrap; }
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
    ${recipe.source_url ? buildSourceCard(recipe.source_url, recipe.og_cache) : ''}

    ${(prepTime || cookTime) ? `
    <div class="time-row">
      ${prepTime ? `<span class="time-badge">⏱ Prep ${esc(prepTime)}</span>` : ''}
      ${cookTime ? `<span class="time-badge">🔥 Cook ${esc(cookTime)}</span>` : ''}
    </div>` : ''}

    ${macroItems.length ? `
    <div class="macros" id="macros-display">
      ${macroItems.map(m => `
        <div class="macro-item">
          <div class="macro-val" style="color:${m.color}" data-base="${m.value}">${m.value}</div>
          <div class="macro-label">${m.unit === 'kcal' ? 'kcal' : m.label + ' (g)'}</div>
        </div>`).join('')}
    </div>` : ''}

    ${recipe.servings ? `
    <div class="servings-row">
      <span class="servings-label">Servings (per serving macros shown)</span>
      <div class="servings-ctrl">
        <button class="servings-btn" onclick="changeServings(-1)">−</button>
        <span class="servings-val" id="servings-display">${recipe.servings}</span>
        <button class="servings-btn" onclick="changeServings(1)">+</button>
      </div>
    </div>` : ''}

    ${hasTabs ? `
    <div class="tabs">
      <button class="tab active" id="tab-ing" onclick="showTab('ing')">📋 Ingredients</button>
      <button class="tab" id="tab-steps" onclick="showTab('steps')">👨‍🍳 Instructions</button>
    </div>` : steps.length > 0 && ingredients.length === 0 ? `
    <div class="tabs">
      <button class="tab active" id="tab-steps">👨‍🍳 Instructions</button>
    </div>` : ''}

    ${ingredients.length ? `
    <div class="section" id="panel-ing">
      ${ingredientRows}
    </div>` : ''}

    ${steps.length ? `
    <div class="section" id="panel-steps" style="${hasTabs ? 'display:none' : ''}">
      ${stepRows}
      ${tips.length ? `
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #2A2A2A">
        <div class="section-title">Tips</div>
        ${tipRows}
      </div>` : ''}
    </div>` : ''}

    ${recipe.notes ? `
    <div class="section">
      <div class="section-title">Notes</div>
      <div class="notes">${esc(recipe.notes)}</div>
    </div>` : ''}
  </div>

  <div class="cta">
    <div class="cta-text">Save this recipe to your MacroLens library and log it anytime.</div>
    <button class="cta-btn" id="save-btn" onclick="saveToMacroLens()">Save recipe</button>
  </div>

  <script>
    const BASE_SERVINGS = ${recipe.servings || 1}
    const RECIPE_DATA = ${recipeData}
    let currentServings = BASE_SERVINGS

    function changeServings(delta) {
      currentServings = Math.max(1, currentServings + delta)
      document.getElementById('servings-display').textContent = currentServings
      const mult = currentServings / BASE_SERVINGS
      document.querySelectorAll('.macro-val[data-base]').forEach(el => {
        el.textContent = Math.round(parseFloat(el.dataset.base) * mult)
      })
      document.querySelectorAll('.ing-amount[data-base-amt]').forEach(el => {
        const raw = parseFloat(el.dataset.baseAmt)
        if (isNaN(raw)) return
        const scaled = raw * mult
        el.textContent = (scaled % 1 === 0 ? scaled : +scaled.toFixed(2)) + ' ' + (el.dataset.unit || '')
      })
    }

    function showTab(tab) {
      const panels = ['ing', 'steps']
      panels.forEach(p => {
        const el = document.getElementById('panel-' + p)
        const btn = document.getElementById('tab-' + p)
        if (el) el.style.display = p === tab ? '' : 'none'
        if (btn) btn.classList.toggle('active', p === tab)
      })
    }

    async function saveToMacroLens() {
      const btn = document.getElementById('save-btn')
      btn.disabled = true
      btn.textContent = 'Saving...'
      try {
        // Try to save via postMessage to parent if embedded, otherwise redirect
        localStorage.setItem('macrolens_save_recipe', JSON.stringify(RECIPE_DATA))
        btn.className = 'saved-badge'
        btn.textContent = '✓ Saved! Open MacroLens to view'
        setTimeout(() => { window.location.href = 'https://personal-health-tracking.vercel.app' }, 1500)
      } catch(e) {
        btn.disabled = false
        btn.textContent = 'Save recipe'
        window.location.href = 'https://personal-health-tracking.vercel.app'
      }
    }
  </script>
</body>
</html>`
}

export default async function handler(req, res) {
  const { token } = req.query
  if (!token) return res.status(400).send('Missing token')

  const { data: recipe, error } = await supabase
    .from('recipes').select('*')
    .eq('share_token', token).eq('is_shared', true)
    .maybeSingle()

  if (error || !recipe) {
    return res.status(404).send(`<!DOCTYPE html>
<html><head><title>Recipe not found — MacroLens</title>
<style>body{background:#141414;color:#E8E8E8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
h1{color:#E8C547;margin-bottom:8px}.sub{color:#666;font-size:14px}a{color:#E8C547}</style></head>
<body><div><h1>Recipe not found</h1><div class="sub">This link may have expired or been removed.</div>
<br><a href="https://personal-health-tracking.vercel.app">Open MacroLens →</a></div></body></html>`)
  }

  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Cache-Control', 'public, max-age=60')
  return res.status(200).send(renderPage(recipe))
}
