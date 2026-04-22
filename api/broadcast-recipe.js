// Fetch a single recipe referenced inside a published broadcast.
// Auth model: the caller supplies the broadcast's share_token, which proves
// they have access to that broadcast. We verify the broadcast is published
// and that the recipe_id actually appears in its plan_data, then return the
// recipe JSON. This lets any follower view any recipe inside a plan they're
// looking at, without requiring direct cross-user RLS on the recipes table.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  const { broadcast_token, recipe_id } = req.query

  if (!broadcast_token || !recipe_id) {
    return res.status(400).json({ error: 'Missing broadcast_token or recipe_id' })
  }

  // 1) Verify the broadcast exists, is published, and references this recipe
  const { data: broadcast, error: bErr } = await supabase
    .from('provider_broadcasts')
    .select('plan_data, is_published')
    .eq('share_token', broadcast_token)
    .maybeSingle()

  if (bErr || !broadcast) {
    return res.status(404).json({ error: 'Broadcast not found' })
  }
  if (!broadcast.is_published) {
    return res.status(403).json({ error: 'Broadcast is not published' })
  }

  const referenced = (broadcast.plan_data || []).some(m => m.recipe_id === recipe_id)
  if (!referenced) {
    return res.status(403).json({ error: 'Recipe not part of this broadcast' })
  }

  // 2) Fetch the recipe via service-role (bypasses RLS)
  const { data: recipe, error: rErr } = await supabase
    .from('recipes')
    .select('*')
    .eq('id', recipe_id)
    .maybeSingle()

  if (rErr || !recipe) {
    return res.status(404).json({ error: 'Recipe not found' })
  }

  // Strip sensitive/irrelevant fields before returning
  const { user_id, ...safe } = recipe
  res.status(200).json(safe)
}
