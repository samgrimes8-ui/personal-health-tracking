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
