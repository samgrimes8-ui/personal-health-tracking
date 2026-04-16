import './style.css'
import { supabase } from './lib/supabase.js'
import { onAuthStateChange } from './lib/auth.js'
import { renderAuthPage } from './pages/auth.js'
import { initApp } from './pages/app.js'

const appEl = document.getElementById('app')

appEl.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center"><div style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:#e8c547;margin-bottom:8px">MacroLens</div><div style="font-size:13px;color:#5e5c57">Loading...</div></div></div>`

async function bootstrap() {
  if (!supabase) {
    await initApp({ id: 'local', email: 'local@macrolens.app' }, appEl)
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
