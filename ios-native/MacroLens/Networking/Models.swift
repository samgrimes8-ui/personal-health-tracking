import Foundation

/// Codable types for the public-schema tables we read on the dashboard.
/// Field names match the DB columns one-to-one — no `CodingKeys` shimming
/// because the SDK's default `JSONDecoder` does snake_case → camelCase
/// for us via the SupabaseClient's configured decoder when we let it do
/// the keyDecodingStrategy. Where that doesn't apply, columns stay
/// snake_case here for clarity vs. the web codebase.

/// One row of public.goals — daily macro targets, one per user.
/// Mirrors the web schema: calories / protein / carbs / fat are the
/// canonical 4 macros. The full-label opt-in (track_full_label) adds
/// optional sodium / fiber / saturated-fat / added-sugar targets that
/// only render when the toggle is on.
struct Goals: Codable, Hashable {
    var calories: Int?
    var protein: Int?
    var carbs: Int?
    var fat: Int?
    /// Account-level opt-in for the full nutrition label UI.
    /// Stored on goals because every full-label query touches goals
    /// anyway — no need for a separate user_settings row.
    var track_full_label: Bool?
    var sodium_mg_max: Double?
    var fiber_g_min: Double?
    var saturated_fat_g_max: Double?
    var sugar_added_g_max: Double?
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
    // Per-serving description copied from the AI describe response or
    // from the linked food_item at log time. e.g. "1 medium avocado, ~150g".
    // Combined with servings_consumed, the row can render as
    // "0.5 medium avocados (75g)" without a food_items join.
    var serving_description: String?
    var serving_grams: Double?
    var serving_oz: Double?
    // Full nutrition label (opt-in). NULL when not tracked. UI shows
    // "not tracked" for nulls when the Track full nutrition label
    // toggle is on. Never coerce nulls to 0 — that would silently
    // corrupt micro-target progress.
    var saturated_fat_g: Double?
    var trans_fat_g: Double?
    var cholesterol_mg: Double?
    var sodium_mg: Double?
    var fiber_g: Double?
    var sugar_total_g: Double?
    var sugar_added_g: Double?
    var vitamin_a_mcg: Double?
    var vitamin_c_mg: Double?
    var vitamin_d_mcg: Double?
    var calcium_mg: Double?
    var iron_mg: Double?
    var potassium_mg: Double?
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
    // New (worker-serving-units): structured single-serving description
    // so generic foods like "avocado" come back as "1 medium avocado, ~150g"
    // with the macros explicitly defined as PER-serving. Optional because
    // older callers + the macros-only flavor still decode the same struct.
    var serving_description: String?
    var serving_grams: Double?
    var serving_oz: Double?
    // Quantity hints parsed from freeform queries like "15g butter" or
    // "two slices toast". Per-serving macros above are unchanged — the
    // log flow multiplies by (parsed_quantity_g / serving_grams) or by
    // parsed_quantity_servings to compute servings_consumed at log time.
    // Both nil → user typed a bare food name; default to 1 serving.
    var parsed_quantity_g: Double?
    var parsed_quantity_servings: Double?
    // Full nutrition label (opt-in). Model returns null when it can't
    // confidently read the value — never coerce to 0.
    var saturated_fat_g: Double?
    var trans_fat_g: Double?
    var cholesterol_mg: Double?
    var sodium_mg: Double?
    var fiber_g: Double?
    var sugar_total_g: Double?
    var sugar_added_g: Double?
    var vitamin_a_mcg: Double?
    var vitamin_c_mg: Double?
    var vitamin_d_mcg: Double?
    var calcium_mg: Double?
    var iron_mg: Double?
    var potassium_mg: Double?
}

