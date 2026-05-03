// ─── Computer Calories display layer ───────────────────────────────────────────────
//
// Internally we track everything in USD (cost_usd in DB, spend caps in
// check_spend_limit, etc — because that's what we actually pay Anthropic).
// But raw dollar amounts shown to users feel scary and small ($0.30/mo
// sounds like a pittance, $0.027 used looks like nothing). Users are also
// conditioned to understand "credits/gems/points" pricing from games and
// SaaS.
//
// This module converts internal dollars → user-facing "Computer Calories" with a
// 1,000× multiplier. So:
//   Free tier  ($0.30/mo) →    300 Computer Calories
//   Premium   ($10.00/mo) → 10,000 Computer Calories
//   Typical action (~$0.002) → ~2 Computer Calories
//
// Every user-facing display of AI spending/usage should go through these
// helpers. Internal logic (spend limit checks, cost calculations) continues
// to work in dollars.
export const AI_BUCKS_PER_DOLLAR = 1000

// USD → Computer Calories (display units). Rounds to a whole number because fractional
// bucks look silly. Rounded toward zero so we never OVERSTATE someone's
// remaining balance (off-by-one on "used" is less bad than telling someone
// they have 5 bucks when they actually have 4).
export function usdToBucks(usd) {
  if (usd == null || isNaN(usd)) return 0
  return Math.floor(Number(usd) * AI_BUCKS_PER_DOLLAR)
}

// Computer Calories → USD. Rarely needed (most conversion is the other direction)
// but handy if we ever accept a credit purchase and need to convert back.
export function bucksToUsd(bucks) {
  if (bucks == null || isNaN(bucks)) return 0
  return Number(bucks) / AI_BUCKS_PER_DOLLAR
}

// Pretty-format a USD amount as "1,234 Computer Calories". Handles commas, zero, null.
export function formatBucks(usd) {
  const n = usdToBucks(usd)
  return n.toLocaleString('en-US') + ' Computer Calories'
}

// Shorthand for when we just want the number, formatted.
export function bucksCount(usd) {
  return usdToBucks(usd).toLocaleString('en-US')
}

// ─── User-facing tiers ────────────────────────────────────────────────────
// Only these show up on the upgrade page. Provider is excluded because
// you can't pay to become one — that's an application/approval flow.
export const TIERS = [
  {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    priceLabel: '$0',
    aiBucks: usdToBucks(0.10),
    description: 'Log meals, plan, and try AI features',
    features: [
      { included: true,  text: 'Log meals manually (Quick Log)' },
      { included: true,  text: 'Browse and save recipes' },
      { included: true,  text: 'Build weekly meal plans' },
      { included: true,  text: 'Track macros and goals' },
      { included: true,  text: `${usdToBucks(0.10).toLocaleString('en-US')} Computer Calories/month (try it out)` },
      { included: false, text: 'Grocery list generator' },
      { included: false, text: 'Unlimited AI photo/barcode/recipe scans' },
    ],
  },
  {
    id: 'premium',
    name: 'Premium',
    priceUsd: 10,
    priceLabel: '$10',
    aiBucks: usdToBucks(10.00),
    description: 'Unlock all AI features with a generous monthly allotment',
    featured: true,
    features: [
      { included: true, text: 'Everything in Free' },
      { included: true, text: `${usdToBucks(10.00).toLocaleString('en-US')} Computer Calories/month` },
      { included: true, text: '📸 Photo meal analysis' },
      { included: true, text: '📷 Barcode scanning' },
      { included: true, text: '🔗 Recipe import from photos/URLs' },
      { included: true, text: '🗓️ AI meal planner' },
      { included: true, text: '🛒 Auto-generated grocery lists' },
      { included: true, text: '🧠 Smart recipe search' },
    ],
  },
]

// Returns the next tier above a given role, or null if already at the top
// user-facing tier. Used to decide what upgrade CTA to show.
export function nextTierFromRole(role) {
  if (role === 'free') return TIERS.find(t => t.id === 'premium')
  return null // premium or provider — nothing to upsell to
}
