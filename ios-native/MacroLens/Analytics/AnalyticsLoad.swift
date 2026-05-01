import Foundation
import Supabase

/// Body of the analytics-tab loader. Lives outside AppState.swift so
/// parallel tab workers don't keep clobbering each other's stub
/// fill-ins (same pattern as Planner/PlannerLoad.swift). AppState's
/// `loadAnalytics()` stub forwards to this.
extension AppState {
    /// Pull a wider window of meal_log + supporting goals/checkins so
    /// the page can render adherence + trend charts.
    ///
    /// We fetch 2× the active range so the headline-card delta vs the
    /// previous comparable period (web's `prevWindow` calc) has data
    /// to chew on without a second round trip when the user flips
    /// between the range pills.
    func analyticsLoadImpl() async {
        let window = max(7, analyticsRangeDays) * 2
        async let entries = analyticsFetchLog(days: window)
        async let g = analyticsFetchGoals()
        async let cs = analyticsFetchCheckins()
        async let r = analyticsFetchRecipes()
        self.analyticsLog = (try? await entries) ?? self.analyticsLog
        self.goals = (try? await g) ?? self.goals
        self.allCheckins = (try? await cs) ?? self.allCheckins
        self.recipes = (try? await r) ?? self.recipes
    }

    // MARK: - Private fetch helpers
    //
    // Local copies of the dashboard's fetch methods so the analytics
    // worker doesn't need to touch the private `fetchLastNDaysLog` /
    // `fetchAllCheckins` etc. on AppState.swift. Same query shapes —
    // if the schema changes, both call sites need updating.

    private func analyticsFetchLog(days: Int) async throws -> [MealLogEntry] {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let cal = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        let from = cal.date(byAdding: .day, value: -(days - 1), to: cal.startOfDay(for: Date()))!
        let fromStr = formatter.string(from: from)
        let response: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .select()
            .eq("user_id", value: userId)
            .gte("logged_at", value: fromStr)
            .order("logged_at", ascending: false)
            .execute()
            .value
        return response
    }

    private func analyticsFetchGoals() async throws -> Goals {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let response: [Goals] = try await SupabaseService.client
            .from("goals")
            .select("calories, protein, carbs, fat")
            .eq("user_id", value: userId)
            .limit(1)
            .execute()
            .value
        return response.first ?? Goals()
    }

    private func analyticsFetchCheckins() async throws -> [CheckinRow] {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let response: [CheckinRow] = try await SupabaseService.client
            .from("checkins")
            .select("id, weight_kg, body_fat_pct, muscle_mass_kg, notes, scan_date, checked_in_at, scan_type, scan_file_path")
            .eq("user_id", value: userId)
            .order("checked_in_at", ascending: true)
            .limit(2000)
            .execute()
            .value
        return response
    }

    private func analyticsFetchRecipes() async throws -> [RecipeRow] {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let response: [RecipeRow] = try await SupabaseService.client
            .from("recipes")
            .select("id, name, calories, protein, carbs, fat, fiber, servings")
            .eq("user_id", value: userId)
            .order("name", ascending: true)
            .limit(200)
            .execute()
            .value
        return response
    }
}
