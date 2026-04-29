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
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/#reset-password`,
  })
  if (error) throw error
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
}