/// One row of public.checkins. Carries the basic weigh-in fields plus
/// every InBody / DEXA column we extract from a scan upload. Extended
/// fields are optional — a manual weigh-in row only populates
/// weight_kg / body_fat_pct / muscle_mass_kg, while a scan upload
/// fills in the body-composition + segmental + DEXA blocks.
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

    // Body composition (InBody-style)
    var lean_body_mass_kg: Double?
    var body_fat_mass_kg: Double?
    var bone_mass_kg: Double?
    var total_body_water_kg: Double?
    var intracellular_water_kg: Double?
    var extracellular_water_kg: Double?
    var ecw_tbw_ratio: Double?
    var protein_kg: Double?
    var minerals_kg: Double?
    var bmr: Int?
    var bmi: Double?
    var inbody_score: Int?
    var visceral_fat_level: Double?
    var body_cell_mass_kg: Double?
    var smi: Double?

    // Segmental lean mass — kg + % of normal per limb
    var seg_lean_left_arm_kg: Double?
    var seg_lean_right_arm_kg: Double?
    var seg_lean_trunk_kg: Double?
    var seg_lean_left_leg_kg: Double?
    var seg_lean_right_leg_kg: Double?
    var seg_lean_left_arm_pct: Double?
    var seg_lean_right_arm_pct: Double?
    var seg_lean_trunk_pct: Double?
    var seg_lean_left_leg_pct: Double?
    var seg_lean_right_leg_pct: Double?

    // DEXA-specific
    var bone_mineral_density: Double?
    var t_score: Double?
    var z_score: Double?
    var android_fat_pct: Double?
    var gynoid_fat_pct: Double?
    var android_gynoid_ratio: Double?
    var vat_area_cm2: Double?

    // HealthKit dedup columns (see supabase/migrations/healthkit_columns.sql).
    // healthkit_uuid is the sample.uuid.uuidString from HKHealthStore — set
    // on rows we pushed to HK and on rows we pulled from HK; null otherwise.
    // source distinguishes user-entered ("manual") from HK-synced
    // ("healthkit") rows so the push path never echoes pulled rows back.
    var healthkit_uuid: String?
    var source: String?

    /// Has any extended body-composition value beyond weight/BF/muscle?
    var hasExtended: Bool {
        total_body_water_kg != nil || visceral_fat_level != nil
            || inbody_score != nil || bmr != nil || bmi != nil
            || body_fat_mass_kg != nil || lean_body_mass_kg != nil
    }

    /// Has segmental lean mass for the 5 body regions?
    var hasSegmental: Bool {
        seg_lean_trunk_kg != nil || seg_lean_left_arm_kg != nil
    }

    /// Has DEXA-specific outputs?
    var hasDexa: Bool {
        bone_mineral_density != nil || android_fat_pct != nil || t_score != nil
    }
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

    /// Recommended daily macros given the current TDEE + direction + pace.
    /// Mirrors calcTargetMacros in src/pages/app.js exactly:
    ///   - 250/400/600 kcal deficit (slow/moderate/aggressive) for losing
    ///     fat; surplus of 250/300/400 for gaining (capped 1200 kcal floor)
    ///   - Protein = 1 g/lb lean mass (LBM from body fat % when known,
    ///     else estimated as 75% of body weight)
    ///   - Fat = 25% of target calories
    ///   - Carbs = remainder (with a 50 g floor)
    /// Returns nil if TDEE can't be computed.
    func calculatedTargets() -> Goals? {
        guard let tdee, let weight_kg else { return nil }
        let pace = ["slow": 250.0, "moderate": 400.0, "aggressive": 600.0]
        let p = pace[self.pace ?? "moderate"] ?? 400.0
        let deficit: Double = {
            switch weight_goal {
            case "lose": return p
            case "gain": return -(["slow": 250.0, "moderate": 300.0, "aggressive": 400.0][self.pace ?? "moderate"] ?? 300.0)
            default:     return 0
            }
        }()
        let targetCal = max(1200, Double(tdee) - deficit)

        let lbmLbs: Double
        if let bf = body_fat_pct, bf > 0, bf < 100 {
            lbmLbs = (weight_kg * (1 - bf / 100)) * 2.20462
        } else {
            lbmLbs = (weight_kg * 2.20462) * 0.75
        }
        let proteinG = (lbmLbs * 1.0).rounded()
        let fatCal   = (targetCal * 0.25).rounded()
        let fatG     = (fatCal / 9).rounded()
        let carbCal  = targetCal - (proteinG * 4) - fatCal
        let carbG    = max(50, (carbCal / 4).rounded())

        return Goals(
            calories: Int(targetCal),
            protein: Int(proteinG),
            carbs: Int(carbG),
            fat: Int(fatG)
        )
    }

    /// Approximate weeks until goal weight is reached at the current
    /// pace. Mirrors weeksToGoal. Returns nil when there's nothing to
    /// project.
    func weeksToGoal() -> Int? {
        guard let cur = weight_kg, let goal = goal_weight_kg, cur != goal else { return nil }
        let diff = abs(cur - goal)
        let kgPerWeek = ["slow": 0.25, "moderate": 0.4, "aggressive": 0.6][pace ?? "moderate"] ?? 0.4
        return Int((diff / kgPerWeek).rounded(.up))
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

/// Sum of full-label fields across a day's meal_log rows. NULL contributions
/// are skipped (not coerced to 0) so a single "not tracked" entry doesn't
/// quietly drag the daily total down. `_count` records how many rows had a
/// non-null value per field — the UI shows "X / Y meals tracked" so the user
/// sees coverage without us inventing data.
struct DailyFullLabelTotals: Equatable {
    var saturatedFat: (sum: Double, count: Int) = (0, 0)
    var transFat: (sum: Double, count: Int) = (0, 0)
    var cholesterol: (sum: Double, count: Int) = (0, 0)
    var sodium: (sum: Double, count: Int) = (0, 0)
    var fiber: (sum: Double, count: Int) = (0, 0)
    var sugarTotal: (sum: Double, count: Int) = (0, 0)
    var sugarAdded: (sum: Double, count: Int) = (0, 0)
    var vitaminA: (sum: Double, count: Int) = (0, 0)
    var vitaminC: (sum: Double, count: Int) = (0, 0)
    var vitaminD: (sum: Double, count: Int) = (0, 0)
    var calcium: (sum: Double, count: Int) = (0, 0)
    var iron: (sum: Double, count: Int) = (0, 0)
    var potassium: (sum: Double, count: Int) = (0, 0)

    static func == (lhs: DailyFullLabelTotals, rhs: DailyFullLabelTotals) -> Bool {
        lhs.saturatedFat == rhs.saturatedFat && lhs.transFat == rhs.transFat
            && lhs.cholesterol == rhs.cholesterol && lhs.sodium == rhs.sodium
            && lhs.fiber == rhs.fiber && lhs.sugarTotal == rhs.sugarTotal
            && lhs.sugarAdded == rhs.sugarAdded && lhs.vitaminA == rhs.vitaminA
            && lhs.vitaminC == rhs.vitaminC && lhs.vitaminD == rhs.vitaminD
            && lhs.calcium == rhs.calcium && lhs.iron == rhs.iron
            && lhs.potassium == rhs.potassium
    }

    static func sum(_ entries: [MealLogEntry]) -> DailyFullLabelTotals {
        var t = DailyFullLabelTotals()
        func bump(_ field: inout (sum: Double, count: Int), _ v: Double?) {
            guard let v else { return }
            field.sum += v
            field.count += 1
        }
        for e in entries {
            // Prefer the new fiber_g column; fall back to legacy `fiber` so
            // pre-migration entries still contribute to the fiber total.
            bump(&t.fiber, e.fiber_g ?? e.fiber)
            bump(&t.saturatedFat, e.saturated_fat_g)
            bump(&t.transFat, e.trans_fat_g)
            bump(&t.cholesterol, e.cholesterol_mg)
            bump(&t.sodium, e.sodium_mg)
            bump(&t.sugarTotal, e.sugar_total_g)
            bump(&t.sugarAdded, e.sugar_added_g)
            bump(&t.vitaminA, e.vitamin_a_mcg)
            bump(&t.vitaminC, e.vitamin_c_mg)
            bump(&t.vitaminD, e.vitamin_d_mcg)
            bump(&t.calcium, e.calcium_mg)
            bump(&t.iron, e.iron_mg)
            bump(&t.potassium, e.potassium_mg)
        }
        return t
    }
}

// ─── Phase 0 / S2 — pre-declared shapes for the parallel tab workers ────────
//
// Worker rule: every struct that touches a public-schema row lives HERE so
// the six parallel workers (Analytics, Planner, Recipes, Providers, Foods,
// Account) never need to edit Models.swift. If a shape is missing, raise
// it before fanning out — do not patch in place inside a worker branch.
//
// Field names match DB columns one-to-one (snake_case) for cross-referencing
// with src/lib/db.js. Hashable so SwiftUI ForEach/diff can lean on them;
// Identifiable everywhere there's a stable id column.

/// One row of public.meal_planner. Drives the Planner tab's week grid plus
/// the planner-aware bits of the dashboard.
///
/// Mirrors addPlannerMeal() in db.js. Notes:
///   - `meal_name` (NOT `name` — meal_log uses `name`; this column is
///     specifically `meal_name` on meal_planner)
///   - `actual_date` is the source of truth for which day the meal lands
///     on; `day_of_week` is a denormalized convenience for older code paths
///   - `planned_servings` is a multiplier when the planner row points at a
///     recipe; nil for ad-hoc planner entries
///   - `from_share_token` / `from_share_index` are only present when the
///     row was copied in from a meal-plan share (see saveSharedRecipeFromPlannerRow)
struct PlannerRow: Codable, Identifiable, Hashable {
    var id: String
    var week_start_date: String?      // YYYY-MM-DD (Sunday by convention)
    var day_of_week: Int?             // 0–6 (0 = Sunday)
    var actual_date: String?          // YYYY-MM-DD — preferred over day_of_week
    var meal_name: String?
    var meal_type: String?            // breakfast | lunch | snack | dinner
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var is_leftover: Bool?
    var planned_servings: Double?
    var recipe_id: String?
    var from_share_token: String?
    var from_share_index: Int?
}

/// One component inside a food_items row. Stored as a jsonb array — see
/// the Foods modal in app.js for the shape. `qty` + `unit` describe how
/// much of the underlying ingredient went in, and the macro fields are
/// already scaled to that quantity (NOT per-unit).
struct FoodComponent: Codable, Hashable {
    var name: String?
    var qty: Double?
    var unit: String?                 // "serving" | "g" | "oz" | "ml" | …
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var sugar: Double?
}

/// One row of public.food_items — the user's saved food library. Distinct
/// from RecipeRow: foods are atomic (a yogurt, a protein bar) while
/// recipes assemble multiple foods. Macro fields here are per-serving;
/// `serving_size` is a free-text label (e.g. "1 scoop (32g)").
struct FoodItemRow: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var brand: String?
    var serving_size: String?         // free-text e.g. "1 scoop (32g)"
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var sugar: Double?
    var sodium: Double?
    var components: [FoodComponent]?  // jsonb on the row
    var notes: String?
    var source: String?               // "manual" | "ai" | "log" | "barcode"
    var updated_at: String?
    // Structured single-serving description (added with worker-serving-units).
    // Preferred over serving_size for display because we can pluralize it
    // ("0.5 medium avocados") and trust the gram weight.
    var serving_description: String?
    var serving_grams: Double?
    var serving_oz: Double?
    // Full nutrition label (opt-in). Same convention: null = not tracked.
    var saturated_fat_g: Double?
    var trans_fat_g: Double?
    var cholesterol_mg: Double?
    var sodium_mg: Double?
    var fiber_g: Double?
    var sugar_total_g: Double?
    var sugar_added_g: Double?
    var vitamin_a_mcg: Double?
    var vitamin_c_mg: Double?
    var vitamin_d_mcg: Double?
    var calcium_mg: Double?
    var iron_mg: Double?
    var potassium_mg: Double?
}

