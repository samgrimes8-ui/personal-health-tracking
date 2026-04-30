import Foundation

/// App-wide configuration. The Supabase publishable key is intentionally
/// committed — like the JS client's anon key, it's safe to expose because
/// Row Level Security is the actual access control. Rotating it later is a
/// one-line change here plus a config edit in Supabase.
enum Config {
    static let supabaseURL = URL(string: "https://rwrcklqpvfvuvwatpbxh.supabase.co")!
    static let supabasePublishableKey = "sb_publishable_AYdh_Z4-Xn4yOqqJEvHtYA_PsvRcIvc"

    /// Base URL for the existing Vercel edge function endpoints
    /// (/api/analyze, /api/tts, /api/share/[token], etc.). The native app
    /// keeps using these — they're already deployed and authenticated via
    /// the user's Supabase JWT.
    static let apiBaseURL = URL(string: "https://personal-health-tracking.vercel.app")!

    /// Sign In With Apple is gated until Apple Developer Program
    /// enrollment is approved — the `com.apple.developer.applesignin`
    /// entitlement isn't available on free dev provisioning, so the
    /// build fails to sign with it. Flip to `true` after enrollment;
    /// also uncomment the entitlement block in `project.yml`. App Store
    /// guideline 4.8 requires Apple Sign-In before public release if
    /// any other social sign-in is offered (we have Google).
    static let appleSignInEnabled = false
}
