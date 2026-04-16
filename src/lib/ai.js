import { checkSpendLimit, recordTokenUsage } from './db.js'

const ANTHROPIC_MODEL = 'claude-sonnet-4-5'

// Anthropic pricing per 1M tokens (must match model_pricing table)
const PRICING = {
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'claude-opus-4-5':   { input: 15.00, output: 75.00 },
  'claude-haiku-4-5':  { input: 0.80, output: 4.00 },
}

function estimateCost(model, inputTokens, outputTokens) {
  const p = PRICING[model] ?? PRICING[ANTHROPIC_MODEL]
  return (inputTokens * p.input / 1_000_000) + (outputTokens * p.output / 1_000_000)
}

async function callAnthropic(apiKey, body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message)
  return data
}

async function gateAndRecord(userId, model, feature, apiFn) {
  // Estimate ~1500 tokens for a typical request before calling
  const estimated = estimateCost(model, 1000, 500)
  const check = await checkSpendLimit(userId, estimated)

  if (!check.allowed) {
    if (check.reason === 'spending_limit_exceeded') {
      throw new Error(
        `Monthly spending limit reached ($${Number(check.limit_usd).toFixed(2)}). ` +
        `You've used $${Number(check.spent_usd).toFixed(4)} this month. ` +
        `Limit resets on the 1st.`
      )
    }
    if (check.reason === 'account_suspended') {
      throw new Error('Your account has been suspended. Please contact support.')
    }
    throw new Error('Request not allowed: ' + (check.reason ?? 'unknown'))
  }

  const data = await apiFn()

  // Record actual usage from response
  const inputTokens = data.usage?.input_tokens ?? 0
  const outputTokens = data.usage?.output_tokens ?? 0
  await recordTokenUsage(userId, { inputTokens, outputTokens, model, feature })

  return data
}

const JSON_PROMPT = `Respond ONLY with a JSON object, no markdown, no explanation. Format:
{"name":"meal name","description":"brief 1-sentence description","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"servings":number,"confidence":"low|medium|high","notes":"any important caveats"}`

export async function analyzePhoto(apiKey, imageBase64, mealHint, userId) {
  const data = await gateAndRecord(userId, ANTHROPIC_MODEL, 'photo', () =>
    callAnthropic(apiKey, {
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: `Analyze this food image${mealHint ? ` (meal: ${mealHint})` : ''} and estimate nutritional content per serving. ${JSON_PROMPT}` }
        ]
      }]
    })
  )
  return parseResult(data)
}

export async function analyzeRecipe(apiKey, recipe, mealHint, userId) {
  const data = await gateAndRecord(userId, ANTHROPIC_MODEL, 'recipe', () =>
    callAnthropic(apiKey, {
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Analyze this recipe and estimate macros per serving:\n\n${recipe}${mealHint ? `\n\nMeal name: ${mealHint}` : ''}\n\n${JSON_PROMPT}`
      }]
    })
  )
  return parseResult(data)
}

export async function analyzeDishBySearch(apiKey, dishName, link, userId) {
  const query = link
    ? `Search for the recipe "${dishName}" and find its ingredients and serving size. URL for context: ${link}`
    : `Search for the recipe "${dishName}" and find its full ingredients and serving size.`

  const data = await gateAndRecord(userId, ANTHROPIC_MODEL, 'search', () =>
    callAnthropic(apiKey, {
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: `${query}\n\nOnce you find the recipe, estimate the macros per serving. ${JSON_PROMPT}` }]
    })
  )
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('')
  if (!text) throw new Error('No response — try being more specific with the dish name')
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Could not parse — try the Recipe tab and paste ingredients directly')
  return JSON.parse(match[0])
}

export async function analyzePlannerDescription(apiKey, description, userId) {
  const data = await gateAndRecord(userId, ANTHROPIC_MODEL, 'planner', () =>
    callAnthropic(apiKey, {
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Analyze this meal/recipe and estimate macros per serving:\n\n${description}\n\nRespond ONLY with a JSON object, no markdown. Format:\n{"name":"meal name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"confidence":"low|medium|high"}`
      }]
    })
  )
  return parseResult(data)
}

export async function extractIngredients(apiKey, recipeName, description, servings, userId) {
  const data = await gateAndRecord(userId, ANTHROPIC_MODEL, 'recipe', () =>
    callAnthropic(apiKey, {
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      messages: [{
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
      }]
    })
  )
  const text = data.content.map(i => i.text || '').join('').replace(/```json|```/g, '').trim()
  return JSON.parse(text)
}

export async function recalculateMacros(apiKey, recipeName, ingredients, servings, userId) {
  const ingredientList = ingredients.map(i => `${i.amount} ${i.unit} ${i.name}`.trim()).join('\n')
  const data = await gateAndRecord(userId, ANTHROPIC_MODEL, 'recipe', () =>
    callAnthropic(apiKey, {
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Calculate the macros per serving for this recipe (${servings} total servings):

Ingredients:
${ingredientList}

Respond ONLY with a JSON object, no markdown:
{"calories": number, "protein": number, "carbs": number, "fat": number, "fiber": number, "sugar": number, "confidence": "low|medium|high", "notes": "any caveats"}`
      }]
    })
  )
  const text = data.content.map(i => i.text || '').join('').replace(/```json|```/g, '').trim()
  return JSON.parse(text)
}

function parseResult(data) {
  const text = data.content.map(i => i.text || '').join('').replace(/```json|```/g, '').trim()
  return JSON.parse(text)
}