/// One row of public.user_profiles, projected to the columns the Account
/// tab + Providers tab care about. The profile row is wider in the DB —
/// add columns here as workers need them.
struct UserProfileRow: Codable, Hashable {
    var user_id: String
    var email: String?
    var role: String?                 // free | premium | provider | admin
    var account_status: String?       // active | suspended
    var is_admin: Bool?

    // Provider-channel fields (populated only when the user runs a channel)
    var provider_name: String?
    var provider_slug: String?
    var provider_bio: String?
    var provider_specialty: String?
    var provider_avatar_url: String?
    var credentials: String?

    // Per-user spend overrides (admin escape hatch)
    var spending_limit_usd: Double?
    var spending_limit_expires_at: String?
    var total_spent_usd: Double?

    // Per-user tag preset hiding (array of preset names)
    var hidden_tag_presets: [String]?
}

/// Provider directory listing — same row as UserProfileRow, projected
/// to just the columns getProviders() returns. Kept distinct so the
/// Providers tab has a tidy shape and the Account tab can stay
/// authoritative for full-profile reads.
struct ProviderRow: Codable, Identifiable, Hashable {
    var id: String { user_id }
    var user_id: String
    var provider_name: String?
    var provider_bio: String?
    var provider_slug: String?
    var provider_specialty: String?
    var provider_avatar_url: String?
    var credentials: String?
    var role: String?
    var email: String?
}

