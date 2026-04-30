/**
 * Capacitor bridge — safely imports native plugins only when running
 * inside a Capacitor app. Falls back gracefully in the browser.
 */

let _isNative = false
let _Haptics = null
let _StatusBar = null
let _SplashScreen = null
let _App = null
let _Keyboard = null

export async function initCapacitor() {
  try {
    // Check if running in Capacitor
    const { Capacitor } = await import('@capacitor/core')
    _isNative = Capacitor.isNativePlatform()

    // Tap-outside-to-dismiss keyboard. iOS webviews don't ship this UX
    // out of the box — once an input is focused, the keyboard sticks
    // around forever. Install a global listener that blurs whatever's
    // focused (and explicitly tells the native plugin to hide the
    // keyboard) when the user taps somewhere that isn't a form field.
    // Works in both web and native; adds zero overhead in native browsers.
    installKeyboardDismissOnTapOutside()

    if (!_isNative) return

    // Import plugins only on native
    const [{ Haptics }, { StatusBar, Style }, { SplashScreen }, { App }, { Keyboard }] = await Promise.all([
      import('@capacitor/haptics'),
      import('@capacitor/status-bar'),
      import('@capacitor/splash-screen'),
      import('@capacitor/app'),
      import('@capacitor/keyboard'),
    ])

    _Haptics = Haptics
    _StatusBar = StatusBar
    _SplashScreen = SplashScreen
    _App = App
    _Keyboard = Keyboard

    // Configure status bar for dark theme
    await StatusBar.setStyle({ style: Style.Dark })
    await StatusBar.setBackgroundColor({ color: '#0f0e0d' })

    // Hide splash screen after app loads
    await SplashScreen.hide({ fadeOutDuration: 300 })

    // Handle Android back button
    App.addListener('backButton', ({ canGoBack }) => {
      if (!canGoBack) App.exitApp()
    })

    console.log('[Capacitor] Running native on', Capacitor.getPlatform())
  } catch (e) {
    // Not in Capacitor — browser environment, silently continue
  }
}

function installKeyboardDismissOnTapOutside() {
  // Use pointerdown rather than click — fires before the keyboard
  // gets a chance to keep stealing focus, gives a snappier dismiss.
  // Passive: true so we don't accidentally block scroll.
  const FORM_SELECTORS = 'input, textarea, select, button, [contenteditable], [role="button"]'
  document.addEventListener('pointerdown', (e) => {
    const focused = document.activeElement
    if (!focused) return
    if (!focused.matches?.(FORM_SELECTORS)) return
    // If the user pressed on another form element / button, don't dismiss
    // — they're transitioning to a different control.
    if (e.target?.closest?.(FORM_SELECTORS)) return
    focused.blur()
    if (_Keyboard) _Keyboard.hide().catch(() => {})
  }, { passive: true })
}

// Explicit hide for places where we want to dismiss the keyboard before
// performing an action (e.g., right before submitting a form).
export async function hideKeyboard() {
  try {
    if (document.activeElement?.blur) document.activeElement.blur()
    if (_Keyboard) await _Keyboard.hide()
  } catch {}
}

export function isNative() { return _isNative }

export function getPlatform() {
  try {
    const { Capacitor } = require('@capacitor/core')
    return Capacitor.getPlatform() // 'ios' | 'android' | 'web'
  } catch { return 'web' }
}

// Haptic feedback — call anywhere for native feel
export async function hapticLight() {
  if (!_Haptics) return
  try { await _Haptics.impact({ style: 'light' }) } catch {}
}

export async function hapticMedium() {
  if (!_Haptics) return
  try { await _Haptics.impact({ style: 'medium' }) } catch {}
}

export async function hapticSuccess() {
  if (!_Haptics) return
  try { await _Haptics.notification({ type: 'success' }) } catch {}
}

export async function hapticError() {
  if (!_Haptics) return
  try { await _Haptics.notification({ type: 'error' }) } catch {}
}
