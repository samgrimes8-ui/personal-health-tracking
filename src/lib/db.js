import { supabase } from './supabase.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function getLocalFallback(key, def) {
  try { return JSON.parse(localStorage.getItem(key)) ?? def } catch { return def }
}
function setLocalFallback(key, val) {
  localStorage.setItem(key, JSON.stringify(val))
}

// ─── User Profile ────────────────────────────────────────────────────────────

export async function getProfile(userId) {
  if (!supabase) return getLocalFallback('macrolens_goals', { calories: 2000, protein: 150, carbs: 200, fat: 65 })
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data
}

export async function upsertProfile(userId, profile) {
  if (!supabase) { setLocalFallback('macrolens_goals', profile); return profile }
  const { data, error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: userId, ...profile, updated_at: new Date().toISOString() })
    .select()
    .single()
  if (error) throw error
  return data
}

// ─── Goals ───────────────────────────────────────────────────────────────────

export async function getGoals(userId) {
  if (!supabase) return getLocalFallback('macrolens_goals', { calories: 2000, protein: 150, carbs: 200, fat: 65 })
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data ?? { calories: 2000, protein: 150, carbs: 200, fat: 65 }
}

export async function saveGoals(userId, goals) {
  if (!supabase) { setLocalFallback('macrolens_goals', goals); return goals }
  const { data, error } = await supabase
    .from('goals')
    .upsert({ user_id: userId, ...goals, updated_at: new Date().toISOString() })
    .select()
    .single()
  if (error) throw error
  return data
}

// ─── Meal Log ────────────────────────────────────────────────────────────────

export async function getMealLog(userId, { limit = 200, fromDate } = {}) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_log', [])
    if (fromDate) return all.filter(e => new Date(e.logged_at || e.timestamp) >= new Date(fromDate))
    return all.slice(0, limit)
  }
  let query = supabase
    .from('meal_log')
    .select('*')
    .eq('user_id', userId)
    .order('logged_at', { ascending: false })
    .limit(limit)
  if (fromDate) query = query.gte('logged_at', fromDate)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function addMealEntry(userId, entry) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_log', [])
    const newEntry = { ...entry, id: Date.now(), logged_at: new Date().toISOString() }
    all.unshift(newEntry)
    setLocalFallback('macrolens_log', all)
    return newEntry
  }
  const { data, error } = await supabase
    .from('meal_log')
    .insert({
      user_id: userId,
      name: entry.name,
      calories: entry.calories ?? 0,
      protein: entry.protein ?? 0,
      carbs: entry.carbs ?? 0,
      fat: entry.fat ?? 0,
      fiber: entry.fiber ?? 0,
      sugar: entry.sugar ?? 0,
      confidence: entry.confidence ?? 'medium',
      notes: entry.notes ?? '',
      logged_at: new Date().toISOString()
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateMealEntry(userId, id, updates) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_log', [])
    const idx = all.findIndex(e => e.id === id)
    if (idx !== -1) { all[idx] = { ...all[idx], ...updates }; setLocalFallback('macrolens_log', all) }
    return all[idx]
  }
  const { data, error } = await supabase
    .from('meal_log')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteMealEntry(userId, id) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_log', [])
    setLocalFallback('macrolens_log', all.filter(e => e.id !== id))
    return
  }
  const { error } = await supabase
    .from('meal_log')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

// ─── Meal Planner ────────────────────────────────────────────────────────────

export async function getPlannerWeek(userId, weekStart) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_planner', { meals: Array(7).fill([]) })
    return all
  }
  const { data, error } = await supabase
    .from('meal_planner')
    .select('*')
    .eq('user_id', userId)
    .eq('week_start_date', weekStart)
    .order('day_of_week')
  if (error) throw error
  // Convert rows to { meals: [[], [], ...] } shape
  const meals = Array.from({ length: 7 }, () => [])
  ;(data ?? []).forEach(row => meals[row.day_of_week].push(row))
  return { meals }
}

export async function addPlannerMeal(userId, weekStart, dayIdx, meal) {
  if (!supabase) {
    const planner = getLocalFallback('macrolens_planner', { meals: Array(7).fill(null).map(() => []) })
    planner.meals[dayIdx].push(meal)
    setLocalFallback('macrolens_planner', planner)
    return { ...meal, id: Date.now() }
  }
  const { data, error } = await supabase
    .from('meal_planner')
    .insert({
      user_id: userId,
      week_start_date: weekStart,
      day_of_week: dayIdx,
      meal_name: meal.name,
      calories: meal.calories ?? 0,
      protein: meal.protein ?? 0,
      carbs: meal.carbs ?? 0,
      fat: meal.fat ?? 0,
      fiber: meal.fiber ?? 0,
      is_leftover: meal.leftover ?? false
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updatePlannerMeal(userId, id, updates) {
  if (!supabase) return updates
  const { data, error } = await supabase
    .from('meal_planner')
    .update({
      meal_name: updates.name,
      calories: updates.calories,
      protein: updates.protein,
      carbs: updates.carbs,
      fat: updates.fat,
      fiber: updates.fiber,
      is_leftover: updates.leftover
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deletePlannerMeal(userId, id) {
  if (!supabase) return
  const { error } = await supabase
    .from('meal_planner')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

// ─── Token Usage ─────────────────────────────────────────────────────────────

export async function recordTokenUsage(userId, { tokensUsed, model, feature }) {
  if (!supabase) return
  await supabase.from('token_usage').insert({
    user_id: userId,
    tokens_used: tokensUsed,
    model,
    feature
  })
}

export async function getTokenUsageThisMonth(userId) {
  if (!supabase) return 0
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)
  const { data, error } = await supabase
    .from('token_usage')
    .select('tokens_used')
    .eq('user_id', userId)
    .gte('created_at', startOfMonth.toISOString())
  if (error) throw error
  return (data ?? []).reduce((sum, r) => sum + (r.tokens_used ?? 0), 0)
}
