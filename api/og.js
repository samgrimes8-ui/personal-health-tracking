// Fetch Open Graph metadata for a URL server-side
// Handles CORS, user-agent spoofing, and Instagram fallback

const BLOCKED_DOMAINS = ['instagram.com', 'tiktok.com', 'facebook.com', 'twitter.com', 'x.com']
const TIMEOUT_MS = 6000

function getDomain(url) {
  try { return new URL(url).hostname.replace('www.', '') }
  catch { return url }
}

function isBlocked(url) {
  const domain = getDomain(url)
  return BLOCKED_DOMAINS.some(d => domain.includes(d))
}

function extractOG(html, url) {
  const meta = (prop) => {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    ]
    for (const p of patterns) {
      const m = html.match(p)
      if (m?.[1]) return m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim()
    }
    return null
  }

  const title = meta('title') ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || null
  const image = meta('image') || meta('image:url') || null
  const description = meta('description') || null
  const siteName = meta('site_name') || getDomain(url)

  return { title, image, description, siteName, url }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'Missing url' })

  let parsedUrl
  try { parsedUrl = new URL(url) }
  catch { return res.status(400).json({ error: 'Invalid URL' }) }

  const domain = getDomain(url)

  // Blocked domains — return clean fallback immediately
  if (isBlocked(url)) {
    return res.status(200).json({
      title: null,
      image: null,
      description: null,
      siteName: domain,
      url,
      blocked: true,
    })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MacroLensBot/1.0; +https://macrolens.app)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    })
    clearTimeout(timeout)

    if (!response.ok) {
      return res.status(200).json({ title: null, image: null, description: null, siteName: domain, url, error: `HTTP ${response.status}` })
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) {
      return res.status(200).json({ title: null, image: null, description: null, siteName: domain, url })
    }

    // Only read first 50KB — enough for OG tags in <head>
    const reader = response.body.getReader()
    let html = ''
    let bytes = 0
    while (bytes < 50000) {
      const { done, value } = await reader.read()
      if (done) break
      html += new TextDecoder().decode(value)
      bytes += value?.length || 0
    }
    reader.cancel()

    const og = extractOG(html, url)
    return res.status(200).json(og)
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(200).json({ title: null, image: null, description: null, siteName: domain, url, error: 'timeout' })
    }
    return res.status(200).json({ title: null, image: null, description: null, siteName: domain, url, error: err.message })
  }
}