/// One row of public.provider_follows — links a follower to a provider.
/// Composite primary key (follower_id, provider_id); we expose both
/// columns so the Providers tab can render follower counts + "you're
/// following" state without joining client-side.
struct FollowRow: Codable, Hashable {
    var follower_id: String
    var provider_id: String
    var created_at: String?
}

/// One row of public.token_usage. Drives the Account tab's spend
/// breakdown widget + admin views. Each row is one Claude call —
/// model + feature say what was billed, cost_usd is the dollar
/// amount, tokens_used is in/out combined.
struct TokenUsageRow: Codable, Identifiable, Hashable {
    var id: String?                   // optional: list endpoints don't always select it
    var user_id: String?
    var model: String?
    var feature: String?              // analyze-food | recipe-text | barcode | …
    var input_tokens: Int?
    var output_tokens: Int?
    var tokens_used: Int?
    var cost_usd: Double?
    var created_at: String?
}

// MARK: - Serving display helpers
//
// Renders a per-entry serving label like "1 medium avocado, ~150g" or
// "0.5 medium avocados (75g)" — pluralizing the unit and recomputing the
// gram weight when the user logged a fractional/multiple amount.
//
// We pluralize only the unit noun (avocado → avocados), not the whole
// description. Heuristic: split on the first comma — left half is the
// unit phrase, right half is the gram annotation. If there's no comma,
// strip a parenthesized "(~Xg)" tail and treat the rest as the unit.

