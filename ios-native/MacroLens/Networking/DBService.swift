import Foundation
import Supabase

/// Shared insert / upsert / delete helpers for the Phase 0 native port.
///
/// AppState owns load methods + dashboard mutations (logMeal, saveCheckin,
/// saveGoals, saveBodyMetrics, saveRecipe). DBService owns the rest of
/// the write surface area so per-tab views stay UI-focused: the Recipes
/// view doesn't need to know how to compute a planner row's actual_date,
/// it just calls DBService.savePlannerEntry(...).
///
/// Why a separate type rather than more AppState methods:
///   - Workers fan out in parallel; AppState stored-property edits are
///     forbidden but adding methods to AppState would still risk merge
///     thrash on the same file. DBService is the shared write surface.
///   - These mutations don't need to live on the @MainActor — they're
///     pure network calls. Returning the saved row lets the caller
///     splice it into AppState on the main actor.
///
/// Pattern parity with src/lib/db.js is intentional. If you change a
/// payload here, update the equivalent JS function so web + iOS stay
/// in sync. Function names are on purpose the same as the JS exports.
enum DBService {
    private static var client: SupabaseClient { SupabaseService.client }

    private static func currentUserID() async throws -> String {
        try await client.auth.session.user.id.uuidString
    }

    // ─── Recipes ───────────────────────────────────────────────────────
    //
    // Mirrors upsertRecipe() in db.js. Pass a recipe with .id set to
    // update; omit .id to insert. Returns the saved row.
    @discardableResult
    static func saveRecipe(_ recipe: RecipeUpsert) async throws -> RecipeRow {
        struct Payload: Encodable {
            let id: String?
            let user_id: String
            let updated_at: String
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
            let notes: String?
            let source: String?
            let source_url: String?
            let tags: [String]?
        }
        let userId = try await currentUserID()
        let payload = Payload(
            id: recipe.id,
            user_id: userId,
            updated_at: ISO8601DateFormatter().string(from: Date()),
            name: recipe.name,
            description: recipe.description,
            servings: recipe.servings,
            calories: recipe.calories,
            protein: recipe.protein,
            carbs: recipe.carbs,
            fat: recipe.fat,
            fiber: recipe.fiber,
            sugar: recipe.sugar,
            ingredients: recipe.ingredients,
            notes: recipe.notes,
            source: recipe.source,
            source_url: recipe.sourceUrl,
            tags: recipe.tags
        )
        let rows: [RecipeRow] = try await client
            .from("recipes")
            .upsert(payload)
            .select()
            .execute()
            .value
        guard let row = rows.first else {
            throw DBServiceError.emptyInsert("recipes")
        }
        return row
    }

    static func deleteRecipe(id: String) async throws {
        let userId = try await currentUserID()
        try await client
            .from("recipes")
            .delete()
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .execute()
    }

    // ─── Planner ───────────────────────────────────────────────────────
    //
    // savePlannerEntry mirrors addPlannerMeal() in db.js: the caller
    // supplies weekStart + dayIdx, we compute actual_date from pure
    // date math (no Date constructor → no UTC drift bug). To update an
    // existing row, pass `id` — the caller is responsible for choosing
    // insert vs update; we route both through here.
    @discardableResult
    static func savePlannerEntry(_ entry: PlannerInsert) async throws -> PlannerRow {
        let userId = try await currentUserID()
        // Compute actual_date using pure components — see addPlannerMeal()
        // in db.js for why we don't go through Date constructors.
        let parts = entry.weekStart.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else {
            throw DBServiceError.invalidInput("weekStart must be YYYY-MM-DD: \(entry.weekStart)")
        }
        var comps = DateComponents()
        comps.year = parts[0]
        comps.month = parts[1]
        comps.day = parts[2] + entry.dayIdx
        let cal = Calendar(identifier: .gregorian)
        guard let actual = cal.date(from: comps) else {
            throw DBServiceError.invalidInput("could not derive actual_date from \(entry.weekStart) + \(entry.dayIdx)")
        }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = cal
        f.timeZone = .current
        let actualDateStr = f.string(from: actual)

        struct Payload: Encodable {
            let id: String?
            let user_id: String
            let week_start_date: String
            let day_of_week: Int
            let actual_date: String
            let meal_name: String?
            let meal_type: String?
            let calories: Double
            let protein: Double
            let carbs: Double
            let fat: Double
            let fiber: Double
            let is_leftover: Bool
            let planned_servings: Double?
            let recipe_id: String?
        }
        let payload = Payload(
            id: entry.id,
            user_id: userId,
            week_start_date: entry.weekStart,
            day_of_week: entry.dayIdx,
            actual_date: actualDateStr,
            meal_name: entry.mealName,
            meal_type: entry.mealType,
            calories: entry.calories ?? 0,
            protein: entry.protein ?? 0,
            carbs: entry.carbs ?? 0,
            fat: entry.fat ?? 0,
            fiber: entry.fiber ?? 0,
            is_leftover: entry.isLeftover ?? false,
            planned_servings: entry.plannedServings,
            recipe_id: entry.recipeId
        )
        let rows: [PlannerRow] = try await client
            .from("meal_planner")
            .upsert(payload)
            .select()
            .execute()
            .value
        guard let row = rows.first else {
            throw DBServiceError.emptyInsert("meal_planner")
        }
        return row
    }

