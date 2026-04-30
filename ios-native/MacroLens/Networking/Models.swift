import Foundation

/// Codable types for the public-schema tables we read on the dashboard.
/// Field names match the DB columns one-to-one — no `CodingKeys` shimming
/// because the SDK's default `JSONDecoder` does snake_case → camelCase
/// for us via the SupabaseClient's configured decoder when we let it do
/// the keyDecodingStrategy. Where that doesn't apply, columns stay
/// snake_case here for clarity vs. the web codebase.

struct Goals: Codable, Hashable {
    var calories: Int?
    var protein: Int?
    var carbs: Int?
    var fat: Int?
    var fiber: Int?
}

/// One row of public.meal_log — what gets logged when a user records
/// something they ate. Macro fields are already the total for the
/// entry's `servings_consumed`, NOT per-serving. The web codebase has
/// a comment on this — same rule applies on iOS.
struct MealLogEntry: Codable, Identifiable, Hashable {
    var id: String
    var name: String?                 // public.meal_log uses `name` (not
                                       // `meal_name` — that's meal_planner's
                                       // column. Easy to mix up.)
    var meal_type: String?
    var logged_at: String?            // ISO8601, may be just `YYYY-MM-DD`
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var recipe_id: String?
    var food_item_id: String?
    var servings_consumed: Double?
}

/// One row of public.recipes — the user's recipe library. Only the
/// fields Quick log needs are decoded; the recipes table is wider.
struct RecipeRow: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var servings: Double?
}

/// One ingredient row inside a recipe analysis result. Matches the
/// shape FULL_ANALYSIS_PROMPT instructs the model to return.
struct Ingredient: Codable, Hashable {
    var name: String
    var amount: Double?
    var unit: String?
    var category: String?
}

/// What `/api/analyze` returns inside its text block. Two flavors:
///   - MACROS_ONLY_PROMPT (planner / describe-food): just name + macros.
///   - FULL_ANALYSIS_PROMPT (food-photo / recipe text / recipe-photo):
///     adds description, servings, notes, ingredients, sometimes more.
/// Decoder ignores fields the model omitted, so the same struct covers
/// both flavors.
struct AnalysisResult: Codable, Hashable {
    var name: String
    var description: String?
    var servings: Double?
    var calories: Double
    var protein: Double
    var carbs: Double
    var fat: Double
    var fiber: Double?
    var sugar: Double?
    var confidence: String?
    var notes: String?
    var ingredients: [Ingredient]?
}

/// Aggregate macros for a day's meal log.
struct DailyMacroTotals: Equatable {
    var calories: Double = 0
    var protein: Double = 0
    var carbs: Double = 0
    var fat: Double = 0
    var fiber: Double = 0

    static func sum(_ entries: [MealLogEntry]) -> DailyMacroTotals {
        var t = DailyMacroTotals()
        for e in entries {
            t.calories += e.calories ?? 0
            t.protein += e.protein ?? 0
            t.carbs += e.carbs ?? 0
            t.fat += e.fat ?? 0
            t.fiber += e.fiber ?? 0
        }
        return t
    }
}
