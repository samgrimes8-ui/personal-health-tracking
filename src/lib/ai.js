/**
 * AI module — all Anthropic calls go through /api/analyze (server-side proxy).
 * The Anthropic API key never touches the browser.
 */

import { supabase } from './supabase.js'

const ANTHROPIC_MODEL = 'claude-sonnet-4-5'

// ─── Core proxy caller ────────────────────────────────────────────────────────

async function callProxy(feature, messages, options = {}) {
  // Get the user's current session JWT to authenticate with the proxy
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify({
      feature,
      messages,
      max_tokens: options.max_tokens ?? 1500,
      ...(options.tools ? { tools: options.tools } : {})
    })
  })

  const data = await res.json()

  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`)
  }

  return data
}

// ─── Helper: extract text from Anthropic response ────────────────────────────

function parseJSON(data) {
  const text = data.content
    .map(i => i.text || '')
    .join('')
    .replace(/```json|```/g, '')
    .trim()
  return JSON.parse(text)
}

// ─── Food analysis ────────────────────────────────────────────────────────────

const JSON_PROMPT = `Respond ONLY with a JSON object, no markdown, no explanation. Format:
{"name":"meal name","description":"brief 1-sentence description","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"servings":number,"confidence":"low|medium|high","notes":"any important caveats"}`

export async function analyzePhoto(imageBase64, mealHint) {
  const data = await callProxy('photo', [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: `Analyze this food image${mealHint ? ` (meal: ${mealHint})` : ''} and estimate nutritional content per serving. ${JSON_PROMPT}` }
    ]
  }])
  return parseJSON(data)
}

export async function analyzeRecipe(recipe, mealHint) {
  const data = await callProxy('recipe', [{
    role: 'user',
    content: `Analyze this recipe and estimate macros per serving:\n\n${recipe}${mealHint ? `\n\nMeal name: ${mealHint}` : ''}\n\n${JSON_PROMPT}`
  }])
  return parseJSON(data)
}

export async function analyzeDishBySearch(dishName, link) {
  const query = link
    ? `Search for the recipe "${dishName}" and find its ingredients and serving size. URL for context: ${link}`
    : `Search for the recipe "${dishName}" and find its full ingredients and serving size.`

  const data = await callProxy('search', [{
    role: 'user',
    content: `${query}\n\nOnce you find the recipe, estimate the macros per serving. ${JSON_PROMPT}`
  }], {
    max_tokens: 2000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
  })

  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('')
  if (!text) throw new Error('No response — try being more specific with the dish name')
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Could not parse — try the Recipe tab and paste ingredients directly')
  return JSON.parse(match[0])
}

export async function analyzePlannerDescription(description) {
  const data = await callProxy('planner', [{
    role: 'user',
    content: `Analyze this meal/recipe and estimate macros per serving:\n\n${description}\n\nRespond ONLY with a JSON object, no markdown. Format:\n{"name":"meal name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"confidence":"low|medium|high"}`
  }], { max_tokens: 500 })
  return parseJSON(data)
}

export async function extractIngredients(recipeName, description, servings) {
  const data = await callProxy('recipe', [{
    role: 'user',
    content: `For this recipe: "${recipeName}"${description ? `\n\nContext: ${description}` : ''}

Extract the complete ingredient list needed to cook this recipe for ${servings} serving(s).
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
