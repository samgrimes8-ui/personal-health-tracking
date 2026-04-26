/**
 * AI module — all Anthropic calls go through /api/analyze (server-side proxy).
 * The Anthropic API key never touches the browser.
 */

import { supabase } from './supabase.js'

// ─── Core proxy caller ────────────────────────────────────────────────────────

// ─── Global AI loading indicator ─────────────────────────────────────────────
let _aiCallsInFlight = 0

function aiLoadingStart() {
  _aiCallsInFlight++
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ai-loading', { detail: { active: true } }))
  }
}

function aiLoadingEnd() {
  _aiCallsInFlight = Math.max(0, _aiCallsInFlight - 1)
  if (_aiCallsInFlight === 0 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ai-loading', { detail: { active: false } }))
  }
}

async function callProxy(feature, messages, options = {}) {
  // Always force-refresh the session token before AI calls
  // This prevents "string did not match expected pattern" expired JWT errors
  let session
  try {
    const { data: refreshed, error } = await supabase.auth.refreshSession()
    if (refreshed?.session) {
      session = refreshed.session
    } else {
      // Refresh failed or no session — fall back to getSession
      const { data } = await supabase.auth.getSession()
      session = data?.session
    }
  } catch (e) {
    const { data } = await supabase.auth.getSession()
    session = data?.session
  }
  if (!session?.access_token) throw new Error('Session expired — please refresh the page')

  aiLoadingStart()
  try {
    // Compute approximate payload size so we can give a helpful error if
    // it's likely to exceed Vercel's 4.5MB edge function body limit.
    // Also auto-derive input_type for token_usage tracking: if any message
    // has an image, we call it 'image'; if any has text AND any has image,
    // 'mixed'; otherwise 'text'. Saves every call site from having to pass
    // this by hand.
    let approxSize = 0
    let hasImage = false
    let hasText = false
    try {
      for (const m of messages) {
        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === 'image' && c.source?.data) { approxSize += c.source.data.length; hasImage = true }
            if (c.text) { approxSize += c.text.length; hasText = true }
          }
        } else if (typeof m.content === 'string') { approxSize += m.content.length; hasText = true }
      }
    } catch {}
    const approxMB = approxSize / 1024 / 1024
    if (approxMB > 4.2) {
      throw new Error(`Image too large (~${approxMB.toFixed(1)}MB). Try a smaller photo or tighter crop.`)
    }
    const inputType = hasImage && hasText ? 'mixed' : hasImage ? 'image' : 'text'

    let res
    try {
      res = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          feature,
          messages,
          max_tokens: options.max_tokens ?? 2000,
          ...(options.tools ? { tools: options.tools } : {}),
          // Telemetry fields — used by token_usage to track per-operation
          // cost and input shape. Server-side /api/analyze passes these
          // into record_usage(). Unknown to the model itself.
          ...(options.action ? { action: options.action } : {}),
          input_type: inputType,
        })
      })
    } catch (networkErr) {
      // iOS Safari surfaces "Load failed" for any network failure — size
      // limits, CORS, offline, DNS, etc. Translate to something actionable.
      const msg = networkErr?.message || 'Network request failed'
      if (/load failed|failed to fetch|network/i.test(msg)) {
        throw new Error(`Network error${approxMB > 1 ? ` (payload was ${approxMB.toFixed(1)}MB — image may be too big)` : ' — check your connection'}`)
      }
      throw networkErr
    }

    const data = await res.json().catch(() => ({ error: `Server returned ${res.status} with invalid JSON` }))
    if (!res.ok) {
      if (res.status === 413) throw new Error('Image too large for server. Try a smaller photo.')
      // 429 with the spending_limit_exceeded code opens a full upgrade modal
      // instead of just flashing a toast. We still throw after — callers
      // abort their analysis flows normally, and the modal can be dismissed
      // independently.
      if (res.status === 429 && data.code === 'spending_limit_exceeded') {
        if (typeof window !== 'undefined' && typeof window.openLimitReachedModal === 'function') {
          window.openLimitReachedModal({
            spentUsd: data.spent_usd,
            limitUsd: data.limit_usd,
          })
        }
        throw new Error("You've used all your AI Bucks this month")
      }
      throw new Error(data.error ?? `Request failed (${res.status})`)
    }
    return data
  } finally {
    aiLoadingEnd()
  }
}