    static func deletePlannerEntry(id: String) async throws {
        let userId = try await currentUserID()
        try await client
            .from("meal_planner")
            .delete()
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .execute()
    }

    /// Move a planner row to a different date. Recomputes week_start_date
    /// + day_of_week from the target so the row shows up in the right
    /// week. Mirrors movePlannerMeal() in db.js.
    static func movePlannerEntry(id: String, to targetDate: String) async throws {
        let userId = try await currentUserID()
        let parts = targetDate.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else {
            throw DBServiceError.invalidInput("targetDate must be YYYY-MM-DD: \(targetDate)")
        }
        var comps = DateComponents()
        comps.year = parts[0]
        comps.month = parts[1]
        comps.day = parts[2]
        let cal = Calendar(identifier: .gregorian)
        guard let target = cal.date(from: comps) else {
            throw DBServiceError.invalidInput("could not parse \(targetDate)")
        }
        let dayIdx = cal.component(.weekday, from: target) - 1   // Cal weekday: 1=Sunday
        let weekStart = cal.date(byAdding: .day, value: -dayIdx, to: target)!
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = cal
        f.timeZone = .current
        let weekStartStr = f.string(from: weekStart)

        struct Patch: Encodable {
            let actual_date: String
            let day_of_week: Int
            let week_start_date: String
        }
        try await client
            .from("meal_planner")
            .update(Patch(actual_date: targetDate, day_of_week: dayIdx, week_start_date: weekStartStr))
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .execute()
    }

    // ─── Food items ────────────────────────────────────────────────────
    //
    // Mirrors upsertFoodItem() in db.js. Pass id to update, omit to
    // insert.
    @discardableResult
    static func saveFoodItem(_ item: FoodItemUpsert) async throws -> FoodItemRow {
        struct Payload: Encodable {
            let id: String?
            let user_id: String
            let updated_at: String
            let name: String
            let brand: String?
            let serving_size: String?
            let calories: Double
            let protein: Double
            let carbs: Double
            let fat: Double
            let fiber: Double
            let sugar: Double
            let sodium: Double
            let components: [FoodComponent]?
            let notes: String?
            let source: String?
        }
        let userId = try await currentUserID()
        let payload = Payload(
            id: item.id,
            user_id: userId,
            updated_at: ISO8601DateFormatter().string(from: Date()),
            name: item.name,
            brand: item.brand,
            serving_size: item.servingSize,
            calories: item.calories ?? 0,
            protein: item.protein ?? 0,
            carbs: item.carbs ?? 0,
            fat: item.fat ?? 0,
            fiber: item.fiber ?? 0,
            sugar: item.sugar ?? 0,
            sodium: item.sodium ?? 0,
            components: item.components,
            notes: item.notes,
            source: item.source ?? "manual"
        )
        let rows: [FoodItemRow] = try await client
            .from("food_items")
            .upsert(payload)
            .select()
            .execute()
            .value
        guard let row = rows.first else {
            throw DBServiceError.emptyInsert("food_items")
        }
        return row
    }

    static func deleteFoodItem(id: String) async throws {
        let userId = try await currentUserID()
        try await client
            .from("food_items")
            .delete()
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .execute()
    }

    // ─── Meal log ──────────────────────────────────────────────────────
    //
    // Update + delete entry. AppState.logMeal already covers the insert
    // path on the main actor (it splices into todayLog locally).
    static func updateMealEntry(id: String, _ patch: MealEntryPatch) async throws {
        struct Payload: Encodable {
            let name: String?
            let meal_type: String?
            let calories: Double?
            let protein: Double?
            let carbs: Double?
            let fat: Double?
            let fiber: Double?
            let servings_consumed: Double?
        }
        let userId = try await currentUserID()
        try await client
            .from("meal_log")
            .update(Payload(
                name: patch.name,
                meal_type: patch.mealType,
                calories: patch.calories,
                protein: patch.protein,
                carbs: patch.carbs,
                fat: patch.fat,
                fiber: patch.fiber,
                servings_consumed: patch.servingsConsumed
            ))
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .execute()
    }

