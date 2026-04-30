import Foundation
import Supabase

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
}
