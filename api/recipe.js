// Public recipe view — /api/recipe?token=xxx
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  const { token } = req.query
  if (!token) return res.status(404).send('Not found')

  const { data: recipe } = await supabase
    .from('recipes')
    .select('*')
    .eq('share_token', token)
    .eq('is_public', true)
    .single()

  if (!recipe) return res.status(404).send('Recipe not found or link has expired')

  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : []
  const instructions = Array.isArray(recipe.instructions) ? recipe.instructions : []
  const servings = recipe.servings || 1

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${esc(recipe.name)} — MacroLens">
  <meta property="og:description" content="${Math.round(recipe.calories)} kcal · ${Math.round(recipe.protein)}g protein · ${Math.round(recipe.carbs)}g carbs · ${Math.round(recipe.fat)}g fat">
  <title>${esc(recipe.name)} — MacroLens</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: 'DM Sans', -apple-system, sans-serif; background: #111; color: #e8e8e8; min-height: 100vh; padding: 0 0 60px }
    .header { background: #1a1a1a; border-bottom: 1px solid #2a2a2a; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between }
    .logo { color: #c8952a; font-weight: 700; font-size: 18px; letter-spacing: -0.3px }
    .save-btn { background: #c8952a; color: #1a1500; border: none; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; text-decoration: none; display: inline-block }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 20px; margin: 16px; }
    h1 { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 6px }
    .source { font-size: 12px; color: #666; margin-bottom: 16px }
    .macros { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 0 }
    .macro { text-align: center; background: #222; border-radius: 8px; padding: 10px 4px }
    .macro-val { font-size: 20px; font-weight: 700 }
    .macro-lbl { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px }
    .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 12px }
    .servings-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px }
    .servings-row label { font-size: 13px; color: #999 }
    .servings-row input { width: 60px; background: #222; border: 1px solid #333; border-radius: 6px; padding: 6px 8px; color: #e8e8e8; font-size: 14px; font-family: inherit; text-align: center }
    .ingredient { display: flex; align-items: baseline; gap: 8px; padding: 8px 0; border-bottom: 1px solid #222; font-size: 14px }
    .ing-amt { color: #c8952a; font-weight: 600; min-width: 70px }
    .step { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #222 }
    .step-num { background: #c8952a; color: #1a1500; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; margin-top: 2px }
    .step-text { font-size: 14px; color: #ccc; line-height: 1.5 }
    .cta { background: #1a1a1a; border-top: 1px solid #2a2a2a; position: fixed; bottom: 0; left: 0; right: 0; padding: 12px 20px; display: flex; gap: 10px; align-items: center }
    .cta-text { font-size: 12px; color: #666; flex: 1 }
    a.save-btn:hover { opacity: 0.9 }
  </style>
</head>
<body>
  <div class="header">
    <span class="logo">MacroLens</span>
    <a href="${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://personal-health-tracking.vercel.app'}?save_recipe=${token}" class="save-btn">Save recipe</a>
  </div>

  <div class="card">
    <h1>${esc(recipe.name)}</h1>
    ${recipe.source_url ? `<div class="source">Source: <a href="${esc(recipe.source_url)}" style="color:#c8952a" target="_blank">${esc(recipe.source_url)}</a></div>` : ''}
    <div class="macros">
      <div class="macro"><div class="macro-val" style="color:#c8952a" id="pub-cal">${Math.round(recipe.calories)}</div><div class="macro-lbl">kcal</div></div>
      <div class="macro"><div class="macro-val" style="color:#7ecf8e" id="pub-p">${Math.round(recipe.protein)}g</div><div class="macro-lbl">protein</div></div>
      <div class="macro"><div class="macro-val" style="color:#7db8e8" id="pub-c">${Math.round(recipe.carbs)}g</div><div class="macro-lbl">carbs</div></div>
      <div class="macro"><div class="macro-val" style="color:#e8a87c" id="pub-f">${Math.round(recipe.fat)}g</div><div class="macro-lbl">fat</div></div>
    </div>
  </div>

  ${ingredients.length ? `
  <div class="card">
    <div class="section-title">Ingredients</div>
    <div class="servings-row">
      <label>Servings</label>
      <input type="number" id="pub-servings" value="${servings}" min="0.5" step="0.5" oninput="scaleIngredients()" />
    </div>
    <div id="pub-ingredients">
      ${ingredients.map(ing => `
        <div class="ingredient">
          <span class="ing-amt" data-base="${ing.amount || ''}" data-unit="${esc(ing.unit || '')}">${ing.amount ? ing.amount + ' ' + (ing.unit || '') : ''}</span>
          <span>${esc(ing.name || '')}</span>
        </div>`).join('')}
    </div>
  </div>` : ''}

  ${instructions.length ? `
  <div class="card">
    <div class="section-title">Instructions</div>
    ${instructions.map((step, i) => `
      <div class="step">
        <div class="step-num">${i + 1}</div>
        <div class="step-text">${esc(typeof step === 'string' ? step : step.text || step.instruction || JSON.stringify(step))}</div>
      </div>`).join('')}
  </div>` : ''}

  <div style="height:80px"></div>

  <div class="cta">
    <div class="cta-text">Track this recipe's macros with MacroLens</div>
    <a href="${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://personal-health-tracking.vercel.app'}?save_recipe=${token}" class="save-btn">Get MacroLens</a>
  </div>

  <script>
    const BASE_SERVINGS = ${servings}
    const BASE_MACROS = { cal: ${Math.round(recipe.calories)}, p: ${Math.round(recipe.protein)}, c: ${Math.round(recipe.carbs)}, f: ${Math.round(recipe.fat)} }

    function scaleIngredients() {
      const s = parseFloat(document.getElementById('pub-servings').value) || BASE_SERVINGS
      const mult = s / BASE_SERVINGS
      document.querySelectorAll('.ing-amt').forEach(el => {
        const base = parseFloat(el.dataset.base)
        const unit = el.dataset.unit
        if (base) {
          const scaled = base * mult
          el.textContent = (scaled % 1 === 0 ? scaled : +scaled.toFixed(2)) + ' ' + unit
        }
      })
      document.getElementById('pub-cal').textContent = Math.round(BASE_MACROS.cal * mult)
      document.getElementById('pub-p').textContent = Math.round(BASE_MACROS.p * mult) + 'g'
      document.getElementById('pub-c').textContent = Math.round(BASE_MACROS.c * mult) + 'g'
      document.getElementById('pub-f').textContent = Math.round(BASE_MACROS.f * mult) + 'g'
    }
  </script>
</body>
</html>`

  res.setHeader('Content-Type', 'text/html')
  res.status(200).send(html)
}

function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
