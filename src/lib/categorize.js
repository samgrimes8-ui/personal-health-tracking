// ─── Ingredient categorizer (client-side fallback) ──────────────────────
//
// The AI is asked to assign a `category` to every ingredient when it
// returns a recipe. In practice the model occasionally drops the field
// — especially on photo-flows where the prompt is heavier. When that
// happens, every ingredient defaults to 'other' and the grocery list
// renders as one undifferentiated blob instead of categorized aisles.
//
// This module is the safety net: if `ing.category` is missing, we try
// to infer it from the ingredient name. ~80% hit rate on common
// cooking ingredients. Returns null when nothing matches (caller then
// falls through to 'other').
//
// Match strategy: substring against a curated list per category. The
// CHECK ORDER MATTERS — more specific keywords are checked first so that
// e.g. "chicken broth" lands in pantry (the literal "chicken broth"
// keyword) rather than protein (the generic "chicken" keyword).
//
// Dictionary stays explicit rather than relying on a stemmer or NLP
// library. Adding/tuning entries is grep-and-edit which is exactly what
// we want when a real recipe surfaces a miss.

// ─── Ingredient name canonicalization (Pass 1 of hybrid dedup) ──────────
//
// Same ingredient gets written different ways across recipes:
//   "garlic cloves" / "garlic" / "cloves of garlic" → all the same thing
//   "chicken breast" / "chicken breasts" / "boneless skinless chicken
//     breast" → all the same thing
//   "scallion" / "green onion" / "spring onion" → all the same thing
//
// When the grocery list groups by name, these become separate rows. The
// keyword normalizer below maps every known variant to a canonical form
// before grouping, so they collapse properly.
//
// Order matters — more specific patterns first. The first rule whose
// pattern matches wins.
//
// Pass 2 (AI dedup) can fill gaps for ingredients we don't have rules
// for. Together: ~95%+ dedup hit rate.