    static func deleteMealEntry(id: String) async throws {
        let userId = try await currentUserID()
        try await client
            .from("meal_log")
            .delete()
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .execute()
    }

    // ─── Provider follows ──────────────────────────────────────────────

    static func followProvider(providerId: String) async throws {
        struct Row: Encodable { let follower_id: String; let provider_id: String }
        let me = try await currentUserID()
        try await client
            .from("provider_follows")
            .upsert(Row(follower_id: me, provider_id: providerId),
                    onConflict: "follower_id,provider_id")
            .execute()
    }

    static func unfollowProvider(providerId: String) async throws {
        let me = try await currentUserID()
        try await client
            .from("provider_follows")
            .delete()
            .eq("follower_id", value: me)
            .eq("provider_id", value: providerId)
            .execute()
    }

    // ─── User profile ──────────────────────────────────────────────────
    //
    // Account tab edits (provider channel fields, hidden tag presets,
    // etc) flow through here. Pass only the columns you want to change
    // — nil fields are dropped from the payload so we never blank a
    // column we didn't mean to.
    static func updateProfile(_ patch: ProfilePatch) async throws {
        struct Payload: Encodable {
            let provider_name: String?
            let provider_bio: String?
            let provider_specialty: String?
            let provider_slug: String?
            let provider_avatar_url: String?
            let credentials: String?
            let hidden_tag_presets: [String]?

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: DynamicKey.self)
                if let v = provider_name { try c.encode(v, forKey: DynamicKey("provider_name")) }
                if let v = provider_bio { try c.encode(v, forKey: DynamicKey("provider_bio")) }
                if let v = provider_specialty { try c.encode(v, forKey: DynamicKey("provider_specialty")) }
                if let v = provider_slug { try c.encode(v, forKey: DynamicKey("provider_slug")) }
                if let v = provider_avatar_url { try c.encode(v, forKey: DynamicKey("provider_avatar_url")) }
                if let v = credentials { try c.encode(v, forKey: DynamicKey("credentials")) }
                if let v = hidden_tag_presets { try c.encode(v, forKey: DynamicKey("hidden_tag_presets")) }
            }
        }
        let me = try await currentUserID()
        try await client
            .from("user_profiles")
            .update(Payload(
                provider_name: patch.providerName,
                provider_bio: patch.providerBio,
                provider_specialty: patch.providerSpecialty,
                provider_slug: patch.providerSlug,
                provider_avatar_url: patch.providerAvatarUrl,
                credentials: patch.credentials,
                hidden_tag_presets: patch.hiddenTagPresets
            ))
            .eq("user_id", value: me)
            .execute()
    }

    // ─── Account ───────────────────────────────────────────────────────

    /// Self-service account deletion. Backed by the delete_my_account
    /// RPC (security-definer). Caller must sign out + navigate away.
    static func deleteMyAccount() async throws {
        try await client.rpc("delete_my_account").execute()
    }
}

// ─── Input DTOs ────────────────────────────────────────────────────────
//
// Plain value types so views don't need to know about Encodable payloads.
// Optionals indicate "not changing" for patch types and "use default" for
// upsert types.

struct RecipeUpsert {
    var id: String?
    var name: String
    var description: String?
    var servings: Double?
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var sugar: Double?
    var ingredients: [Ingredient]?
    var notes: String?
    var source: String?
    var sourceUrl: String?
    var tags: [String]?
}

struct PlannerInsert {
    var id: String?                   // set to update; nil to insert
    var weekStart: String             // YYYY-MM-DD (Sunday)
    var dayIdx: Int                   // 0–6 (0=Sunday)
    var mealName: String?
    var mealType: String?
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var isLeftover: Bool?
    var plannedServings: Double?
    var recipeId: String?
}

struct FoodItemUpsert {
    var id: String?
    var name: String
    var brand: String?
    var servingSize: String?
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var sugar: Double?
    var sodium: Double?
    var components: [FoodComponent]?
    var notes: String?
    var source: String?
}

struct MealEntryPatch {
    var name: String?
    var mealType: String?
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var servingsConsumed: Double?
}

struct ProfilePatch {
    var providerName: String?
    var providerBio: String?
    var providerSpecialty: String?
    var providerSlug: String?
    var providerAvatarUrl: String?
    var credentials: String?
    var hiddenTagPresets: [String]?
}

enum DBServiceError: LocalizedError {
    case emptyInsert(String)
    case invalidInput(String)

    var errorDescription: String? {
        switch self {
        case .emptyInsert(let table): return "\(table) insert returned no rows"
        case .invalidInput(let msg):  return msg
        }
    }
}

/// CodingKey shim for ProfilePatch's selective-encoding pattern. Keeps
/// us from leaking nil columns into the update payload.
private struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { self.stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}
