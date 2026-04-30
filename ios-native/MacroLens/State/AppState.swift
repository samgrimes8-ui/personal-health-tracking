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
    var recipes: [RecipeRow] = []
    var loading: Bool = false
    var lastError: String?

    /// Loads everything the dashboard needs in parallel. Idempotent —
    /// safe to call on every appear or pull-to-refresh.
    func loadDashboard() async {
        loading = true
        defer { loading = false }
        do {
            async let g = fetchGoals()
            async let log = fetchTodayLog()
            async let r = fetchRecipes()
            self.goals = (try? await g) ?? Goals()
            self.todayLog = (try await log).sorted { ($0.logged_at ?? "") > ($1.logged_at ?? "") }
            self.recipes = (try? await r) ?? []
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

    private func fetchTodayLog() async throws -> [MealLogEntry] {
        let userId = try await currentUserID()
        let today = todayDateString()
        let response: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .select()
            .eq("user_id", value: userId)
            .gte("logged_at", value: today)
            .lt("logged_at", value: tomorrowDateString())
            .execute()
            .value
        return response
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
