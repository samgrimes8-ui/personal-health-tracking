import Foundation
import Supabase

/// Extension implementations for the Providers tab's load + follow
/// surface on AppState. Lives in this file (not AppState.swift) so
/// the parallel-worker rule "one-line forwarder in AppState; body
/// here" stays intact and the upstream file stays calm.
///
/// Pattern parity:
///   - `loadProviders()` mirrors getProviders() + getFollowedProviders()
///     in src/lib/db.js. Directory filter is "role IN (provider, admin)
///     AND provider_name IS NOT NULL"; follow set is just the IDs.
///   - `setProviderFollowed(_:_:)` is the optimistic write surface used
///     by ProvidersView's pill toggle. Reverts on failure.
@MainActor
extension AppState {
    /// Implementation for `loadProviders()` (the AppState method just
    /// awaits this).
    func providersLoadImpl() async {
        async let directory = fetchProvidersDirectory()
        async let follows = fetchFollowedProviderIDs()
        self.providers = (try? await directory) ?? self.providers
        self.followedProviderIds = (try? await follows) ?? self.followedProviderIds
    }

    /// Optimistically toggle a follow before hitting the network. The
    /// Providers tab uses this so the "+ Follow"/"Following" pill flips
    /// instantly; reverts on failure.
    func setProviderFollowed(_ providerId: String, _ isFollowed: Bool) async {
        let was = followedProviderIds
        if isFollowed { followedProviderIds.insert(providerId) }
        else          { followedProviderIds.remove(providerId) }
        do {
            if isFollowed {
                try await DBService.followProvider(providerId: providerId)
            } else {
                try await DBService.unfollowProvider(providerId: providerId)
            }
        } catch {
            followedProviderIds = was
            lastError = error.localizedDescription
        }
    }

    private func fetchProvidersDirectory() async throws -> [ProviderRow] {
        // `.not("provider_name", operator: .is, value: "null")` renders
        // as `not.is.null`, which Postgrest accepts. Belt-and-suspenders
        // empty-string drop on the client side too.
        let rows: [ProviderRow] = try await SupabaseService.client
            .from("user_profiles")
            .select("user_id, provider_name, provider_bio, provider_slug, provider_specialty, provider_avatar_url, credentials, role, email")
            .in("role", values: ["provider", "admin"])
            .not("provider_name", operator: .is, value: "null")
            .order("provider_name", ascending: true)
            .limit(500)
            .execute()
            .value
        return rows.filter { !($0.provider_name?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) }
    }

    private func fetchFollowedProviderIDs() async throws -> Set<String> {
        struct FollowIDRow: Decodable { let provider_id: String }
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let rows: [FollowIDRow] = try await SupabaseService.client
            .from("provider_follows")
            .select("provider_id")
            .eq("follower_id", value: userId)
            .execute()
            .value
        return Set(rows.map(\.provider_id))
    }
}
