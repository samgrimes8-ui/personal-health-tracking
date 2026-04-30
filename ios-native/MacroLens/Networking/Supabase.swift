import Foundation
import Supabase

/// Single shared Supabase client. The SDK persists the auth session
/// to Keychain by default, so a successful sign-in survives app restarts.
///
/// `emitLocalSessionAsInitialSession: true` opts into the next-major
/// supabase-swift behavior: the initial session event always fires with
/// the locally stored session, even if it's expired. Without this opt-in,
/// the SDK logs a runtime deprecation warning. AuthManager checks
/// `session.isExpired` so we don't treat an expired stored session as a
/// signed-in user.
enum SupabaseService {
    static let client = SupabaseClient(
        supabaseURL: Config.supabaseURL,
        supabaseKey: Config.supabasePublishableKey,
        options: SupabaseClientOptions(
            auth: SupabaseClientOptions.AuthOptions(
                emitLocalSessionAsInitialSession: true
            )
        )
    )
}
