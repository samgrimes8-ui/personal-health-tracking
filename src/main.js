import './style.css'
import { supabase } from './lib/supabase.js'
import { onAuthStateChange } from './lib/auth.js'
import { renderAuthPage, renderResetPasswordPage } from './pages/auth.js'
import { initApp } from './pages/app.js'
import { initCapacitor } from './lib/capacitor.js'

// Recovery flow detection. We send `?recovery=1` as the query string in
// the resetPasswordForEmail redirectTo, so the URL coming back from the
// email link is `https://...vercel.app/?recovery=1#access_token=…`.
// Auth tokens land in the fragment (Supabase will set the recovery
// session when it processes the fragment async), and the query string
// survives both the redirect and Supabase's fragment-strip — so we can
// always tell "this is a recovery flow" no matter the timing.
//
// We check for `?recovery=1` first; legacy `#reset-password` / `#type=recovery`
// stays around as a fallback for any old emails still in users' inboxes.
const initialHash = window.location.hash || ''
const initialQuery = new URLSearchParams(window.location.search)
const isRecoveryUrl = initialQuery.get('recovery') === '1'
  || initialHash.includes('reset-password')
  || initialHash.includes('type=recovery')

const appEl = document.getElementById('app')

appEl.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center"><div style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:#e8c547;margin-bottom:8px">MacroLens</div><div style="font-size:13px;color:#5e5c57">Loading...</div></div></div>`

// Global AI loading bar
window.addEventListener('ai-loading', (e) => {
  const bar = document.getElementById('ai-loading-bar')
  if (!bar) return
  if (e.detail.active) {
    bar.classList.add('active')
  } else {
    bar.classList.remove('active')
  }
})

async function bootstrap() {
  // Init Capacitor native features (no-op in browser)
  await initCapacitor()

  if (!supabase) {
    await initApp({ id: 'local', email: 'local@macrolens.app' }, appEl)
    return
  }

  // Recovery flow short-circuit. If we're here from a password-reset email
  // link, render the reset form right away — don't wait for auth events.
  // The recovery session gets established by Supabase as it processes the
  // URL fragment in the background; by the time the user finishes typing
  // a new password and submits, updateUser() sees the session and works.
  // (Earlier we waited for PASSWORD_RECOVERY / INITIAL_SESSION events, but
  // by the time onAuthStateChange's listener registered after `await
  // initCapacitor`, those events had already fired into the void.)
  if (isRecoveryUrl) {
    renderResetPasswordPage(appEl, () => {})
    return
  }

  onAuthStateChange(async (user) => {
    if (user) {
      await initApp(user, appEl)
    } else {
      renderAuthPage(appEl)
    }
  })
}

bootstrap()
