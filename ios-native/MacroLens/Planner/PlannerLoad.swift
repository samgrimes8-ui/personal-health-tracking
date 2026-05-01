import Foundation
import Supabase

/// Body of the planner-tab loaders. Lives outside AppState.swift so
/// parallel tab workers don't keep clobbering each other's stub
/// fill-ins. AppState.loadPlanner / loadRecipesFull forward to these.
extension AppState {
    /// Pull this week's meal_planner rows + bucket them by weekday.
    /// Mirrors getPlannerWeek() in src/lib/db.js.
    func plannerLoadImpl(weekStart: String) async {
        let snapped = PlannerDateMath.snapToSunday(weekStart) ?? weekStart
        plannerWeekStart = snapped
        do {
            let userId = try await SupabaseService.client.auth.session.user.id.uuidString
            let rows: [PlannerRow] = try await SupabaseService.client
                .from("meal_planner")
                .select()
                .eq("user_id", value: userId)
                .eq("week_start_date", value: snapped)
                .order("day_of_week", ascending: true)
                .execute()
                .value
            // Bucket by actual_date weekday when available — older rows
            // may have a stale day_of_week, but the date is authoritative.
            var bucket: [[PlannerRow]] = Array(repeating: [], count: 7)
            for row in rows {
                let slot = PlannerDateMath.slotIndex(for: row) ?? 0
                if slot >= 0 && slot < 7 { bucket[slot].append(row) }
            }
            plannerByDay = bucket
            // Recipes drive the picker + grocery list. Cheap miss —
            // we re-fetch only when the cache is empty.
            if recipesFull.isEmpty {
                await plannerLoadRecipesFullImpl()
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Linked leftovers for a main meal (same recipe, marked is_leftover,
    /// scheduled later). Mirrors findLinkedLeftovers() in app.js — searches
    /// the currently-loaded week, since leftover/main pairs typically land
    /// within the same Sunday-week.
    func linkedLeftovers(of main: PlannerRow) -> [PlannerRow] {
        guard main.is_leftover != true,
              let recipeId = main.recipe_id,
              let mainDate = main.actual_date else { return [] }
        var results: [PlannerRow] = []
        for day in plannerByDay {
            for m in day {
                if m.id == main.id { continue }
                if m.is_leftover != true { continue }
                if m.recipe_id != recipeId { continue }
                guard let d = m.actual_date, d > mainDate else { continue }
                results.append(m)
            }
        }
        return results
    }

    /// Linked main meal for a leftover (same recipe, NOT a leftover,
    /// scheduled earlier). Returns the closest preceding match. Used to
    /// classify a leftover-drag as before/after the source cook.
    func linkedMain(of leftover: PlannerRow) -> PlannerRow? {
        guard leftover.is_leftover == true,
              let recipeId = leftover.recipe_id,
              let loDate = leftover.actual_date else { return nil }
        var best: PlannerRow?
        for day in plannerByDay {
            for m in day {
                if m.id == leftover.id { continue }
                if m.is_leftover == true { continue }
                if m.recipe_id != recipeId { continue }
                guard let d = m.actual_date, d < loDate else { continue }
                if let cur = best?.actual_date, d <= cur { continue }
                best = m
            }
        }
        return best
    }

    /// Recipes library projection used by the planner picker + grocery
    /// list (the dashboard's `recipes` slice already covers the same
    /// columns; we populate both to keep the dashboard cheap after a
    /// planner visit).
    func plannerLoadRecipesFullImpl() async {
        do {
            let userId = try await SupabaseService.client.auth.session.user.id.uuidString
            let rows: [RecipeRow] = try await SupabaseService.client
                .from("recipes")
                .select("id, name, calories, protein, carbs, fat, fiber, servings")
                .eq("user_id", value: userId)
                .order("name", ascending: true)
                .limit(500)
                .execute()
                .value
            self.recipesFull = rows
            self.recipes = rows
        } catch {
            lastError = error.localizedDescription
        }
    }
}
