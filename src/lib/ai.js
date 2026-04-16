import { recordTokenUsage } from './db.js'

const ANTHROPIC_MODEL = 'claude-sonnet-4-5'

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

const JSON_PROMPT = `Respond ONLY with a JSON object, no markdown, no explanation. Format:
{"name":"meal name","description":"brief 1-sentence description","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"servings":number,"confidence":"low|medium|high","notes":"any important caveats"}`

export async function analyzePhoto(apiKey, imageBase64, mealHint, userId) {
  const data = await callAnthropic(apiKey, {
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
  await recordTokenUsage(userId, { tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens ?? 0, model: ANTHROPIC_MODEL, feature: 'photo' })
  return parseResult(data)
}

export async function analyzeRecipe(apiKey, recipe, mealHint, userId) {
  const data = await callAnthropic(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Analyze this recipe and estimate macros per serving:\n\n${recipe}${mealHint ? `\n\nMeal name: ${mealHint}` : ''}\n\n${JSON_PROMPT}`
    }]
  })
  await recordTokenUsage(userId, { tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens ?? 0, model: ANTHROPIC_MODEL, feature: 'recipe' })
  return parseResult(data)
}

export async function analyzeDishBySearch(apiKey, dishName, link, userId) {
  const query = link
    ? `Search for the recipe "${dishName}" and find its ingredients and serving size. URL for context: ${link}`
    : `Search for the recipe "${dishName}" and find its full ingredients and serving size.`

  const data = await callAnthropic(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 2000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: `${query}\n\nOnce you find the recipe, estimate the macros per serving. ${JSON_PROMPT}` }]
  })
  await recordTokenUsage(userId, { tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens ?? 0, model: ANTHROPIC_MODEL, feature: 'search' })
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('')
  if (!text) throw new Error('No response — try being more specific with the dish name')
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Could not parse — try the Recipe tab and paste ingredients directly')
  return JSON.parse(match[0])
}

export async function analyzePlannerDescription(apiKey, description, userId) {
  const data = await callAnthropic(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analyze this meal/recipe and estimate macros per serving:\n\n${description}\n\nRespond ONLY with a JSON object, no markdown. Format:\n{"name":"meal name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"confidence":"low|medium|high"}`
    }]
  })
  await recordTokenUsage(userId, { tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens ?? 0, model: ANTHROPIC_MODEL, feature: 'planner' })
  return parseResult(data)
}

function parseResult(data) {
  const text = data.content.map(i => i.text || '').join('').replace(/```json|```/g, '').trim()
  return JSON.parse(text)
}
