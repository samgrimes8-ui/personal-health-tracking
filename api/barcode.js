/**
 * Vercel Edge Function: /api/barcode?upc=0123456789
 * Looks up a product by barcode in the Open Food Facts database.
 * Free, no API key needed, 3M+ products.
 */

export const config = { runtime: 'edge' }

export default async function handler(req) {
  const url = new URL(req.url)
  const upc = url.searchParams.get('upc')?.replace(/\D/g, '')

  if (!upc) {
    return json({ error: 'Missing upc parameter' }, 400)
  }

  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${upc}?fields=product_name,brands,serving_size,serving_quantity,nutriments,image_url`,
      { headers: { 'User-Agent': 'MacroLens/1.0 (nutrition tracker)' } }
    )
    const data = await res.json()

    if (data.status === 0 || !data.product) {
      return json({ found: false, message: 'Product not found in database' }, 404)
    }

    const p = data.product
    const n = p.nutriments || {}

    // OFF stores per 100g — use serving_quantity if available, else 100g
    const servingG = parseFloat(p.serving_quantity) || 100
    const per100 = (field) => parseFloat(n[field] ?? n[field + '_100g'] ?? 0)

    // Prefer _serving values, fall back to per-100g * serving size
    const getVal = (field) => {
      const serving = parseFloat(n[field + '_serving'])
      if (!isNaN(serving) && serving > 0) return Math.round(serving * 10) / 10
      return Math.round(per100(field) * servingG / 100 * 10) / 10
    }

    return json({
      found: true,
      name: p.product_name || 'Unknown Product',
      brand: p.brands || '',
      serving_size: p.serving_size || `${servingG}g`,
      calories: getVal('energy-kcal') || getVal('energy') && Math.round(getVal('energy') / 4.184),
      protein: getVal('proteins'),
      carbs: getVal('carbohydrates'),
      fat: getVal('fat'),
      fiber: getVal('fiber'),
      sugar: getVal('sugars'),
      sodium: Math.round((getVal('sodium') || 0) * 1000), // convert g to mg
      image_url: p.image_url || null,
      confidence: 'high',
      source: 'barcode'
    })
  } catch (err) {
    return json({ error: 'Lookup failed: ' + err.message }, 500)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  })
}
