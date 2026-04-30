import Foundation
import Supabase

/// Single shared Supabase client. The SDK persists the auth session
/// to Keychain by default, so a successful sign-in survives app restarts.
enum SupabaseService {
    static let client = SupabaseClient(
        supabaseURL: Config.supabaseURL,
        supabaseKey: Config.supabasePublishableKey
    )
}
