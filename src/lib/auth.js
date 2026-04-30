import { supabase } from './supabase.js'

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) throw error
  return data
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  })
  if (error) throw error
  return data
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export function onAuthStateChange(callback) {
  // Supabase fires this callback on every auth-related event, including
  // TOKEN_REFRESHED and INITIAL_SESSION. On iOS, opening a file picker
  // briefly backgrounds the page, which triggers a TOKEN_REFRESHED when
  // the page comes back — re-initializing the whole app and wiping any
  // in-progress DOM state (like a photo preview the user just selected).
  //
  // We only want to react to genuine sign-in / sign-out transitions, plus
  // PASSWORD_RECOVERY so the bootstrap can route to the reset form.
  let lastUserId = null
  return supabase.auth.onAuthStateChange((event, session) => {
    const userId = session?.user?.id ?? null
    const isIdentityChange = userId !== lastUserId
    const isInitial = event === 'INITIAL_SESSION'
    const isExplicit = event === 'SIGNED_IN' || event === 'SIGNED_OUT'
    const isRecovery = event === 'PASSWORD_RECOVERY'
    if (isInitial || isExplicit || isRecovery || isIdentityChange) {
      lastUserId = userId
      callback(session?.user ?? null, event)
    }
  })
}

export async function resetPassword(email) {
  // Recovery indicator goes in the QUERY STRING, not the fragment.
  // Supabase appends auth tokens to the fragment (#access_token=…) and
  // also strips the fragment from the URL bar after processing — so a
  // fragment-based marker like #reset-password gets eaten. Query strings
  // survive both the redirect AND the fragment-strip, so `?recovery=1`
  // is still readable by the time the page is fully loaded.
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/?recovery=1`,
  })
  if (error) throw error
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
}

/// Polls supabase.auth.getSession() up to `timeoutMs` waiting for the
/// SDK's async URL-fragment processing to set a session. Used by the
/// password-reset form: the user might submit before Supabase has
/// finished extracting the recovery tokens from the URL fragment, and
/// updateUser() would fail with "no session." This catches that race.
export async function waitForSession(timeoutMs = 2500) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { data: { session } } = await supabase.auth.getSession()
    if (session) return session
    await new Promise(r => setTimeout(r, 150))
  }
  return null
}
