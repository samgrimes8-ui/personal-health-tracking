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

/// One row of public.checkins. We only decode what the dashboard
/// analytics widget needs (weight + dates). The full table has many
/// more body-comp columns; the Goals page can extend this when it
/// migrates.
struct CheckinRow: Codable, Identifiable, Hashable {
    var id: String
    var weight_kg: Double?
    var scan_date: String?            // YYYY-MM-DD
    var checked_in_at: String?        // ISO8601 timestamp
}

/// Per-day rollup of a window of meal_log rows. Drives the analytics
/// widget's sparklines and the protein-adherence calc.
struct DaySummary: Identifiable, Hashable {
    let id: String                    // YYYY-MM-DD
    let calories: Double
    let protein: Double
    let count: Int                    // # meal_log entries that day

    static func build(from entries: [MealLogEntry], days: Int) -> [DaySummary] {
        var bucket: [String: (cal: Double, p: Double, count: Int)] = [:]
        for e in entries {
            guard let raw = e.logged_at else { continue }
            let key = String(raw.prefix(10))
            var cur = bucket[key] ?? (0, 0, 0)
            cur.cal += e.calories ?? 0
            cur.p += e.protein ?? 0
            cur.count += 1
            bucket[key] = cur
        }

        let cal = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        let today = cal.startOfDay(for: Date())

        // Oldest → newest so the sparkline reads left-to-right.
        return (0..<days).reversed().map { offset in
            let date = cal.date(byAdding: .day, value: -offset, to: today)!
            let key = formatter.string(from: date)
            let s = bucket[key] ?? (0, 0, 0)
            return DaySummary(id: key, calories: s.cal, protein: s.p, count: s.count)
        }
    }
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
