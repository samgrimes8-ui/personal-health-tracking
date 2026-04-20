/**
 * Vercel Edge Function: /api/notify-signup
 * Called by Supabase webhook when a new user signs up.
 * Sends an email notification to the admin via Resend.
 */

export const config = { runtime: 'edge' }

export default async function handler(req) {
  // Verify this is from Supabase (shared secret)
  const secret = req.headers.get('x-webhook-secret')
  if (secret !== process.env.WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body
  try { body = await req.json() } catch { return new Response('Bad request', { status: 400 }) }

  const user = body.record
  const email = user?.email || 'unknown'
  const userId = user?.id || 'unknown'
  const joinedAt = user?.created_at ? new Date(user.created_at).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'now'

  // Send email via Resend
  const RESEND_API_KEY = process.env.RESEND_API_KEY
  if (!RESEND_API_KEY) return new Response('No Resend key', { status: 500 })

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'MacroLens <notifications@macrolens.app>',
      to: ['sam.grimes8@gmail.com'],
      subject: `🎉 New MacroLens user: ${email}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#e8c547;margin:0 0 16px">New user joined MacroLens!</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:8px 0;color:#888">Email</td><td style="padding:8px 0;font-weight:600">${email}</td></tr>
            <tr><td style="padding:8px 0;color:#888">User ID</td><td style="padding:8px 0;font-family:monospace;font-size:12px">${userId}</td></tr>
            <tr><td style="padding:8px 0;color:#888">Joined</td><td style="padding:8px 0">${joinedAt} CT</td></tr>
          </table>
          <div style="margin-top:24px">
            <a href="https://personal-health-tracking.vercel.app" 
               style="background:#e8c547;color:#1a1500;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
              Open Admin Panel →
            </a>
          </div>
        </div>
      `
    })
  })

  if (!emailRes.ok) {
    const err = await emailRes.text()
    console.error('Resend error:', err)
    return new Response('Email failed: ' + err, { status: 500 })
  }

  return new Response('OK', { status: 200 })
}