// ─── Helper: parse JSON from Anthropic response ───────────────────────────────

function parseJSON(data) {
  const raw = data.content
    .map(i => i.text || '')
    .join('')

  // 1. Strip markdown code fences
  let text = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()

  // 2. Try parsing the whole thing first
  try { return JSON.parse(text) } catch {}

  // 3. Extract the first {...} block (handles leading/trailing explanation text)
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch {}
  }

  // 4. Try to find and fix common issues — trailing commas, unquoted values
  if (match) {
    const fixed = match[0]
      .replace(/,\s*([}\]])/g, '$1')   // trailing commas
      .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3')  // unquoted keys
    try { return JSON.parse(fixed) } catch {}
  }

  // 5. Nothing worked — throw a useful error
  console.error('parseJSON failed. Raw response:', raw.slice(0, 500))
  throw new Error('AI returned an unexpected format. Please try again.')
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

// Full analysis prompt — always returns macros + ingredients in one call
const FULL_ANALYSIS_PROMPT = `Respond ONLY with a JSON object, no markdown, no explanation. Format:
{
  "name": "meal name",
  "description": "brief 1-sentence description",
  "servings": number,
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "fiber": number,
  "sugar": number,
  "confidence": "low|medium|high",
  "notes": "any important caveats or empty string",
  "ingredients": [
    {"name": "ingredient name", "amount": number, "unit": "oz/lbs/cups/tbsp/tsp/cloves/whole/slices", "category": "produce|protein|dairy|pantry|spices|grains|frozen|bakery|beverages"},
    ...
  ]
}

Rules for ingredients:
- amount must be a NUMBER (e.g. 3, 0.5, 2.5) — not a string
- unit: prefer oz for most solid ingredients where it makes sense (meat, cheese, vegetables).
  Use lbs only for large cuts (whole chicken, roast). Use cups for liquids and grains.
  Use tbsp/tsp for oils, sauces, spices. Use "whole" or "cloves" for things like garlic.
- category is REQUIRED on every single ingredient. Never omit this field.
  Pick exactly one of: produce, protein, dairy, pantry, spices, grains, frozen, bakery, beverages.
  Examples (so you anchor the right value):
    "chicken breast" → protein
    "ground beef" → protein
    "garlic cloves" → produce
    "fresh ginger" → produce
    "yellow onion" → produce
    "carrots" → produce
    "bell pepper" → produce
    "soy sauce" → pantry
    "sesame oil" → pantry
    "olive oil" → pantry
    "rice vinegar" → pantry
    "tomato paste" → pantry
    "mayonnaise" → pantry
    "brown sugar" → pantry
    "white rice" → grains
    "all-purpose flour" → grains
    "salt" → spices
    "black pepper" → spices
    "paprika" → spices
    "garlic powder" → spices
    "red pepper flakes" → spices
    "milk" → dairy
    "butter" → dairy
    "cheddar cheese" → dairy
- Category guide:
  - produce: fresh fruits, vegetables, herbs, garlic, onions
  - protein: meat, poultry, fish, eggs, tofu, beans (dry beans go in pantry)
  - dairy: milk, cheese, butter, cream, yogurt
  - pantry: oils, vinegars, sauces, condiments, canned goods, dry pasta, peanut butter
  - spices: dried spices, salt, pepper, dried herbs, seasonings
  - grains: rice, flour, oats, quinoa, dry pasta if you'd rather not put it in pantry
  - frozen: explicitly frozen items
  - bakery: fresh bread, rolls, tortillas
  - beverages: wine, beer, juice used in cooking
- List every ingredient needed. If packaged/restaurant item with no recipe, return empty array.`

// Planner/simple prompt — just macros, no ingredients needed
const MACROS_ONLY_PROMPT = `Respond ONLY with a JSON object, no markdown, no explanation. Format:
{"name":"meal name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"confidence":"low|medium|high"}`

// ─── Food analysis (always returns ingredients) ───────────────────────────────

export async function analyzePhoto(imageBase64, mealHint) {
  const data = await callProxy('photo', [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: `Analyze this image. It may be a food photo, a recipe page, a recipe card, or a screenshot of a recipe. Extract the recipe name, estimate macros per serving, and list all ingredients. ${FULL_ANALYSIS_PROMPT}` + (mealHint ? `\n\nMeal name hint: ${mealHint}` : '') }
    ]
  }], { max_tokens: 3000, action: 'analyze_photo' })
  return parseJSON(data)
}

