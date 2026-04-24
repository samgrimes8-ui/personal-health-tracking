// Public recipe view — /api/recipe?token=xxx
//
// This is the legacy query-param share URL (there's also /api/recipe/[token]).
// A top-level try/catch around the whole handler ensures we never return a
// raw Vercel 500 page to users, because share links end up in iMessage /
// text threads where a crashed page looks especially bad.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  try {
    const { token } = req.query
    if (!token) return send404(res, 'Missing share token')

    // .maybeSingle() returns null-on-no-match instead of throwing. .single()
    // rejects on 0 rows, which previously propagated up as an uncaught
    // FUNCTION_INVOCATION_FAILED whenever someone visited an expired/invalid
    // token. That's bad UX for a shareable link.
    const { data: recipe, error } = await supabase
      .from('recipes')
      .select('*')
      .eq('share_token', token)
      .eq('is_public', true)
      .maybeSingle()

    if (error) {
      console.error('[api/recipe] supabase error:', error)
      return send404(res, 'Could not load recipe')
    }
    if (!recipe) return send404(res, 'Recipe not found or link has expired')

    // Both fields are JSONB on the DB side but have arrived as strings in
    // some very old records. Defensive parse so we render gracefully in
    // either case rather than crashing on `.map`.
    const ingredients = normalizeList(recipe.ingredients)
    const instructions = normalizeList(recipe.instructions)
    const servings = Number(recipe.servings) || 1

    const baseUrl = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://personal-health-tracking.vercel.app'
    const saveHref = `${baseUrl}?save_recipe=${encodeURIComponent(token)}`

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${esc(recipe.name || 'Shared recipe')} — MacroLens">
  <meta property="og:description" content="${Math.round(recipe.calories || 0)} kcal · ${Math.round(recipe.protein || 0)}g protein · ${Math.round(recipe.carbs || 0)}g carbs · ${Math.round(recipe.fat || 0)}g fat">
  <title>${esc(recipe.name || 'Shared recipe')} — MacroLens</title>
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
    <a href="${esc(saveHref)}" class="save-btn">Save recipe</a>
  </div>

  <div class="card">
    <h1>${esc(recipe.name || 'Untitled')}</h1>
    ${recipe.source_url ? `<div class="source">Source: <a href="${esc(recipe.source_url)}" style="color:#c8952a" target="_blank" rel="noopener">${esc(recipe.source_url)}</a></div>` : ''}
    <div class="macros">
      <div class="macro"><div class="macro-val" style="color:#c8952a" id="pub-cal">${Math.round(recipe.calories || 0)}</div><div class="macro-lbl">kcal</div></div>
      <div class="macro"><div class="macro-val" style="color:#7ecf8e" id="pub-p">${Math.round(recipe.protein || 0)}g</div><div class="macro-lbl">protein</div></div>
      <div class="macro"><div class="macro-val" style="color:#7db8e8" id="pub-c">${Math.round(recipe.carbs || 0)}g</div><div class="macro-lbl">carbs</div></div>
      <div class="macro"><div class="macro-val" style="color:#e8a87c" id="pub-f">${Math.round(recipe.fat || 0)}g</div><div class="macro-lbl">fat</div></div>
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
      ${ingredients.map(ing => {
        const obj = (ing && typeof ing === 'object') ? ing : {}
        const amt = obj.amount
        const unit = obj.unit || ''
        const name = obj.name || (typeof ing === 'string' ? ing : '')
        return `<div class="ingredient">
          <span class="ing-amt" data-base="${amt || ''}" data-unit="${esc(unit)}">${amt ? amt + ' ' + unit : ''}</span>
          <span>${esc(name)}</span>
        </div>`
      }).join('')}
    </div>
  </div>` : ''}

  ${instructions.length ? `
  <div class="card">
    <div class="section-title">Instructions</div>
    ${instructions.map((step, i) => {
      // Instruction step can be a string, or an object with .text / .instruction,
      // or (rarely, from bad data) null. Handle all three without crashing.
      let stepText = ''
      if (typeof step === 'string') stepText = step
      else if (step && typeof step === 'object') stepText = step.text || step.instruction || ''
      if (!stepText) return ''
      return `<div class="step">
        <div class="step-num">${i + 1}</div>
        <div class="step-text">${esc(stepText)}</div>
      </div>`
    }).join('')}
  </div>` : ''}

  <div style="height:80px"></div>

  <div class="cta">
    <div class="cta-text">Track this recipe's macros with MacroLens</div>
    <a href="${esc(saveHref)}" class="save-btn">Get MacroLens</a>
  </div>

  <script>
    const BASE_SERVINGS = ${servings}
    const BASE_MACROS = { cal: ${Math.round(recipe.calories || 0)}, p: ${Math.round(recipe.protein || 0)}, c: ${Math.round(recipe.carbs || 0)}, f: ${Math.round(recipe.fat || 0)} }

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
  } catch (err) {
    console.error('[api/recipe] unhandled error:', err)
    return send404(res, 'Something went wrong loading this recipe')
  }
}

// Renders a friendly page instead of a serverless crash. We use 404 for
// "not found" cases and a 500-dressed-as-404 for unexpected errors — the
// end user doesn't care about the distinction and it keeps the message
// consistent across failure modes.
function send404(res, message) {
  const baseUrl = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://personal-health-tracking.vercel.app'
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Recipe not found — MacroLens</title>
<style>body{font-family:-apple-system,sans-serif;background:#111;color:#e8e8e8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center}.wrap{max-width:400px}.logo{color:#c8952a;font-weight:700;font-size:18px;margin-bottom:24px}h1{font-size:20px;margin-bottom:10px}p{color:#888;font-size:14px;line-height:1.5;margin-bottom:24px}a{color:#c8952a;text-decoration:none;font-size:14px;font-weight:600}</style>
</head><body><div class="wrap">
<div class="logo">MacroLens</div>
<h1>Recipe unavailable</h1>
<p>${esc(message)}. The link may have expired, been unshared, or never existed.</p>
<a href="${baseUrl}">← Back to MacroLens</a>
</div></body></html>`
  res.setHeader('Content-Type', 'text/html')
  res.status(404).send(html)
}

// Some older rows store JSON as a string; newer ones as JSONB arrays. Try
// both, returning [] for anything else.
function normalizeList(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function esc(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