const NAME_CANONICAL_RULES = [
  // ─── Proteins ──────────────────────────────────────────────────────
  // Chicken — canonicalize to "chicken breast" / "chicken thigh" /
  // "chicken" (generic) etc, stripping skin/bone descriptors.
  [/^(boneless,?\s*skinless\s+)?chicken\s+breasts?(\s+halves)?$/i, 'chicken breast'],
  [/^(boneless,?\s*skinless\s+)?chicken\s+thighs?$/i, 'chicken thigh'],
  [/^chicken\s+wings?$/i, 'chicken wings'],
  [/^chicken\s+legs?$/i, 'chicken legs'],
  [/^(whole\s+)?rotisserie\s+chicken$/i, 'rotisserie chicken'],
  [/^ground\s+chicken$/i, 'ground chicken'],

  // Beef
  [/^ground\s+beef(\s+\(\d+%.*\))?$/i, 'ground beef'],
  [/^(beef\s+)?(rib\s*eye|ribeye)\s+steaks?$/i, 'ribeye steak'],
  [/^(beef\s+)?sirloin\s+steaks?$/i, 'sirloin steak'],
  [/^flank\s+steaks?$/i, 'flank steak'],
  [/^skirt\s+steaks?$/i, 'skirt steak'],

  // Pork
  [/^ground\s+pork$/i, 'ground pork'],
  [/^pork\s+chops?$/i, 'pork chop'],
  [/^pork\s+(tender)?loin$/i, 'pork tenderloin'],
  [/^bacon(\s+strips?)?$/i, 'bacon'],
  [/^(italian|breakfast)\s+sausages?$/i, 'sausage'],

  // Turkey
  [/^ground\s+turkey$/i, 'ground turkey'],
  [/^turkey\s+breasts?$/i, 'turkey breast'],

  // Seafood
  [/^salmon\s+(filet|fillet)s?$/i, 'salmon'],
  [/^(raw\s+|peeled\s+|cooked\s+)?shrimps?$/i, 'shrimp'],

  // Eggs
  [/^(large\s+|whole\s+|fresh\s+)?eggs?$/i, 'eggs'],
  [/^egg\s+yolks?$/i, 'egg yolks'],
  [/^egg\s+whites?$/i, 'egg whites'],

  // ─── Produce: aromatics & alliums ──────────────────────────────────
  // Garlic — collapse all forms to "garlic"
  [/^(\d+\s+)?(garlic\s+cloves?|cloves?\s+of\s+garlic|fresh\s+garlic)$/i, 'garlic'],
  [/^(minced\s+|crushed\s+)?garlic$/i, 'garlic'],
  // Note: keep garlic POWDER and garlic SALT as separate items

  // Ginger — fresh ginger / ginger root / gingerroot / ginger → "ginger"
  [/^(fresh\s+)?ginger(\s*root)?$/i, 'ginger'],
  [/^gingerroot$/i, 'ginger'],

  // Onions — strip color qualifiers, collapse to "onion".
  // (User can usually substitute red/yellow/white in most recipes)
  [/^(red|yellow|white|sweet|spanish)\s+onions?$/i, 'onion'],
  [/^onions?$/i, 'onion'],

  // Green onions / scallions / spring onions all the same
  [/^(green\s+onions?|scallions?|spring\s+onions?)$/i, 'green onions'],

  // Shallots
  [/^shallots?$/i, 'shallot'],

  // Leeks
  [/^leeks?$/i, 'leek'],

  // ─── Produce: vegetables ──────────────────────────────────────────
  // Bell peppers — strip color when summing (red/green/yellow/orange).
  // Most recipes accept any color; if user wants color-specific they
  // can edit the canonical entry. This is the one rule where we trade
  // some specificity for fewer rows.
  [/^(red|green|yellow|orange)\s+bell\s+peppers?$/i, 'bell pepper'],
  [/^bell\s+peppers?$/i, 'bell pepper'],

  // Tomatoes — strip variety qualifiers
  [/^(roma|plum|beefsteak|vine[\s-]ripened)\s+tomatoes?$/i, 'tomato'],
  [/^tomatoes?$/i, 'tomato'],
  [/^cherry\s+tomatoes?$/i, 'cherry tomatoes'],
  [/^grape\s+tomatoes?$/i, 'grape tomatoes'],

  // Carrots
  [/^carrots?$/i, 'carrot'],

  // Cucumbers
  [/^(english\s+|persian\s+)?cucumbers?$/i, 'cucumber'],

  // Mushrooms
  [/^(white\s+|button\s+)?mushrooms?$/i, 'mushrooms'],
  [/^(baby\s+)?(cremini|crimini)\s+mushrooms?$/i, 'cremini mushrooms'],

  // Potatoes
  [/^(russet|idaho|yukon\s+gold|baking)\s+potatoes?$/i, 'potato'],
  [/^potatoes?$/i, 'potato'],
  [/^sweet\s+potatoes?$/i, 'sweet potato'],

  // Greens
  [/^(baby\s+)?spinach$/i, 'spinach'],
  [/^(baby\s+)?kale$/i, 'kale'],
  [/^(romaine|iceberg|butter|bibb)\s+lettuce$/i, 'lettuce'],

  // ─── Produce: herbs ───────────────────────────────────────────────
  // Fresh herbs — drop the "fresh" qualifier so they sum together
  [/^fresh\s+(parsley|cilantro|basil|thyme|rosemary|oregano|sage|dill|mint|chives)$/i, '$1'],
  [/^cilantro$/i, 'cilantro'],
  [/^parsley$/i, 'parsley'],

  // ─── Produce: fruits / citrus ─────────────────────────────────────
  // Lemons / limes — common rules across forms
  [/^lemon(\s+wedges?|\s+slices?)?$/i, 'lemon'],
  [/^lemons?$/i, 'lemon'],
  [/^lime(\s+wedges?|\s+slices?)?$/i, 'lime'],
  [/^limes?$/i, 'lime'],

  // ─── Pantry ────────────────────────────────────────────────────────
  // Oils — strip "extra virgin" / "virgin" / etc, but keep oil type
  [/^extra[\s-]?virgin\s+olive\s+oil$/i, 'olive oil'],
  [/^virgin\s+olive\s+oil$/i, 'olive oil'],
  [/^olive\s+oils?$/i, 'olive oil'],
  [/^vegetable\s+oils?$/i, 'vegetable oil'],
  [/^canola\s+oils?$/i, 'canola oil'],
  [/^toasted\s+sesame\s+oil$/i, 'sesame oil'],
  [/^sesame\s+oils?$/i, 'sesame oil'],

  // Soy sauce — light/dark stay separate but normalize plain
  [/^(reduced\s+sodium\s+|low[\s-]sodium\s+)?soy\s+sauces?$/i, 'soy sauce'],

  // Vinegars
  [/^(white|distilled\s+white)\s+vinegars?$/i, 'white vinegar'],
  [/^apple\s+cider\s+vinegars?$/i, 'apple cider vinegar'],
  [/^rice\s+(wine\s+)?vinegars?$/i, 'rice vinegar'],
  [/^(red|white)\s+wine\s+vinegars?$/i, '$1 wine vinegar'],
  [/^balsamic\s+vinegars?$/i, 'balsamic vinegar'],

  // Sugar — collapse plain forms, keep specialty types
  [/^(white\s+|granulated\s+)?sugars?$/i, 'sugar'],
  [/^(light\s+|dark\s+)?brown\s+sugars?$/i, 'brown sugar'],

  // Salt — collapse common forms but keep specialty variants
  [/^(table\s+|fine\s+)?salts?$/i, 'salt'],
  [/^kosher\s+salts?$/i, 'kosher salt'],
  [/^sea\s+salts?$/i, 'sea salt'],

  // Pepper
  [/^(freshly\s+)?(ground\s+)?black\s+peppers?$/i, 'black pepper'],

  // ─── Spices ────────────────────────────────────────────────────────
  // Strip "ground" qualifier from spices that are almost always ground
  [/^ground\s+(cumin|coriander|cinnamon|nutmeg|cloves|allspice|cardamom|turmeric|paprika)$/i, '$1'],
  [/^red\s+pepper\s+flakes$/i, 'red pepper flakes'],
  [/^crushed\s+red\s+pepper(\s+flakes)?$/i, 'red pepper flakes'],

  // ─── Dairy ─────────────────────────────────────────────────────────
  // Butter — collapse salted/unsalted/stick variations
  [/^(unsalted\s+|salted\s+)?butter(\s+sticks?)?$/i, 'butter'],

  // Milk — keep type qualifiers (whole/skim/2%) but collapse "whole milk"
  [/^whole\s+milks?$/i, 'whole milk'],
  [/^skim\s+milks?$/i, 'skim milk'],
  [/^(2%|two\s+percent)\s+milks?$/i, '2% milk'],
  [/^milks?$/i, 'milk'],

  // Cheese
  [/^(shredded\s+|grated\s+|sliced\s+)?(cheddar|mozzarella|parmesan|swiss|provolone|monterey\s+jack|pepper\s+jack)\s+cheeses?$/i, '$2 cheese'],
  [/^(grated\s+|shredded\s+)?parmesan(\s+cheese)?$/i, 'parmesan cheese'],

  // ─── Grains ────────────────────────────────────────────────────────
  // Rice — keep type but strip "long-grain" etc
  [/^(long[\s-]?grain\s+|long[\s-]?grained\s+)?white\s+rice$/i, 'white rice'],
  [/^(long[\s-]?grain\s+)?brown\s+rice$/i, 'brown rice'],
  [/^jasmine\s+rice$/i, 'jasmine rice'],
  [/^basmati\s+rice$/i, 'basmati rice'],

  // Flour
  [/^all[\s-]?purpose\s+flour$/i, 'all-purpose flour'],
  [/^whole\s+wheat\s+flour$/i, 'whole wheat flour'],
]

