const SUPABASE_URL = 'https://rwrcklqpvfvuvwatpbxh.supabase.co'
const ANON_KEY = 'sb_publishable_AYdh_Z4-Xn4yOqqJEvHtYA_PsvRcIvc'

async function verify() {
  console.log('Verifying Supabase tables...')
  const tables = ['goals', 'meal_log', 'meal_planner', 'user_profiles', 'token_usage']
  for (const table of tables) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?limit=1`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }
    })
    console.log(`${res.ok ? '✓' : '❌'} ${table}`)
  }
}
verify().catch(console.error)
