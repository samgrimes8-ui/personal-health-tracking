import SwiftUI

/// Searchable list of recent meal_log + food_items rows. Tap any row
/// to log it again as today's meal. AI-free path: just inserts into
/// meal_log with the row's stored macros (and a food_item_id link
/// when re-logging from the Foods library).
///
/// Preload behavior matches the dashboard spec: show the 2 most-recent
/// meals and 2 most-recent saved foods (4 items total). If either
/// side runs short, fill from the other to still hit 4. With a search
/// query, also filter against the user's recipe library so saved
/// recipes show up by name.
struct QuickLogSection: View {
    @Environment(AppState.self) private var state
    @State private var query: String = ""
    @State private var loggingId: String?
    @State private var toast: String?
    /// Live-search results from food_items + meal_log. Populated by
    /// debounceSearch when query has text; empty when the search box
    /// is empty (preload sections render instead).
    @State private var searchResults: [QuickLogItem] = []
    @State private var searching: Bool = false
    @State private var searchTask: Task<Void, Never>?
    /// The last query value that runLiveSearch finished decoding for.
    /// We gate the AI-describe affordance on this matching the current
    /// query so the button doesn't appear during the debounce window
    /// (when results are still empty because we haven't queried yet).
    @State private var lastSearchedQuery: String = ""
    @State private var aiDescribing: Bool = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Quick log")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.text)
                Spacer()
                Text("recent meals & foods")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)

            Divider().background(Theme.border)

            VStack(spacing: 8) {
                searchField
                if let toast {
                    Text(toast)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.green)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                resultsList
            }
            .padding(12)
        }
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
        .onChange(of: query) { _, newValue in
            scheduleSearch(for: newValue)
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.text3)
                .font(.system(size: 13))
            TextField("Search meals, foods, and recipes…", text: $query)
                .focused($searchFocused)
                .submitLabel(.search)
                .onSubmit { searchFocused = false }
                .font(.system(size: 13))
                .foregroundStyle(Theme.text)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.text3)
                        .font(.system(size: 14))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 13).padding(.vertical, 9)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
        .toolbar {
            // Single Done button on the keyboard so users always have a
            // way out of the search field — TextField doesn't trigger
            // .onSubmit until the user hits return, and not every iOS
            // keyboard variant exposes a return key in the same place.
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if searchFocused {
                    Button("Done") { searchFocused = false }
                }
            }
        }
    }

    @ViewBuilder
    private var resultsList: some View {
        if query.trimmingCharacters(in: .whitespaces).isEmpty {
            preloadedSections
        } else {
            searchResultsList
        }
    }

    /// No-query state. Two labeled sections so the user can see at a
    /// glance that meal_log + food_items are both being read — earlier
    /// versions rendered a single flat list and made it ambiguous
    /// whether saved foods were being pulled at all.
    @ViewBuilder
    private var preloadedSections: some View {
        let meals = preloadedMeals
        let foods = preloadedFoods
        if meals.isEmpty && foods.isEmpty {
            Text("Nothing logged yet — analyze a meal below to get started.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if !meals.isEmpty {
                    sectionHeader("Recent meals", icon: "clock.arrow.circlepath")
                    ForEach(meals) { quickLogRow($0) }
                }
                if !foods.isEmpty {
                    sectionHeader("From your saved foods", icon: "leaf.fill")
                        .padding(.top, meals.isEmpty ? 0 : 6)
                    ForEach(foods) { quickLogRow($0) }
                }
            }
        }
    }

    /// Search-mode list: live DB-backed results from food_items +
    /// meal_log (debounced 250ms after typing stops), merged with the
    /// in-memory recipe library. When the search returns nothing we
    /// surface an "AI describe" affordance so a brand-new food the
    /// user has never logged before still has a one-tap path.
    @ViewBuilder
    private var searchResultsList: some View {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        let queryStable = !trimmed.isEmpty && lastSearchedQuery == trimmed
        if searching && searchResults.isEmpty {
            HStack(spacing: 6) {
                ProgressView().scaleEffect(0.7)
                Text("Searching…")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
        } else if !searchResults.isEmpty {
            VStack(spacing: 6) {
                ForEach(searchResults) { quickLogRow($0) }
            }
        } else if queryStable {
            // Searched, came up empty → offer the AI describe path so
            // users can log something they've never logged before
            // without leaving the field. Mirrors the web's "Describe X
            // with AI" fallback in the dashboard search box.
            VStack(alignment: .leading, spacing: 8) {
                Text("No matches.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                aiDescribeButton(trimmed)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
        }
    }

    private func aiDescribeButton(_ q: String) -> some View {
        Button {
            Task { await aiDescribeAndLog(q) }
        } label: {
            HStack(spacing: 8) {
                if aiDescribing {
                    ProgressView().scaleEffect(0.7).tint(Theme.accentFG)
                    Text("Describing & logging…")
                } else {
                    Image(systemName: "sparkles")
                    Text("Describe \"\(q)\" with AI")
                }
            }
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Theme.accentFG)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Theme.accent, in: .rect(cornerRadius: 8))
        }
        .disabled(aiDescribing)
    }

    private func sectionHeader(_ label: String, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(Theme.text3)
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.5)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    private func quickLogRow(_ item: QuickLogItem) -> some View {
        Button {
            Task { await log(item) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: item.kind.icon)
                    .foregroundStyle(item.kind.tint)
                    .font(.system(size: 12))
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    Text("\(Int(item.calories)) kcal · \(Int(item.protein))P · \(Int(item.carbs))C · \(Int(item.fat))F")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
                Spacer()
                if loggingId == item.id {
                    ProgressView().scaleEffect(0.7)
                } else {
                    Image(systemName: "plus.circle.fill")
                        .foregroundStyle(Theme.accent)
                        .font(.system(size: 18))
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background(Theme.bg3, in: .rect(cornerRadius: 8))
        }
        .disabled(loggingId == item.id)
    }

    // MARK: - Data

    /// All recent meal_log entries projected to QuickLogItem.
    private var allMealItems: [QuickLogItem] {
        state.dashboardRecentMeals.compactMap { entry in
            guard let name = entry.name, !name.isEmpty else { return nil }
            return QuickLogItem(
                id: "log-\(entry.id)",
                name: name,
                calories: entry.calories ?? 0,
                protein: entry.protein ?? 0,
                carbs: entry.carbs ?? 0,
                fat: entry.fat ?? 0,
                fiber: entry.fiber ?? 0,
                recipeId: entry.recipe_id,
                foodItemId: entry.food_item_id,
                kind: .recent
            )
        }
    }

    /// All recent food_items projected to QuickLogItem.
    private var allFoodItems: [QuickLogItem] {
        state.dashboardRecentFoods.map { f in
            QuickLogItem(
                id: "food-\(f.id)",
                name: f.name,
                calories: f.calories ?? 0,
                protein: f.protein ?? 0,
                carbs: f.carbs ?? 0,
                fat: f.fat ?? 0,
                fiber: f.fiber ?? 0,
                recipeId: nil,
                foodItemId: f.id,
                kind: .food
            )
        }
    }

    /// Meals slice for the no-query preload — top of 2+2 split with
    /// cross-fill from foods when meals are sparse (so we always try
    /// to hit 4 total rows across both sections).
    private var preloadedMeals: [QuickLogItem] {
        let (m, _) = splitForPreload(meals: allMealItems.count, foods: allFoodItems.count)
        return Array(allMealItems.prefix(m))
    }

    /// Foods slice for the no-query preload — bottom of 2+2 split with
    /// the same cross-fill rule.
    private var preloadedFoods: [QuickLogItem] {
        let (_, f) = splitForPreload(meals: allMealItems.count, foods: allFoodItems.count)
        return Array(allFoodItems.prefix(f))
    }

    /// Decide how many meals + foods to show in the no-query preload.
    /// Default 2-and-2; if either well is shy, fill from the other up
    /// to a target of 4 rows total.
    private func splitForPreload(meals available: Int, foods foodsAvailable: Int) -> (meals: Int, foods: Int) {
        let target = 4
        if available >= 2 && foodsAvailable >= 2 {
            return (2, 2)
        } else if available < 2 {
            let m = available
            return (m, min(foodsAvailable, target - m))
        } else {
            let f = foodsAvailable
            return (min(available, target - f), f)
        }
    }

    // MARK: - Live search

    /// Cancel any in-flight search and either clear results (empty
    /// query) or schedule a new debounced search. Called from
    /// .onChange(of: query).
    private func scheduleSearch(for value: String) {
        searchTask?.cancel()
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            searchResults = []
            searching = false
            lastSearchedQuery = ""
            return
        }
        // Reset stable-query gate immediately so the AI-describe button
        // doesn't flash for the previous query while the new one debounces.
        if lastSearchedQuery != trimmed { lastSearchedQuery = "" }
        searchTask = Task {
            // 250ms debounce — short enough to feel live, long enough
            // that fast typing doesn't fan out a request per keystroke.
            try? await Task.sleep(for: .milliseconds(250))
            if Task.isCancelled { return }
            await runLiveSearch(trimmed)
        }
    }

    /// Hit food_items + meal_log in parallel for the current query,
    /// merge with the in-memory recipe library, and dedupe.
    /// Errors are swallowed so a transient network blip just shows
    /// "no matches" with the AI describe fallback (instead of an error
    /// banner that doesn't help the user).
    private func runLiveSearch(_ q: String) async {
        searching = true
        defer { searching = false }
        async let foods: [QuickLogItem] = (try? await searchFoodItems(q)) ?? []
        async let meals: [QuickLogItem] = (try? await searchMealLog(q)) ?? []
        let foodHits = await foods
        let mealHits = await meals
        if Task.isCancelled { return }

        var seenFoodIds = Set<String>()
        var seenNames = Set<String>()
        var out: [QuickLogItem] = []
        // Order: food_items first (canonical, with brand info), then
        // meal_log history (deduped against the food_items set), then
        // recipe library — so a search that matches a saved food shows
        // the food row instead of a redundant meal_log row.
        for item in foodHits + mealHits {
            if let fid = item.foodItemId, seenFoodIds.contains(fid) { continue }
            let nameKey = item.name.lowercased()
            if seenNames.contains(nameKey) { continue }
            if let fid = item.foodItemId { seenFoodIds.insert(fid) }
            seenNames.insert(nameKey)
            out.append(item)
        }
        let lower = q.lowercased()
        for r in state.recipes where r.name.lowercased().contains(lower) {
            let key = r.name.lowercased()
            if seenNames.contains(key) { continue }
            seenNames.insert(key)
            out.append(QuickLogItem(
                id: "recipe-\(r.id)",
                name: r.name,
                calories: r.calories ?? 0,
                protein: r.protein ?? 0,
                carbs: r.carbs ?? 0,
                fat: r.fat ?? 0,
                fiber: r.fiber ?? 0,
                recipeId: r.id,
                foodItemId: nil,
                kind: .recipe
            ))
        }
        searchResults = Array(out.prefix(20))
        lastSearchedQuery = q
    }

    /// Case-insensitive substring search on food_items, hitting both
    /// the name column and the brand column.
    ///
    /// Implementation note: an earlier version used PostgREST's `or`
    /// filter (`name.ilike.%q%,brand.ilike.%q%`). The `.or()` method
    /// on supabase-swift passes the filter string verbatim into the
    /// URL, where `%` becomes `%25` after URL-encoding — which works
    /// in some PostgREST versions but not reliably (the canonical
    /// URL wildcard is `*`, with `%` only working when the entire
    /// pattern survives unescaped through the value parser). To
    /// avoid that ambiguity entirely, we issue two `.ilike()` calls
    /// in parallel and merge — `.ilike(column:pattern:)` is the same
    /// path autoSaveFoodItem uses successfully, so wildcard handling
    /// is well-tested.
    private func searchFoodItems(_ q: String) async throws -> [QuickLogItem] {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let pattern = "%\(escapeLike(q))%"
        async let byName = ilikeFoodItems(userId: userId, column: "name", pattern: pattern)
        async let byBrand = ilikeFoodItems(userId: userId, column: "brand", pattern: pattern)
        let nameHits = (try? await byName) ?? []
        let brandHits = (try? await byBrand) ?? []
        // Dedup by id; name hits win position over brand hits since
        // most users search by food name, not vendor.
        var seenIds = Set<String>()
        var merged: [FoodItemRow] = []
        for f in nameHits + brandHits {
            if seenIds.insert(f.id).inserted {
                merged.append(f)
            }
        }
        return merged.prefix(10).map { f in
            QuickLogItem(
                id: "food-\(f.id)",
                name: f.name,
                calories: f.calories ?? 0,
                protein: f.protein ?? 0,
                carbs: f.carbs ?? 0,
                fat: f.fat ?? 0,
                fiber: f.fiber ?? 0,
                recipeId: nil,
                foodItemId: f.id,
                kind: .food
            )
        }
    }

    private func ilikeFoodItems(userId: String, column: String, pattern: String) async throws -> [FoodItemRow] {
        try await SupabaseService.client
            .from("food_items")
            .select()
            .eq("user_id", value: userId)
            .ilike(column, pattern: pattern)
            .order("updated_at", ascending: false)
            .limit(10)
            .execute()
            .value
    }

    /// Case-insensitive ilike on meal_log.name. Pulls a wider window
    /// (50 rows) and dedupes by lowercase name in Swift so the user
    /// sees one entry per food they've ever logged that matches —
    /// frequency is implied by the most-recent timestamp winning.
    private func searchMealLog(_ q: String) async throws -> [QuickLogItem] {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let pattern = "%\(escapeLike(q))%"
        let rows: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .select()
            .eq("user_id", value: userId)
            .ilike("name", pattern: pattern)
            .order("logged_at", ascending: false)
            .limit(50)
            .execute()
            .value
        var seen = Set<String>()
        var out: [QuickLogItem] = []
        for entry in rows {
            guard let name = entry.name, !name.isEmpty else { continue }
            let key = name.lowercased()
            if seen.contains(key) { continue }
            seen.insert(key)
            out.append(QuickLogItem(
                id: "log-\(entry.id)",
                name: name,
                calories: entry.calories ?? 0,
                protein: entry.protein ?? 0,
                carbs: entry.carbs ?? 0,
                fat: entry.fat ?? 0,
                fiber: entry.fiber ?? 0,
                recipeId: entry.recipe_id,
                foodItemId: entry.food_item_id,
                kind: .recent
            ))
            if out.count >= 10 { break }
        }
        return out
    }

    /// Escape PostgREST ilike wildcards in user input — a stray `%` or
    /// `_` from the user shouldn't widen the match beyond what they
    /// typed. We wrap the result in `%…%` ourselves at the call site.
    private func escapeLike(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_")
    }

    /// AI fallback: describe-by-text via /api/analyze, then log the
    /// result. Mirrors the web's "Describe X with AI" affordance in
    /// the dashboard search box. logMeal's auto-save promotes the
    /// resulting food into the user's Foods library so subsequent
    /// searches find it without the AI roundtrip.
    private func aiDescribeAndLog(_ q: String) async {
        aiDescribing = true
        defer { aiDescribing = false }
        do {
            let result = try await AnalyzeService.describeFood(q)
            try await state.logMeal(
                name: result.name,
                calories: result.calories,
                protein: result.protein,
                carbs: result.carbs,
                fat: result.fat,
                fiber: result.fiber ?? 0,
                loggedAt: state.loggedAtForSelectedDate()
            )
            // Reset the search field so the user sees the toast +
            // returns to the preload sections (which will now include
            // the freshly-saved food on next loadDashboard).
            query = ""
            searchResults = []
            lastSearchedQuery = ""
            withAnimation { toast = "✓ Logged \(result.name)" }
            try? await Task.sleep(for: .seconds(2))
            withAnimation { toast = nil }
        } catch {
            withAnimation { toast = "AI describe failed: \(error.localizedDescription)" }
        }
    }

    private func log(_ item: QuickLogItem) async {
        loggingId = item.id
        defer { loggingId = nil }
        do {
            try await state.logMeal(
                name: item.name,
                calories: item.calories,
                protein: item.protein,
                carbs: item.carbs,
                fat: item.fat,
                fiber: item.fiber,
                recipeId: item.recipeId,
                foodItemId: item.foodItemId,
                loggedAt: state.loggedAtForSelectedDate()
            )
            withAnimation { toast = "✓ Logged \(item.name)" }
            try? await Task.sleep(for: .seconds(2))
            withAnimation { toast = nil }
        } catch {
            withAnimation { toast = "Couldn't log: \(error.localizedDescription)" }
        }
    }
}

private struct QuickLogItem: Identifiable, Hashable {
    enum Kind {
        case recipe, recent, food

        var icon: String {
            switch self {
            case .recipe: return "book.fill"
            case .recent: return "clock.arrow.circlepath"
            case .food:   return "leaf.fill"
            }
        }
        var tint: Color {
            switch self {
            case .recipe: return Theme.accent
            case .recent: return Theme.text3
            case .food:   return Theme.carbs
            }
        }
    }
    let id: String
    let name: String
    let calories: Double
    let protein: Double
    let carbs: Double
    let fat: Double
    let fiber: Double
    let recipeId: String?
    let foodItemId: String?
    let kind: Kind
}
