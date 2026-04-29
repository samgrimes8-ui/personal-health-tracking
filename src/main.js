import './style.css'
import { supabase } from './lib/supabase.js'
import { onAuthStateChange } from './lib/auth.js'
import { renderAuthPage, renderResetPasswordPage } from './pages/auth.js'
import { initApp } from './pages/app.js'
import { initCapacitor } from './lib/capacitor.js'

// Captured before Supabase parses & clears the URL hash. The recovery email
// link arrives as `/#reset-password&access_token=...&type=recovery`, and
// Supabase strips the auth tokens once it processes them.
const initialHash = window.location.hash || ''
const isRecoveryUrl = initialHash.includes('reset-password') || initialHash.includes('type=recovery')

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
  let recoveryHandled = false
  onAuthStateChange(async (user, event) => {
    const inRecoveryFlow = !recoveryHandled && (event === 'PASSWORD_RECOVERY' || (isRecoveryUrl && user))
    if (inRecoveryFlow) {
      renderResetPasswordPage(appEl, () => { recoveryHandled = true })
      return
    }
    if (user) {
      await initApp(user, appEl)
    } else {
      renderAuthPage(appEl)
    }
  })
}

bootstrap()
