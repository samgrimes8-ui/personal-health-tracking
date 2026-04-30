import Foundation
import Supabase
import AuthenticationServices
import UIKit

/// Source of truth for the current auth session. AppShell observes this
/// and routes between the auth screen and the signed-in app shell.
@Observable
@MainActor
final class AuthManager {
    enum State {
        case loading        // initial — checking persisted session
        case signedOut
        case signedIn(User)
    }

    var state: State = .loading
    /// Exposed so WebViewTab can forward tokens via URL fragment to
    /// the embedded webview (Supabase's `detectSessionInUrl` picks them
    /// up — same mechanism used by OAuth callbacks).
    var currentSession: Session?

    init() {
        Task { await bootstrap() }
    }

    /// Pull the persisted session (if any) and start listening for auth
    /// state changes. Mirrors `onAuthStateChange` in the JS lib.
    func bootstrap() async {
        do {
            let session = try await SupabaseService.client.auth.session
            currentSession = session
            state = .signedIn(session.user)
        } catch {
            state = .signedOut
        }

        // Listen for sign-in / sign-out / token refresh events.
        // For .initialSession we now also have to verify the session
        // isn't expired — the SDK started emitting expired stored
        // sessions in this event under the new opt-in behavior.
        Task { [weak self] in
            for await change in SupabaseService.client.auth.authStateChanges {
                guard let self else { return }
                switch change.event {
                case .initialSession:
                    if let session = change.session, !session.isExpired {
                        self.currentSession = session
                        self.state = .signedIn(session.user)
                    } else {
                        self.currentSession = nil
                        self.state = .signedOut
                    }
                case .signedIn, .tokenRefreshed, .userUpdated:
                    if let session = change.session {
                        self.currentSession = session
                        self.state = .signedIn(session.user)
                    }
                case .signedOut:
                    self.currentSession = nil
                    self.state = .signedOut
                default:
                    break
                }
            }
        }
    }

    func signIn(email: String, password: String) async throws {
        _ = try await SupabaseService.client.auth.signIn(email: email, password: password)
    }

    func signUp(email: String, password: String) async throws {
        _ = try await SupabaseService.client.auth.signUp(email: email, password: password)
    }

    func sendPasswordReset(email: String) async throws {
        try await SupabaseService.client.auth.resetPasswordForEmail(email)
    }

    func signOut() async {
        try? await SupabaseService.client.auth.signOut()
    }

    /// Native Google Sign-In via Supabase OAuth + ASWebAuthenticationSession.
    /// Reuses the web Google OAuth client already wired up in Supabase —
    /// no separate iOS-only Google Cloud client required. Flow:
    ///
    ///   1. Get OAuth URL from Supabase (redirect_to = our custom scheme)
    ///   2. Open it in ASWebAuthenticationSession (Apple's standard
    ///      "in-app browser for OAuth"; uses Safari's cookies so users
    ///      already signed into Google don't have to re-enter creds)
    ///   3. Google sends the user back through Supabase, which redirects
    ///      to `app.macrolens.native://login-callback#access_token=...`
    ///   4. ASWebAuthenticationSession captures that callback URL and
    ///      hands it to us
    ///   5. We pass it to Supabase's session(from:) which parses the
    ///      fragment and emits .signedIn — bootstrap()'s authStateChanges
    ///      listener picks it up.
    func signInWithGoogle() async throws {
        let redirectURL = URL(string: "app.macrolens.native://login-callback")!

        let url = try SupabaseService.client.auth.getOAuthSignInURL(
            provider: .google,
            redirectTo: redirectURL
        )

        let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: redirectURL.scheme!
            ) { url, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "AuthManager",
                        code: -1,
                        userInfo: [NSLocalizedDescriptionKey: "Sign-in didn't complete"]
                    ))
                }
            }
            // Anchor the web auth sheet to the active window. Apple resolves
            // .init() to the foreground window automatically — no need to
            // hunt down the scene's window manually.
            session.presentationContextProvider = AuthPresentationAnchor.shared
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }

        try await SupabaseService.client.auth.session(from: callbackURL)
        // authStateChanges listener flips us to .signedIn.
    }
}

/// `ASWebAuthenticationSession` requires a presentation anchor — the
/// window the sheet should attach to. An empty `ASPresentationAnchor()`
/// resolves to the foreground window, which is what we want for any
/// running iOS app.
final class AuthPresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuthPresentationAnchor()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        ASPresentationAnchor()
    }
}
