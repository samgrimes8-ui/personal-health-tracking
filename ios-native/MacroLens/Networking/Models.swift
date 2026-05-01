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

/// One row of public.checkins. Now expanded for the Goals page —
/// body fat / muscle / scan provenance. Other extended scan fields
/// (segmental lean, BMR, BMI, etc.) we leave on the row but don't
/// decode here; the read paths only need the headline numbers, and
/// editing happens through the basic-fields modal.
struct CheckinRow: Codable, Identifiable, Hashable {
    var id: String
    var weight_kg: Double?
    var body_fat_pct: Double?
    var muscle_mass_kg: Double?
    var notes: String?
    var scan_date: String?            // YYYY-MM-DD
    var checked_in_at: String?        // ISO8601 timestamp
    var scan_type: String?            // "INBODY" | "DEXA" | nil
    var scan_file_path: String?       // when present, a scan file is attached
}

/// One row of public.body_metrics. One per user (upsert by user_id).
/// Mirrors the web schema: stored as metric, displayed in user units.
/// `weight_goal` is one of "lose" | "maintain" | "gain"; `pace` is
/// "slow" | "moderate" | "aggressive".
struct BodyMetrics: Codable, Hashable {
    var user_id: String?
    var sex: String?
    var age: Int?
    var height_cm: Double?
    var weight_kg: Double?
    var body_fat_pct: Double?
    var muscle_mass_kg: Double?
    var activity_level: String?       // sedentary | light | moderate | active | very_active
    var weight_goal: String?
    var pace: String?
    var goal_weight_kg: Double?
    var goal_body_fat_pct: Double?
}

extension BodyMetrics {
    /// Mifflin-St Jeor / Katch-McArdle BMR — same formulas the web app
    /// uses (calcBMR in src/pages/app.js). Returns nil if there isn't
    /// enough data to compute.
    var bmr: Int? {
        guard let w = weight_kg, w > 0 else { return nil }
        // Katch-McArdle wins when body fat % is known — depends only on
        // lean mass + a constant.
        if let bf = body_fat_pct, bf > 0, bf < 100 {
            let lean = w * (1 - bf / 100)
            return Int((370 + 21.6 * lean).rounded())
        }
        guard let h = height_cm, h > 0,
              let a = age, a > 0,
              let s = sex else { return nil }
        let base = 10 * w + 6.25 * h - 5 * Double(a)
        return Int((base + (s == "female" ? -161 : 5)).rounded())
    }

    /// TDEE = BMR × activity multiplier. Falls back to "moderate" when
    /// the user hasn't picked one (matches web).
    var tdee: Int? {
        guard let b = bmr else { return nil }
        let mult: Double = {
            switch activity_level {
            case "sedentary":   return 1.2
            case "light":       return 1.375
            case "active":      return 1.725
            case "very_active": return 1.9
            default:            return 1.55      // moderate / unset
            }
        }()
        return Int((Double(b) * mult).rounded())
    }
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