// Like analyzePhoto, but biased for reading a written recipe from a cookbook
// page, recipe card, or blog screenshot. Extracts the recipe name, servings,
// ingredients list, and calculates per-serving macros — same shape as
// analyzeRecipe so the result can be saved / logged the same way.
export async function analyzeRecipePhoto(imageBase64, mealHint) {
  const data = await callProxy('recipe', [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: `This image contains a written recipe — from a cookbook, a recipe card, a blog post, or a social media screenshot.

Read the recipe carefully. Extract the recipe name, the number of servings it makes, the full ingredient list with amounts as written, and estimate accurate macros PER SERVING.

If servings aren't stated explicitly, infer a reasonable number from the ingredient quantities (e.g. 1 lb ground beef → ~4 servings).

${FULL_ANALYSIS_PROMPT}` + (mealHint ? `\n\nMeal name hint: ${mealHint}` : '') }
    ]
  }], { max_tokens: 3000, action: 'analyze_recipe_photo' })
  return parseJSON(data)
}

export async function analyzeRecipe(recipe, mealHint) {
  const data = await callProxy('recipe', [{
    role: 'user',
    content: `Analyze this recipe and estimate macros + list all ingredients needed per serving:\n\n${recipe}${mealHint ? `\n\nMeal name: ${mealHint}` : ''}\n\n${FULL_ANALYSIS_PROMPT}`
  }], { max_tokens: 2000, action: 'analyze_recipe' })
  return parseJSON(data)
}

export async function analyzeDishBySearch(dishName, link) {
  const query = link
    ? `Search for the recipe "${dishName}" from this URL: ${link}. Find the full ingredient list and serving size.`
    : `Search for the recipe "${dishName}". Find the full ingredient list and serving size.`

  const data = await callProxy('search', [{
    role: 'user',
    content: `${query}\n\nAfter searching, return ONLY a JSON object with the macros per serving and full ingredient list. ${FULL_ANALYSIS_PROMPT}`
  }], {
    max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    action: 'analyze_dish_by_search',
  })

  // Web search responses mix tool_use and text blocks — grab all text
  const text = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')

  if (!text) throw new Error('No response — try being more specific with the dish name')

  // Use the same resilient parser
  const fakeData = { content: [{ type: 'text', text }] }
  try {
    return parseJSON(fakeData)
  } catch {
    throw new Error('Could not extract recipe data — try pasting the ingredients directly in the Recipe tab')
  }
}

export async function analyzePlannerDescription(description) {
  const data = await callProxy('planner', [{
    role: 'user',
    content: `Analyze this meal/recipe and estimate macros per serving:\n\n${description}\n\n${MACROS_ONLY_PROMPT}`
  }], { max_tokens: 600, action: 'analyze_planner_description' })
  return parseJSON(data)
}

// ─── Recipe-specific AI calls ─────────────────────────────────────────────────

export async function extractIngredients(recipeName, description, servings) {
  const data = await callProxy('recipe', [{
    role: 'user',
    content: `For this recipe: "${recipeName}"${description ? `\n\nContext: ${description}` : ''}

List every ingredient needed to cook this for ${servings} serving(s).
Be specific with amounts (e.g. "3 lbs", "2 cups", "1 tbsp").

Respond ONLY with a JSON object, no markdown:
{
  "ingredients": [
    {"name": "chicken breast", "amount": "3", "unit": "lbs"},
    {"name": "olive oil", "amount": "2", "unit": "tbsp"},
    {"name": "garlic cloves", "amount": "4", "unit": ""},
    ...
  ],
  "notes": "any prep notes"
}`
  }], { max_tokens: 1500, action: 'extract_ingredients' })
  return parseJSON(data)
}

export async function recalculateMacros(recipeName, ingredients, servings) {
  const ingredientList = ingredients
    .map(i => `${i.amount} ${i.unit} ${i.name}`.trim())
    .join('\n')

  const data = await callProxy('recipe', [{
    role: 'user',
    content: `Calculate the macros per serving for this recipe (${servings} total servings):

Ingredients:
${ingredientList}

Respond ONLY with a JSON object, no markdown:
{"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"confidence":"low|medium|high","notes":"any caveats"}`
  }], { max_tokens: 800, action: 'recalculate_macros' })
  return parseJSON(data)
}