enum ServingFormat {
    /// Returns a display string for `servings` of the given unit, with
    /// the gram weight scaled to match. Returns nil when there's no
    /// usable description.
    static func render(description: String?, grams: Double?, servings: Double) -> String? {
        guard let desc = description?.trimmingCharacters(in: .whitespacesAndNewlines), !desc.isEmpty else { return nil }
        // Split unit phrase from gram annotation.
        let (unitRaw, _) = splitUnitFromGrams(desc)
        let unit = stripLeadingOne(unitRaw)
        let s = servings
        let qtyStr: String
        if abs(s - s.rounded()) < 0.01 {
            qtyStr = String(Int(s.rounded()))
        } else {
            qtyStr = String(format: "%g", (s * 100).rounded() / 100)
        }
        let plural = (s != 1) ? pluralize(unit) : unit
        // Recompute gram annotation from servings × grams when available.
        if let g = grams, g > 0 {
            let scaled = (g * s).rounded()
            let intPart = Int(scaled)
            return "\(qtyStr) \(plural) (\(intPart)g)"
        }
        return "\(qtyStr) \(plural)"
    }

    /// Returns just the unit phrase (no gram annotation, no leading "1") —
    /// used by the Edit sheet's Servings input label so the field reads
    /// "How many medium avocados?" rather than "Servings".
    static func unitNoun(description: String?) -> String? {
        guard let desc = description?.trimmingCharacters(in: .whitespacesAndNewlines), !desc.isEmpty else { return nil }
        let (unitRaw, _) = splitUnitFromGrams(desc)
        let unit = stripLeadingOne(unitRaw)
        return unit.isEmpty ? nil : unit
    }

