import Foundation
import Supabase
import AuthenticationServices

/// Identity linking surface — list / link / unlink the OAuth providers
/// attached to the signed-in user. Mirrors the web's getMyIdentities,
/// linkGoogleIdentity, and unlinkIdentity in src/lib/db.js (≈line 2010).
///
/// Same constraint as web: Supabase's "Manual Linking" project setting
/// must be ON. With it off, linkIdentity throws `manual_linking_disabled`
/// which the UI surfaces to the user.
///
/// Apple linking on iOS is intentionally not wired here — it would
/// require flipping `Config.appleSignInEnabled` and adding the Apple
/// Sign-In entitlement, which the project comment in project.yml
/// explicitly defers. Web also defers Apple-on-web. So both platforms
/// stay Google-only for now; this is parity, not a gap.
@MainActor
extension AuthManager {
    func listIdentities() async throws -> [UserIdentity] {
        try await SupabaseService.client.auth.userIdentities()
    }

    /// Kicks off a Google link flow. Same shape as signInWithGoogle:
    /// fetch the OAuth URL → open in ASWebAuthenticationSession →
    /// hand the callback URL back to Supabase, which exchanges the PKCE
    /// code and emits a `.userUpdated` event. The user's identities
    /// list now includes the freshly-linked Google row.
    func linkGoogleIdentity() async throws {
        let redirectURL = URL(string: "app.macrolens.native://login-callback")!

        let response = try await SupabaseService.client.auth.getLinkIdentityURL(
            provider: .google,
            redirectTo: redirectURL
        )

        let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: response.url,
                callbackURLScheme: redirectURL.scheme!
            ) { url, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "AuthManager",
                        code: -3,
                        userInfo: [NSLocalizedDescriptionKey: "Link didn't complete"]
                    ))
                }
            }
            session.presentationContextProvider = AuthPresentationAnchor.shared
            // Linking specifically benefits from non-ephemeral browsing —
            // the user is signed into Google in Safari already, so they
            // don't need to re-authenticate just to attach the provider.
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }

        try await SupabaseService.client.auth.session(from: callbackURL)
    }

    func unlinkIdentity(_ identity: UserIdentity) async throws {
        try await SupabaseService.client.auth.unlinkIdentity(identity)
    }
}