export async function analyzeFoodItem(description) {
  // For single food items — returns compact nutrition facts, no ingredient list needed
  const data = await callProxy('food', [{
    role: 'user',
    content: `Nutrition facts for this single food item: "${description}"

If this is a specific branded product, look up its actual nutrition label values.
If it's a generic food, use standard USDA values.

Respond ONLY with a JSON object, no markdown:
{
  "name": "exact product/food name",
  "brand": "brand name or empty string",
  "serving_size": "e.g. 1 bar (40g), 1 cup (240ml)",
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "fiber": number,
  "sugar": number,
  "sodium": number,
  "confidence": "low|medium|high",
  "notes": "any caveats or empty string"
}`
  }], { max_tokens: 600, action: 'analyze_food_item' })
  return parseJSON(data)
}



export async function generateRecipeInstructions(recipe) {
  const ingredientList = (recipe.ingredients || [])
    .map(i => `${i.amount || ''} ${i.unit || ''} ${i.name}`.trim())
    .join('\n')

  const data = await callProxy('recipe', [{
    role: 'user',
    content: `Write clear, step-by-step cooking instructions for this recipe.

Recipe: ${recipe.name}
${recipe.description ? `Description: ${recipe.description}` : ''}
Servings: ${recipe.servings || 4}
${ingredientList ? `\nIngredients:\n${ingredientList}` : ''}
${recipe.source_url ? `\nSource: ${recipe.source_url}` : ''}

Write numbered steps that are concise and easy to follow on a phone while cooking.
Include timing, temperatures, and visual cues (e.g. "until golden brown").
If no ingredients are provided, estimate based on the recipe name.

Return ONLY the steps as a JSON array:
{"steps": ["Step 1 text", "Step 2 text", ...], "prep_time": "X mins", "cook_time": "X mins", "tips": ["optional tip 1", ...]}`
  }], { max_tokens: 1500, action: 'generate_recipe_instructions' })

  return parseJSON(data)
}

