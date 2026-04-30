import Foundation
import Supabase

/// Global app state — anything the dashboard reads/writes that survives
/// a navigation. Equivalent to the JS `state` object, but only the slices
/// the native screens actually touch (no need to port the entire web
/// state at once).
@Observable
@MainActor
final class AppState {
    var goals: Goals = Goals()
    var todayLog: [MealLogEntry] = []
    var last7Days: [DaySummary] = []
    var recipes: [RecipeRow] = []
    var recentCheckins: [CheckinRow] = []
    var loading: Bool = false
    var lastError: String?

    /// Loads everything the dashboard needs in parallel. Idempotent —
    /// safe to call on every appear or pull-to-refresh.
    func loadDashboard() async {
        loading = true
        defer { loading = false }
        do {
            async let g = fetchGoals()
            async let weekLog = fetchLastNDaysLog(7)
            async let r = fetchRecipes()
            async let c = fetchRecentCheckins()

            let weekEntries = try await weekLog
            self.goals = (try? await g) ?? Goals()
            self.todayLog = filterToToday(weekEntries).sorted { ($0.logged_at ?? "") > ($1.logged_at ?? "") }
            self.last7Days = DaySummary.build(from: weekEntries, days: 7)
            self.recipes = (try? await r) ?? []
            self.recentCheckins = (try? await c) ?? []
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Insert a new meal_log row. Used by Quick log + Analyze food's
    /// "Log this meal" button. Today's log is updated locally so the
    /// macro tiles refresh immediately without a round trip.
    func logMeal(name: String,
                 mealType: String? = nil,
                 calories: Double = 0,
                 protein: Double = 0,
                 carbs: Double = 0,
                 fat: Double = 0,
                 fiber: Double = 0,
                 recipeId: String? = nil) async throws {
        struct Insert: Encodable {
            // public.meal_log column is `name` (not `meal_name` — that's
            // meal_planner's column). Mixed those up once already.
            let user_id: String
            let name: String
            let meal_type: String?
            let calories: Double
            let protein: Double
            let carbs: Double
            let fat: Double
            let fiber: Double
            let recipe_id: String?
            let logged_at: String
            let servings_consumed: Double
        }
        let userId = try await currentUserID()
        let payload = Insert(
            user_id: userId,
            name: name,
            meal_type: mealType,
            calories: calories,
            protein: protein,
            carbs: carbs,
            fat: fat,
            fiber: fiber,
            recipe_id: recipeId,
            logged_at: ISO8601DateFormatter().string(from: Date()),
            servings_consumed: 1.0
        )
        let inserted: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .insert(payload)
            .select()
            .execute()
            .value
        if let entry = inserted.first {
            todayLog.insert(entry, at: 0)
        }
    }

    /// Insert a recipe row from an Analyze-recipe result. Used by the
    /// "Save to library" button on the recipe-mode result card.
    /// `ingredients` is stored as jsonb on the recipes table.
    @discardableResult
    func saveRecipe(_ result: AnalysisResult) async throws -> RecipeRow {
        struct Insert: Encodable {
            let user_id: String
            let name: String
            let description: String?
            let servings: Double?
            let calories: Double?
            let protein: Double?
            let carbs: Double?
            let fat: Double?
            let fiber: Double?
            let sugar: Double?
            let ingredients: [Ingredient]?
        }
        let userId = try await currentUserID()
        let payload = Insert(
            user_id: userId,
            name: result.name,
            description: result.description,
            servings: result.servings,
            calories: result.calories,
            protein: result.protein,
            carbs: result.carbs,
            fat: result.fat,
            fiber: result.fiber,
            sugar: result.sugar,
            ingredients: result.ingredients
        )
        let inserted: [RecipeRow] = try await SupabaseService.client
            .from("recipes")
            .insert(payload)
            .select("id, name, calories, protein, carbs, fat, fiber, servings")
            .execute()
            .value
        guard let row = inserted.first else {
            throw NSError(domain: "AppState", code: 0, userInfo: [NSLocalizedDescriptionKey: "Recipe insert returned no rows"])
        }
        recipes.insert(row, at: 0)
        return row
    }

    private func fetchGoals() async throws -> Goals {
        let userId = try await currentUserID()
        let response: [Goals] = try await SupabaseService.client
            .from("goals")
            .select("calories, protein, carbs, fat, fiber")
            .eq("user_id", value: userId)
            .limit(1)
            .execute()
            .value
        return response.first ?? Goals()
    }

    private func fetchLastNDaysLog(_ days: Int) async throws -> [MealLogEntry] {
        let userId = try await currentUserID()
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

    private func fetchRecentCheckins() async throws -> [CheckinRow] {
        // 60 days covers "this month" with comfortable headroom. The
        // analytics widget filters down to the current calendar month.
        let userId = try await currentUserID()
        let cal = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        let from = cal.date(byAdding: .day, value: -60, to: cal.startOfDay(for: Date()))!
        let fromStr = formatter.string(from: from)
        let response: [CheckinRow] = try await SupabaseService.client
            .from("checkins")
            .select("id, weight_kg, scan_date, checked_in_at")
            .eq("user_id", value: userId)
            .gte("checked_in_at", value: fromStr)
            .order("checked_in_at", ascending: true)
            .execute()
            .value
        return response
    }

    private func filterToToday(_ entries: [MealLogEntry]) -> [MealLogEntry] {
        let today = todayDateString()
        return entries.filter { ($0.logged_at ?? "").hasPrefix(today) }
    }

    private func fetchRecipes() async throws -> [RecipeRow] {
        let userId = try await currentUserID()
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

    private func currentUserID() async throws -> String {
        try await SupabaseService.client.auth.session.user.id.uuidString
    }

    private func todayDateString() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.string(from: Date())
    }

    private func tomorrowDateString() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.string(from: Calendar.current.date(byAdding: .day, value: 1, to: Date())!)
    }
}