// Returns canonical form of an ingredient name. If no rule matches,
// returns the original (trimmed, lowercased for consistency).
export function canonicalizeName(name) {
  if (!name || typeof name !== 'string') return ''
  const trimmed = name.trim()
  if (!trimmed) return ''

  for (const [pattern, canonical] of NAME_CANONICAL_RULES) {
    if (pattern.test(trimmed)) {
      // Support backreferences like '$1' so a single rule can capture
      // multiple variants ("red wine vinegar" → "$1 wine vinegar").
      return trimmed.replace(pattern, canonical).toLowerCase()
    }
  }
  return trimmed.toLowerCase()
}

// ─── Amount parser ────────────────────────────────────────────────────
//
// The AI returns ingredient amounts in inconsistent shapes despite the
// schema asking for a number. Examples seen in production:
//   2          → 2
//   "2"        → 2     (numeric string)
//   "1/2"      → 0.5   (fraction string — very common in cookbooks)
//   "1 1/2"    → 1.5   (mixed fraction)
//   "½"        → 0.5   (unicode fraction glyph)
//   "1½"       → 1.5   (mixed unicode fraction)
//   null/""    → 0
//
// parseFloat alone gets these wrong: parseFloat("1/2") returns 1, not
// 0.5 — so when the user has "1/2 cup soy sauce", grocery list math
// reads it as "1 cup". Big silent bug for shopping accuracy. This
// helper is the canonical parser used everywhere ingredient amounts
// are read on the client.