export async function extractBodyScan(imageBase64, mediaType = 'image/jpeg') {
  const isPdf = mediaType === 'application/pdf'
  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } }

  const data = await callProxy('food', [{
    role: 'user',
    content: [
      fileBlock,
      { type: 'text', text: `You are reading a body composition scan (InBody or DEXA). Extract every numeric value you can find.

KEY RULES:
- Values may be in lbs OR kg. If weight > 100 it is likely lbs — convert to kg (divide by 2.20462)
- PBF / body_fat_pct is a PERCENTAGE (e.g. 17.0), NOT body fat mass in lbs
- Segmental values: extract both the weight (lbs/kg) and the % of normal shown
- Return null for any field not visible in the scan

Return ONLY this JSON object, no markdown, no extra text:
{
  "scan_type": "inbody or dexa",
  "scan_date": "YYYY-MM-DD or null",
  "weight_kg": null,
  "body_fat_pct": null,
  "body_fat_mass_kg": null,
  "muscle_mass_kg": null,
  "lean_body_mass_kg": null,
  "bone_mass_kg": null,
  "total_body_water_kg": null,
  "intracellular_water_kg": null,
  "extracellular_water_kg": null,
  "ecw_tbw_ratio": null,
  "protein_kg": null,
  "minerals_kg": null,
  "bmr": null,
  "bmi": null,
  "inbody_score": null,
  "visceral_fat_level": null,
  "body_cell_mass_kg": null,
  "smi": null,
  "seg_lean_left_arm_kg": null,
  "seg_lean_right_arm_kg": null,
  "seg_lean_trunk_kg": null,
  "seg_lean_left_leg_kg": null,
  "seg_lean_right_leg_kg": null,
  "seg_lean_left_arm_pct": null,
  "seg_lean_right_arm_pct": null,
  "seg_lean_trunk_pct": null,
  "seg_lean_left_leg_pct": null,
  "seg_lean_right_leg_pct": null,
  "bone_mineral_density": null,
  "t_score": null,
  "z_score": null,
  "android_fat_pct": null,
  "gynoid_fat_pct": null,
  "android_gynoid_ratio": null,
  "vat_area_cm2": null
}` }
    ]
  }], { max_tokens: 800, action: 'extract_body_scan' })
  return parseJSON(data)
}
export async function fetchOgMetadata(url) {
  try {
    const res = await fetch(`/api/og?url=${encodeURIComponent(url)}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

// ─── Nutrition Label OCR (free-first, Claude fallback) ────────────────────────

async function tryFreeOcr(imageBase64) {
  // OCR.space free tier — no API key needed for basic use
  try {
    const formData = new FormData()
    formData.append('base64Image', 'data:image/jpeg;base64,' + imageBase64)
    formData.append('language', 'eng')
    formData.append('isOverlayRequired', 'false')
    formData.append('detectOrientation', 'true')
    formData.append('scale', 'true')
    formData.append('OCREngine', '2') // Engine 2 handles printed text better

    const res = await Promise.race([
      fetch('https://api.ocr.space/parse/image', { method: 'POST', body: formData }),
      new Promise((_, r) => setTimeout(() => r(new Error('OCR timeout')), 8000))
    ])
    if (!res.ok) return null
    const data = await res.json()
    if (data.IsErroredOnProcessing) return null
    return data.ParsedResults?.[0]?.ParsedText || null
  } catch { return null }
}

function parseNutritionText(text) {
  if (!text || text.length < 20) return null

  const num = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p)
      if (m) {
        const v = parseFloat(m[1].replace(/,/g, ''))
        if (!isNaN(v)) return v
      }
    }
    return null
  }

  const calories = num([
    /calories[\s:]*(\d+)/i,
    /energy[\s:]*(\d+)\s*kcal/i,
    /cal[\.\s]*(\d+)/i,
  ])
  const protein = num([
    /protein[\s:]*(\d+\.?\d*)\s*g/i,
    /proteins[\s:]*(\d+\.?\d*)/i,
  ])
  const carbs = num([
    /total\s+carb(?:ohydrate)?s?[\s:]*(\d+\.?\d*)\s*g/i,
    /carbohydrate[\s:]*(\d+\.?\d*)/i,
    /carbs[\s:]*(\d+\.?\d*)/i,
  ])
  const fat = num([
    /total\s+fat[\s:]*(\d+\.?\d*)\s*g/i,
    /fat[\s:]*(\d+\.?\d*)\s*g/i,
  ])
  const fiber = num([
    /dietary\s+fiber[\s:]*(\d+\.?\d*)\s*g/i,
    /fiber[\s:]*(\d+\.?\d*)/i,
  ])
  const sugar = num([
    /total\s+sugars?[\s:]*(\d+\.?\d*)\s*g/i,
    /sugars?[\s:]*(\d+\.?\d*)/i,
  ])
  const sodium = num([
    /sodium[\s:]*(\d+\.?\d*)\s*mg/i,
  ])
  const servingSize = text.match(/serving\s+size[\s:]*([^\n]{3,30})/i)?.[1]?.trim() || null

  // Need at least calories + one macro to be useful
  if (!calories || (!protein && !carbs && !fat)) return null

  return {
    name: 'Food Item',
    brand: '',
    serving_size: servingSize || '1 serving',
    calories: calories || 0,
    protein: protein || 0,
    carbs: carbs || 0,
    fat: fat || 0,
    fiber: fiber || 0,
    sugar: sugar || 0,
    sodium: sodium || 0,
    confidence: 'high',
    notes: 'Extracted via OCR',
  }
}

export async function analyzeNutritionLabel(imageBase64) {
  // Step 1: Try free OCR + regex parsing
  const ocrText = await tryFreeOcr(imageBase64)
  if (ocrText) {
    const parsed = parseNutritionText(ocrText)
    if (parsed) return parsed
  }

  // Step 2: Fall back to Claude (costs tokens but handles complex/rotated labels)
  const data = await callProxy('food', [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: `Read the nutrition facts label in this image and extract the values exactly as printed.
Respond ONLY with a JSON object, no markdown:
{
  "name": "product name if visible, else 'Food Item'",
  "brand": "brand name if visible or empty string",
  "serving_size": "serving size as printed",
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "fiber": number,
  "sugar": number,
  "sodium": number,
  "confidence": "high",
  "notes": "any values that were unclear"
}` }
    ]
  }], { max_tokens: 600, action: 'analyze_nutrition_label' })
  return parseJSON(data)
}

// Classify a food-related photo into one of: 'barcode', 'label', or 'food'.
// Used to route the unified photo-upload UI: user snaps something, we first
// try local barcode decoders (free), and if that fails we call this to pick
// the right analysis path (label OCR vs meal analysis).
//
// Returns one of 'barcode' | 'label' | 'food'. Defaults to 'food' if the
// model returns something unexpected — meal analysis is the safest default
// because it gives the user SOMETHING (even if wrong) rather than failing.
export async function classifyFoodPhoto(imageBase64) {
  const data = await callProxy('food', [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: `Look at this photo and classify what's being shown. Pick ONE:

- "barcode" — a product barcode (stripes + digits), typically on packaging
- "label" — a nutrition facts panel (white rectangle, bold "Nutrition Facts" header, table of values)
- "food" — a meal, plate of food, dish, or any food item that isn't a label or barcode

Respond with ONLY one word: barcode, label, or food.` }
    ]
  }], { max_tokens: 20, action: 'classify_food_photo' })

  const raw = (data?.content || [])
    .map(b => b.text || '')
    .join('')
    .trim()
    .toLowerCase()

  if (raw.includes('barcode')) return 'barcode'
  if (raw.includes('label')) return 'label'
  return 'food'
}

export async function readBarcodeFromImage(imageBase64) {
  // Last resort — use Claude to visually read the barcode number from the
  // photo. Anthropic returns a structured response with content blocks,
  // not a plain string, so we need to extract the text properly.
  const data = await callProxy('food', [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: `Look at the barcode in this image (the vertical black lines with numbers beneath).

Read the printed number under the bars — this is a UPC/EAN product code, typically 12-13 digits. Small leading/trailing digits may be offset from the main group (e.g. "1 97870 05291 5" is all part of the code).

Respond with ONLY the digits, no spaces, no other text. If you genuinely cannot read any digits at all, respond with "UNREADABLE".

Examples of good responses:
197870052915
0123456789012
UNREADABLE` }
    ]
  }], { max_tokens: 50, action: 'read_barcode_from_image' })

  // Anthropic responses come back as { content: [{type: 'text', text: '...'}] }
  const raw = (data?.content || [])
    .map(b => b.text || '')
    .join('')
    .trim()
  if (!raw || /unreadable/i.test(raw)) return null
  // Strip anything that isn't a digit, then validate length
  const digits = raw.replace(/\D/g, '')
  if (digits.length >= 6 && digits.length <= 14) return digits
  return null
}

export async function extractRecipeFromPhoto(imageBase64) {
  const data = await callProxy('recipe', [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: `This is a photo of a recipe from a cookbook or recipe card. Extract the complete recipe.

Return ONLY this JSON (no markdown):
{
  "name": "recipe name",
  "description": "one line description",
  "servings": number,
  "serving_label": "serving",
  "ingredients": [
    { "amount": "1", "unit": "cup", "name": "ingredient name" }
  ],
  "instructions": ["Step 1 text", "Step 2 text"],
  "prep_time": "X mins or null",
  "cook_time": "X mins or null",
  "notes": "any tips or notes from the recipe or null"
}

If ingredient has no unit (e.g. "2 eggs"), set unit to "".
Extract every ingredient and every step exactly as written.` }
    ]
  }], { max_tokens: 2000, action: 'extract_recipe_from_photo' })
  return parseJSON(data)
}

export async function generateRecipeFromMood(prompt) {
  const data = await callProxy('recipe', [{
    role: 'user',
    content: `Generate a complete recipe based on this request: "${prompt}"

Create something practical, delicious and realistic for a home cook.
Calculate accurate macros per serving.

Return ONLY this JSON (no markdown):
{
  "name": "Recipe name",
  "description": "One line description",
  "servings": number,
  "serving_label": "serving",
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "fiber": number,
  "sugar": number,
  "ingredients": [{"amount":"1","unit":"cup","name":"ingredient"}],
  "instructions": {"steps":["Step 1","Step 2"],"prep_time":"X mins","cook_time":"X mins","tips":["optional tip"]},
  "notes": "any notes about substitutions or variations"
}`
  }], { max_tokens: 2000, action: 'generate_recipe_from_mood' })
  return parseJSON(data)
}