    private static func splitUnitFromGrams(_ s: String) -> (String, String?) {
        // Prefer a comma split (e.g. "1 medium avocado, ~150g").
        if let commaIdx = s.firstIndex(of: ",") {
            let left = String(s[..<commaIdx]).trimmingCharacters(in: .whitespaces)
            let right = String(s[s.index(after: commaIdx)...]).trimmingCharacters(in: .whitespaces)
            return (left, right)
        }
        // Otherwise strip any "(~Xg)" / "(Xg)" tail.
        if let parenIdx = s.firstIndex(of: "(") {
            let left = String(s[..<parenIdx]).trimmingCharacters(in: .whitespaces)
            let right = String(s[parenIdx...])
            return (left, right)
        }
        return (s, nil)
    }

    private static func stripLeadingOne(_ s: String) -> String {
        // Drop a leading "1 " so "1 medium avocado" → "medium avocado".
        let trimmed = s.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("1 ") { return String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
        return trimmed
    }

    /// Naive English pluralizer. Good enough for common food units —
    /// avocado → avocados, slice → slices, cup → cups, egg → eggs.
    /// Special-cases sibilant endings (s/sh/ch/x) → +es. Skips words
    /// that already end in 's'.
    private static func pluralize(_ s: String) -> String {
        guard !s.isEmpty else { return s }
        let lower = s.lowercased()
        if lower.hasSuffix("s") || lower.hasSuffix("ss") { return s }
        if lower.hasSuffix("ch") || lower.hasSuffix("sh") || lower.hasSuffix("x") { return s + "es" }
        if lower.hasSuffix("y"), let lastBefore = s.dropLast().last, !"aeiou".contains(lastBefore) {
            return String(s.dropLast()) + "ies"
        }
        return s + "s"
    }
}

/// One row of public.generic_foods — USDA FoodData Central reference rows
/// shared across all users (read-only; populated by
/// scripts/import-usda-foods.js with the service role key).
///
/// Quick Log searches this table before falling back to AnalyzeService's
/// AI describe — a hit means an instant log with no AI cost. Macros are
/// stored per-serving (not per-100g), so the search path can drop them
/// straight into meal_log without re-scaling at log time.
struct GenericFoodRow: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var aliases: [String]?
    var serving_description: String?
    var serving_grams: Double?
    var serving_oz: Double?
    var kcal: Double?
    var protein_g: Double?
    var carbs_g: Double?
    var fat_g: Double?
    var fiber_g: Double?
    var fdc_id: String?
    var source: String?
}

/// Lightweight reference to a body-scan file in the body-scans bucket.
/// Workers use this to render the "view scan" link on the Goals page +
/// to surface scan provenance in the Account export. Storage paths are
/// of the form `<user_id>/<timestamp>.<ext>`; signed URLs are minted
/// on-demand via getScanUrl() in db.js.
struct BodyScanRef: Hashable, Identifiable {
    var id: String { path }
    let path: String                  // storage path inside body-scans bucket
    var checkinId: String?
    var scanType: String?             // "INBODY" | "DEXA"
    var scanDate: String?             // YYYY-MM-DD
}
