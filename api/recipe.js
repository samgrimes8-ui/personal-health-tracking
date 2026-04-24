// Legacy public recipe endpoint — /api/recipe?token=xxx
//
// This endpoint used to render the full public recipe page itself (with
// its own Supabase query, its own HTML template, its own copy). After
// consolidation, the canonical share URL is /api/recipe/[token] (path
// param) served by api/recipe/[token].js.
//
// We keep this endpoint alive as a 301 redirect so any old share links
// already sitting in text threads, DMs, or bookmarks continue to work.
// They'll just make one extra hop to the new URL.
//
// Eventually (when no legacy links are in circulation) this file can
// be deleted entirely.

export default function handler(req, res) {
  const { token } = req.query || {}
  if (!token) {
    // No token at all — bounce to the app homepage rather than rendering
    // a bespoke 404 page that would just duplicate what [token].js has.
    res.setHeader('Location', 'https://personal-health-tracking.vercel.app')
    return res.status(302).send('')
  }
  // 301 Moved Permanently — caches aggressively, signals to link previewers
  // (iMessage, Slack) that the new URL is the real one.
  res.setHeader('Location', `/api/recipe/${encodeURIComponent(token)}`)
  return res.status(301).send('')
}