// Map of unicode fraction glyphs to their decimal values. Covers the
// common ones (¼ ½ ¾ ⅓ ⅔ ⅕ ⅖ ⅗ ⅘ ⅙ ⅚ ⅛ ⅜ ⅝ ⅞).
const UNICODE_FRACTIONS = {
  '¼': 0.25,  '½': 0.5,   '¾': 0.75,
  '⅓': 1/3,   '⅔': 2/3,
  '⅕': 0.2,   '⅖': 0.4,   '⅗': 0.6,   '⅘': 0.8,
  '⅙': 1/6,   '⅚': 5/6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
}

export function parseAmount(raw) {
  if (raw == null) return 0
  if (typeof raw === 'number') return isFinite(raw) ? raw : 0
  let s = String(raw).trim()
  if (!s) return 0

  // Replace any unicode fraction glyph with " <decimal>" so mixed forms
  // like "1½" and "1 ½" both work.
  for (const [glyph, val] of Object.entries(UNICODE_FRACTIONS)) {
    if (s.includes(glyph)) s = s.replace(glyph, ' ' + val)
  }
  s = s.trim().replace(/\s+/g, ' ')
  if (!s) return 0

  // Mixed fraction: "1 1/2" or "1 0.5" → 1 + 0.5 = 1.5
  const mixedMatch = s.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (mixedMatch) {
    const whole = parseInt(mixedMatch[1], 10)
    const num = parseInt(mixedMatch[2], 10)
    const den = parseInt(mixedMatch[3], 10)
    if (den !== 0) return whole + (num / den)
  }
  // After unicode replacement, e.g. "1 0.5" → 1.5
  const mixedDecimalMatch = s.match(/^(\d+)\s+([\d.]+)$/)
  if (mixedDecimalMatch) {
    const whole = parseFloat(mixedDecimalMatch[1])
    const frac = parseFloat(mixedDecimalMatch[2])
    if (isFinite(whole) && isFinite(frac)) return whole + frac
  }
  // Plain fraction: "1/2" → 0.5
  const fracMatch = s.match(/^(\d+)\/(\d+)$/)
  if (fracMatch) {
    const num = parseInt(fracMatch[1], 10)
    const den = parseInt(fracMatch[2], 10)
    if (den !== 0) return num / den
  }
  // Fallback: regular number parse. This handles "2", "0.5", "2.5", etc.
  const f = parseFloat(s)
  return isFinite(f) ? f : 0
}

