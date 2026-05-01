import Foundation
import Supabase

/// Extension implementations for the Account tab's load surface on
/// AppState. Lives here (not in AppState.swift) so the parallel-worker
/// rule "one-line forwarder in AppState; body here" stays intact —
/// same pattern Analytics and Providers use.
///
/// Pattern parity with src/lib/db.js:
///   - `accountLoadImpl()` mirrors getUsageSummary()'s data fetch shape:
///     pull the profile row + this month's token_usage rows; the view
///     derives spend totals + role-based UI from the loaded data
///     rather than a precomputed summary.
///   - We also re-pull body_metrics so the read-only summary card on
///     Account is fresh when the user lands on the tab without first
///     visiting Goals.
@MainActor
extension AppState {
    /// Implementation for `loadAccount()` on AppState (the method body
    /// just awaits this).
    func accountLoadImpl() async {
        async let p = fetchAccountProfile()
        async let t = fetchMonthTokenUsage()
        async let bm = fetchAccountBodyMetrics()
        self.profile = (try? await p) ?? self.profile
        self.monthTokenUsage = (try? await t) ?? self.monthTokenUsage
        if let metrics = (try? await bm) {
            self.bodyMetrics = metrics
        }
    }

    fileprivate func fetchAccountProfile() async throws -> UserProfileRow? {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let response: [UserProfileRow] = try await SupabaseService.client
            .from("user_profiles")
            .select("user_id, email, role, account_status, is_admin, provider_name, provider_slug, provider_bio, provider_specialty, provider_avatar_url, credentials, spending_limit_usd, spending_limit_expires_at, total_spent_usd, hidden_tag_presets")
            .eq("user_id", value: userId)
            .limit(1)
            .execute()
            .value
        return response.first
    }

    /// Pulls token_usage rows from the start of the current calendar
    /// month. Mirrors getUsageSummary() in db.js — same window. The
    /// caller derives spend totals + per-feature breakdown.
    fileprivate func fetchMonthTokenUsage() async throws -> [TokenUsageRow] {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let cal = Calendar.current
        let comps = cal.dateComponents([.year, .month], from: Date())
        guard let monthStart = cal.date(from: comps) else { return [] }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        let startStr = iso.string(from: monthStart)
        let response: [TokenUsageRow] = try await SupabaseService.client
            .from("token_usage")
            .select("id, user_id, model, feature, input_tokens, output_tokens, tokens_used, cost_usd, created_at")
            .eq("user_id", value: userId)
            .gte("created_at", value: startStr)
            .order("created_at", ascending: false)
            .execute()
            .value
        return response
    }

    /// Body metrics fetch reuses the same columns as Goals' load. Local
    /// helper here so we don't depend on private members of AppState.
    fileprivate func fetchAccountBodyMetrics() async throws -> BodyMetrics {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let response: [BodyMetrics] = try await SupabaseService.client
            .from("body_metrics")
            .select("user_id, sex, age, height_cm, weight_kg, body_fat_pct, muscle_mass_kg, activity_level, weight_goal, pace, goal_weight_kg, goal_body_fat_pct")
            .eq("user_id", value: userId)
            .limit(1)
            .execute()
            .value
        return response.first ?? BodyMetrics()
    }
}
