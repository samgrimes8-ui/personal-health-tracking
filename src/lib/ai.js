/**
 * AI module — all Anthropic calls go through /api/analyze (server-side proxy).
 * The Anthropic API key never touches the browser.
 */

import { supabase } from './supabase.js'

// ─── Core proxy caller ────────────────────────────────────────────────────────

async function callProxy(feature, messages, options = {}) {
  // Always refresh session to avoid expired JWT errors
  let session
  try {
    const { data, error } = await supabase.auth.getSession()
    if (error) throw error
    session = data.session
    // Refresh if expiring within 60 seconds
    if (session && session.expires_at && session.expires_at * 1000 < Date.now() + 60000) {
      const { data: refreshed } = await supabase.auth.refreshSession()
      if (refreshed?.session) session = refreshed.session
    }
  } catch (e) {
    // Session fetch failed — try forcing a refresh
    const { data: refreshed } = await supabase.auth.refreshSession()
    session = refreshed?.session
  }
  if (!session?.access_token) throw new Error('Session expired — please refresh the page')

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify({
      feature,
      messages,
      max_tokens: options.max_tokens ?? 2000,
      ...(options.tools ? { tools: options.tools } : {})
    })
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
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
- category must be exactly one of: produce, protein, dairy, pantry, spices, grains, frozen, bakery, beverages
  - produce: fresh fruits, vegetables, herbs
  - protein: meat, poultry, fish, eggs, tofu, beans
  - dairy: milk, cheese, butter, cream, yogurt
  - pantry: oils, canned goods, sauces, vinegar, broth, pasta, condiments
  - spices: dried spices, salt, pepper, seasonings
  - grains: rice, bread, flour, oats, quinoa
  - frozen: frozen vegetables, frozen proteins
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
  }], { max_tokens: 3000 })
  return parseJSON(data)
}

export async function analyzeRecipe(recipe, mealHint) {
  const data = await callProxy('recipe', [{
    role: 'user',
    content: `Analyze this recipe and estimate macros + list all ingredients needed per serving:\n\n${recipe}${mealHint ? `\n\nMeal name: ${mealHint}` : ''}\n\n${FULL_ANALYSIS_PROMPT}`
  }], { max_tokens: 2000 })
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
    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
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
  }], { max_tokens: 600 })
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
  }], { max_tokens: 1500 })
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
  }], { max_tokens: 800 })
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
  }], { max_tokens: 600 })
  return parseJSON(data)
}

export async function analyzeNutritionLabel(imageBase64) {
  // Reads a nutrition facts panel photo
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
  }], { max_tokens: 600 })
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
  }], { max_tokens: 1500 })

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
      { type: 'text', text: `This is a body composition report (InBody, DEXA, or similar scan). Extract all numeric metrics you can find.

InBody typically shows: Weight, Skeletal Muscle Mass, Body Fat Mass, PBF (body fat %), Visceral Fat Level, BMR, ECW/TBW ratio.
DEXA typically shows: Total mass, Fat mass, Lean mass, bone density, regional fat.

Return ONLY this JSON (null for anything not found):
{
  "scan_type": "inbody|dexa|other",
  "weight_kg": number|null,
  "body_fat_pct": number|null,
  "muscle_mass_kg": number|null,
  "bone_mass_kg": number|null,
  "water_pct": number|null,
  "visceral_fat": number|null,
  "bmr": number|null,
  "scan_date": "YYYY-MM-DD"|null,
  "notes": "key findings in one sentence"
}` }
    ]
  }], { max_tokens: 600 })
  return parseJSON(data)
}