// Order: specific compound terms BEFORE generic ones. Within a
// category, alphabetized for sanity.
const CATEGORY_KEYWORDS = [
  // Pantry: condiments, oils, vinegars, sauces, canned goods, dry pasta.
  // Includes chicken/beef/veg broth which would otherwise hit protein.
  ['pantry', [
    'chicken broth', 'beef broth', 'vegetable broth', 'bone broth', 'stock',
    'tomato paste', 'tomato sauce', 'crushed tomatoes', 'diced tomatoes',
    'soy sauce', 'fish sauce', 'oyster sauce', 'hoisin', 'gochujang',
    'sriracha', 'tahini', 'miso',
    'olive oil', 'vegetable oil', 'avocado oil', 'sesame oil', 'coconut oil',
    'oil',
    'rice vinegar', 'apple cider vinegar', 'balsamic', 'red wine vinegar',
    'white wine vinegar', 'vinegar',
    'mayo', 'mayonnaise', 'aioli',
    'mustard', 'ketchup', 'ranch', 'salsa', 'pesto',
    'honey', 'maple syrup', 'agave',
    'brown sugar', 'powdered sugar', 'sugar',
    'peanut butter', 'almond butter',
    'pasta', 'noodles', 'spaghetti', 'penne', 'fettuccine', 'rigatoni',
    'lasagna', 'macaroni', 'orzo', 'ramen',
    'beans', 'black beans', 'chickpeas', 'lentils', 'kidney beans',
    'cannellini', 'pinto beans', 'navy beans', 'split peas',
    'breadcrumbs', 'panko',
    'cornstarch', 'baking powder', 'baking soda', 'yeast',
    'cocoa', 'chocolate chips', 'vanilla extract',
    'broth', 'bouillon',
  ]],

  // Spices: dried/powdered seasonings.
  ['spices', [
    'garlic powder', 'onion powder', 'chili powder', 'curry powder',
    'cumin', 'paprika', 'turmeric', 'coriander', 'cardamom', 'cinnamon',
    'nutmeg', 'cloves', 'allspice', 'oregano', 'thyme', 'rosemary',
    'basil', 'parsley', 'dill', 'tarragon', 'sage', 'bay leaf', 'bay leaves',
    'red pepper flakes', 'crushed red pepper', 'black pepper', 'white pepper',
    'cayenne', 'pepper',
    'salt', 'kosher salt', 'sea salt', 'flaky salt',
    'taco seasoning', 'italian seasoning', 'cajun seasoning',
    'everything bagel seasoning',
    'sesame seeds', 'poppy seeds', 'fennel seeds',
    'sumac', 'za\'atar', 'gochugaru',
    'spice', 'seasoning',
  ]],

  // Produce: fresh fruits, vegetables, herbs.
  ['produce', [
    // Aromatics — common in almost every recipe
    'garlic', 'ginger', 'shallot', 'leek', 'green onion', 'scallion',
    'spring onion',
    // Onions
    'red onion', 'white onion', 'yellow onion', 'sweet onion', 'onion',
    // Peppers (fresh)
    'bell pepper', 'jalapeno', 'jalapeño', 'serrano', 'poblano', 'habanero',
    'chipotle', 'fresno', 'thai chili', 'chili pepper',
    // Vegetables
    'carrot', 'celery', 'cucumber', 'zucchini', 'squash', 'eggplant',
    'broccoli', 'cauliflower', 'cabbage', 'kale', 'spinach', 'arugula',
    'lettuce', 'romaine', 'mixed greens', 'mesclun',
    'asparagus', 'green beans', 'snap peas', 'snow peas', 'peas',
    'corn', 'corn on the cob',
    'mushroom', 'shiitake', 'cremini', 'portobello', 'oyster mushroom',
    'button mushroom',
    'tomato', 'cherry tomato', 'roma tomato', 'beefsteak',
    'potato', 'russet', 'yukon', 'fingerling', 'sweet potato', 'yam',
    'beet', 'turnip', 'parsnip', 'radish', 'rutabaga',
    'avocado', 'cilantro', 'mint', 'chive', 'fresh basil', 'fresh thyme',
    'fresh oregano', 'fresh rosemary', 'fresh parsley', 'fresh dill',
    // Fruits
    'apple', 'banana', 'orange', 'lemon', 'lime', 'grapefruit',
    'lemon juice', 'lime juice', 'orange juice',
    'lemon zest', 'lime zest', 'orange zest', 'zest',
    'berry', 'berries', 'strawberry', 'strawberries', 'blueberry',
    'blueberries', 'raspberry', 'blackberry',
    'grape', 'pear', 'peach', 'plum', 'cherry', 'cherries',
    'mango', 'pineapple', 'kiwi', 'pomegranate', 'cranberry',
    'watermelon', 'cantaloupe', 'honeydew', 'melon',
  ]],

  // Protein: meat, poultry, seafood, eggs, tofu.
  ['protein', [
    // Beef cuts
    'ground beef', 'ribeye', 'sirloin', 'flank steak', 'skirt steak',
    'tenderloin', 'brisket', 'short ribs', 'chuck roast', 'beef',
    'steak',
    // Chicken
    'ground chicken', 'chicken breast', 'chicken thigh', 'chicken wings',
    'chicken legs', 'rotisserie chicken', 'whole chicken', 'chicken',
    // Pork
    'ground pork', 'pork belly', 'pork shoulder', 'pork chop',
    'pork tenderloin', 'bacon', 'ham', 'prosciutto', 'pancetta',
    'sausage', 'chorizo', 'pork',
    // Turkey
    'ground turkey', 'turkey breast', 'turkey',
    // Lamb
    'ground lamb', 'lamb chop', 'lamb shoulder', 'lamb',
    // Seafood
    'salmon', 'tuna', 'cod', 'halibut', 'tilapia', 'shrimp', 'prawns',
    'scallops', 'lobster', 'crab', 'mussels', 'clams', 'oysters',
    'fish', 'anchovies', 'sardines',
    // Vegetarian
    'tofu', 'tempeh', 'seitan', 'edamame',
    // Eggs (always fresh)
    'egg', 'eggs', 'egg yolk', 'egg white',
  ]],

  // Dairy
  ['dairy', [
    'milk', 'whole milk', 'skim milk', '2% milk', 'oat milk', 'almond milk',
    'soy milk', 'coconut milk',
    'heavy cream', 'half and half', 'half-and-half', 'whipping cream',
    'cream',
    'butter', 'unsalted butter', 'salted butter',
    'sour cream', 'creme fraiche', 'crème fraîche',
    'yogurt', 'greek yogurt',
    'cream cheese',
    'cheese', 'cheddar', 'mozzarella', 'parmesan', 'feta', 'goat cheese',
    'gouda', 'gruyere', 'swiss', 'provolone', 'monterey jack', 'pepper jack',
    'brie', 'ricotta', 'cotija', 'queso fresco', 'manchego', 'asiago',
    'blue cheese', 'gorgonzola',
    'cottage cheese',
  ]],

  // Grains: rice, bread (the dry kind), flour, oats, etc.
  ['grains', [
    'white rice', 'brown rice', 'jasmine rice', 'basmati rice',
    'sushi rice', 'arborio rice', 'wild rice', 'rice',
    'quinoa', 'farro', 'barley', 'bulgur', 'couscous', 'millet',
    'oats', 'rolled oats', 'steel cut oats', 'oatmeal',
    'flour', 'all-purpose flour', 'bread flour', 'whole wheat flour',
    'almond flour', 'coconut flour',
    'cornmeal', 'polenta', 'grits',
    'tortilla', 'tortillas', 'corn tortilla', 'flour tortilla',
    'pita', 'naan',
  ]],

  // Bakery: fresh bread, rolls, pastries.
  ['bakery', [
    'bread', 'sourdough', 'baguette', 'ciabatta', 'focaccia',
    'rolls', 'dinner rolls', 'hamburger buns', 'hot dog buns',
    'bagel', 'bagels', 'english muffin', 'english muffins',
    'croissant', 'biscuit', 'biscuits',
  ]],

  // Frozen: only items that are categorically frozen (not fresh→frozen).
  // We don't try to detect "frozen X" prefix — too brittle. The AI is
  // expected to use this category for explicitly frozen items.
  ['frozen', [
    'frozen vegetables', 'frozen peas', 'frozen corn', 'frozen broccoli',
    'frozen spinach', 'frozen berries', 'frozen fruit', 'ice cream',
  ]],

  // Beverages used in cooking
  ['beverages', [
    'wine', 'red wine', 'white wine', 'cooking wine', 'sake', 'mirin',
    'beer', 'sparkling water', 'club soda',
  ]],
]

// Returns category key (e.g. 'produce') or null if no match.
// Caller is expected to fall through to 'other' on null.
export function categorizeByName(name) {
  if (!name || typeof name !== 'string') return null
  const lower = name.toLowerCase().trim()
  if (!lower) return null

  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const kw of keywords) {
      // Use word-boundary matching to avoid false positives like
      // "carrot" matching "carrot cake" → produce (correct) but
      // also "macaroni" matching "ron" → not happening here because
      // we use whole keywords with substring match. Specific compound
      // keywords come first so they win against generic ones.
      if (lower.includes(kw)) return category
    }
  }
  return null
}

// Convenience: returns a string category, with 'other' as fallback.
// Useful when the caller doesn't want to handle null.
export function categorizeOrOther(name) {
  return categorizeByName(name) || 'other'
}
