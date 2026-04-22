import { signIn, signUp, signInWithGoogle, resetPassword } from '../lib/auth.js'

export function renderAuthPage(container) {
  container.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">
          <div class="auth-logo-text">MacroLens</div>
          <div class="auth-logo-sub">AI nutrition tracker</div>
        </div>

        <div class="auth-tabs">
          <button class="auth-tab active" id="tab-login" onclick="switchAuthTab('login')">Sign in</button>
          <button class="auth-tab" id="tab-signup" onclick="switchAuthTab('signup')">Create account</button>
        </div>

        <div id="auth-error" class="auth-error" style="display:none"></div>
        <div id="auth-success" class="auth-success" style="display:none"></div>

        <div id="auth-form-login">
          <div class="auth-field">
            <label>Email</label>
            <input type="email" id="login-email" placeholder="you@example.com" />
          </div>
          <div class="auth-field">
            <label>Password</label>
            <input type="password" id="login-password" placeholder="••••••••" />
          </div>
          <div style="text-align:right;margin:-8px 0 16px">
            <button onclick="switchAuthTab('forgot')" style="background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;font-family:inherit;padding:0">
              Forgot password?
            </button>
          </div>
          <button class="auth-btn" id="login-btn" onclick="handleLogin()">Sign in</button>
        </div>

        <div id="auth-form-signup" style="display:none">
          <div class="auth-field">
            <label>Email</label>
            <input type="email" id="signup-email" placeholder="you@example.com" />
          </div>
          <div class="auth-field">
            <label>Password</label>
            <input type="password" id="signup-password" placeholder="At least 6 characters" />
          </div>
          <div class="auth-field">
            <label>Confirm password</label>
            <input type="password" id="signup-confirm" placeholder="••••••••" />
          </div>
          <button class="auth-btn" id="signup-btn" onclick="handleSignup()">Create account</button>
        </div>

        <div id="auth-form-forgot" style="display:none">
          <div style="font-size:13px;color:var(--text3);margin-bottom:16px;line-height:1.5">
            Enter your email and we'll send you a link to reset your password.
          </div>
          <div class="auth-field">
            <label>Email</label>
            <input type="email" id="forgot-email" placeholder="you@example.com" />
          </div>
          <button class="auth-btn" id="forgot-btn" onclick="handleForgotPassword()">Send reset link</button>
          <div style="text-align:center;margin-top:12px">
            <button onclick="switchAuthTab('login')" style="background:none;border:none;color:var(--text3);font-size:12px;cursor:pointer;font-family:inherit">
              ← Back to sign in
            </button>
          </div>
        </div>

        <div id="auth-divider-google" class="auth-divider"><span>or</span></div>

        <button id="auth-google-btn" class="auth-google-btn" onclick="handleGoogle()">
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          Continue with Google
        </button>
      </div>
    </div>
  `

  window.switchAuthTab = (tab) => {
    document.getElementById('auth-form-login').style.display = tab === 'login' ? 'block' : 'none'
    document.getElementById('auth-form-signup').style.display = tab === 'signup' ? 'block' : 'none'
    document.getElementById('auth-form-forgot').style.display = tab === 'forgot' ? 'block' : 'none'
    document.getElementById('tab-login').classList.toggle('active', tab === 'login')
    document.getElementById('tab-signup').classList.toggle('active', tab === 'signup')
    // Hide Google button on forgot screen
    const googleBtn = document.getElementById('auth-google-btn')
    const divider = document.getElementById('auth-divider-google')
    if (googleBtn) googleBtn.style.display = tab === 'forgot' ? 'none' : ''
    if (divider) divider.style.display = tab === 'forgot' ? 'none' : ''
    hideAuthMessages()
  }

  window.handleForgotPassword = async () => {
    const email = document.getElementById('forgot-email').value.trim()
    if (!email) return showAuthError('Please enter your email address')
    setAuthLoading('forgot-btn', true)
    try {
      await resetPassword(email)
      showAuthSuccess('Reset link sent! Check your email.')
      document.getElementById('forgot-email').value = ''
    } catch (err) {
      showAuthError(err.message)
    } finally {
      setAuthLoading('forgot-btn', false)
    }
  }

  window.handleLogin = async () => {
    const email = document.getElementById('login-email').value.trim()
    const password = document.getElementById('login-password').value
    if (!email || !password) return showAuthError('Please enter email and password')
    setAuthLoading('login-btn', true)
    try {
      await signIn(email, password)
      // onAuthStateChange in main.js will handle redirect
    } catch (err) {
      showAuthError(err.message)
    } finally {
      setAuthLoading('login-btn', false)
    }
  }

  window.handleSignup = async () => {
    const email = document.getElementById('signup-email').value.trim()
    const password = document.getElementById('signup-password').value
    const confirm = document.getElementById('signup-confirm').value
    if (!email || !password) return showAuthError('Please fill in all fields')
    if (password !== confirm) return showAuthError('Passwords do not match')
    if (password.length < 6) return showAuthError('Password must be at least 6 characters')
    setAuthLoading('signup-btn', true)
    try {
      await signUp(email, password)
      showAuthSuccess('Account created! Check your email to confirm, then sign in.')
      window.switchAuthTab('login')
    } catch (err) {
      showAuthError(err.message)
    } finally {
      setAuthLoading('signup-btn', false)
    }
  }

  window.handleGoogle = async () => {
    try {
      await signInWithGoogle()
    } catch (err) {
      showAuthError(err.message)
    }
  }

  // Enter key support
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const loginVisible = document.getElementById('auth-form-login').style.display !== 'none'
    if (loginVisible) window.handleLogin()
    else window.handleSignup()
  })
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error')
  el.textContent = msg
  el.style.display = 'block'
  document.getElementById('auth-success').style.display = 'none'
}

function showAuthSuccess(msg) {
  const el = document.getElementById('auth-success')
  el.textContent = msg
  el.style.display = 'block'
  document.getElementById('auth-error').style.display = 'none'
}

function hideAuthMessages() {
  document.getElementById('auth-error').style.display = 'none'
  document.getElementById('auth-success').style.display = 'none'
}

function setAuthLoading(btnId, loading) {
  const btn = document.getElementById(btnId)
  if (!btn) return
  btn.disabled = loading
  if (btnId === 'login-btn') btn.textContent = loading ? 'Signing in...' : 'Sign in'
  else if (btnId === 'signup-btn') btn.textContent = loading ? 'Creating account...' : 'Create account'
  else if (btnId === 'forgot-btn') btn.textContent = loading ? 'Sending...' : 'Send reset link'
}
