import Foundation
import Supabase

/// Mints `meal_plan_shares` rows for the planner Share button.
///
/// Mirrors createMealPlanShare() in src/lib/db.js: snapshot the week's
/// meals + their referenced recipes, then POST as a single row with an
/// embedded `plan_data` jsonb so the public landing page is self-contained
/// (no cross-user RLS gymnastics on the recipe rows).
enum PlannerSharingService {
    struct Result {
        let id: String
        let shareToken: String
    }

    /// Insert a fresh share for the given Sunday. Throws if the week has
    /// no meals — same precondition as the web flow.
    static func createShare(weekStart: String, label: String?) async throws -> Result {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let weekEnd = PlannerDateMath.addDays(weekStart, 6)

        // Fetch this week's meals (use actual_date so we don't trip over
        // older rows whose week_start_date drifted).
        let meals: [PlannerRow] = try await SupabaseService.client
            .from("meal_planner")
            .select("id, day_of_week, meal_type, meal_name, planned_servings, is_leftover, recipe_id, actual_date, week_start_date, calories, protein, carbs, fat, fiber")
            .eq("user_id", value: userId)
            .gte("actual_date", value: weekStart)
            .lte("actual_date", value: weekEnd)
            .order("actual_date", ascending: true)
            .execute()
            .value
        guard !meals.isEmpty else {
            throw NSError(domain: "PlannerSharing", code: 0,
                          userInfo: [NSLocalizedDescriptionKey: "No meals planned for that week"])
        }

        // Pull the recipes referenced by these meals so the snapshot is
        // self-contained.
        let recipeIds = Set(meals.compactMap { $0.recipe_id })
        var recipesById: [String: SnapshotRecipe] = [:]
        if !recipeIds.isEmpty {
            // We deliberately skip `instructions` here — it's a permissive
            // jsonb on the web side (sometimes [String], sometimes [{step,text}])
            // and decoding it cleanly in Swift would force a polymorphic
            // shape we don't need on the share recipient's view of the world.
            // Tags + source_url are also omitted for the same reason.
            let rows: [SnapshotRecipe] = try await SupabaseService.client
                .from("recipes")
                .select("id, name, servings, ingredients, calories, protein, carbs, fat, fiber, sugar, description")
                .eq("user_id", value: userId)
                .in("id", values: Array(recipeIds))
                .execute()
                .value
            for r in rows { recipesById[r.id] = r }
        }

        let planData: [PlanItem] = meals.map { m in
            let snap = m.recipe_id.flatMap { recipesById[$0] }
            return PlanItem(
                day_of_week: m.day_of_week,
                meal_type: m.meal_type,
                meal_name: m.meal_name,
                planned_servings: m.planned_servings,
                is_leftover: m.is_leftover ?? false,
                actual_date: m.actual_date,
                recipe_id: m.recipe_id,
                recipe_snapshot: snap
            )
        }

        let token = makeShareToken()
        struct Payload: Encodable {
            let owner_user_id: String
            let share_token: String
            let week_start: String
            let label: String?
            let plan_data: [PlanItem]
            let is_active: Bool
        }
        let payload = Payload(
            owner_user_id: userId,
            share_token: token,
            week_start: weekStart,
            label: label,
            plan_data: planData,
            is_active: true
        )

        let inserted: [InsertedShareRow] = try await SupabaseService.client
            .from("meal_plan_shares")
            .insert(payload)
            .select("id, share_token")
            .execute()
            .value
        guard let row = inserted.first else {
            throw NSError(domain: "PlannerSharing", code: 0,
                          userInfo: [NSLocalizedDescriptionKey: "meal_plan_shares insert returned no rows"])
        }
        return Result(id: row.id, shareToken: row.share_token)
    }

    /// Same shape as the web _shortShareToken(): two random base36 chunks
    /// concatenated. Length jitter is fine — the column is a free-form
    /// text and the index is on `is_active`.
    private static func makeShareToken() -> String {
        chunk() + chunk()
    }

    private static func chunk() -> String {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return String((0..<6).map { _ in alphabet.randomElement()! })
    }
}

/// One item in plan_data jsonb. Mirrors the snapshot built by
/// createMealPlanShare() in db.js — the recipient's landing page expects
/// this exact shape.
private struct PlanItem: Encodable {
    let day_of_week: Int?
    let meal_type: String?
    let meal_name: String?
    let planned_servings: Double?
    let is_leftover: Bool
    let actual_date: String?
    let recipe_id: String?
    let recipe_snapshot: SnapshotRecipe?
}

/// Embedded recipe shape inside plan_data. Matches the web snapshot's
/// keys exactly so the public share page renders without divergence.
private struct SnapshotRecipe: Codable, Hashable {
    var id: String
    var name: String
    var servings: Double?
    var ingredients: [Ingredient]?
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var sugar: Double?
    var description: String?
}

private struct InsertedShareRow: Decodable {
    let id: String
    let share_token: String
}
