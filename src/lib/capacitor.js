/**
 * Capacitor bridge — safely imports native plugins only when running
 * inside a Capacitor app. Falls back gracefully in the browser.
 */

let _isNative = false
let _Haptics = null
let _StatusBar = null
let _SplashScreen = null
let _App = null

export async function initCapacitor() {
  try {
    // Check if running in Capacitor
    const { Capacitor } = await import('@capacitor/core')
    _isNative = Capacitor.isNativePlatform()

    if (!_isNative) return

    // Import plugins only on native
    const [{ Haptics }, { StatusBar, Style }, { SplashScreen }, { App }] = await Promise.all([
      import('@capacitor/haptics'),
      import('@capacitor/status-bar'),
      import('@capacitor/splash-screen'),
      import('@capacitor/app'),
    ])

    _Haptics = Haptics
    _StatusBar = StatusBar
    _SplashScreen = SplashScreen
    _App = App

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
