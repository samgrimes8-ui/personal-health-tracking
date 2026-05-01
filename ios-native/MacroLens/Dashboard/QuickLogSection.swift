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

    private var resultsList: some View {
        let results = filteredResults
        return VStack(spacing: 6) {
            if results.isEmpty {
                Text(query.isEmpty
                    ? "Nothing logged yet — analyze a meal below to get started."
                    : "No matches.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            } else {
                ForEach(results) { item in
                    quickLogRow(item)
                }
            }
        }
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

    /// Build the displayed row set. With no query: 2 most-recent meals +
    /// 2 most-recent foods, with cross-fill when either side has fewer
    /// than 2 (so the card always shows up to 4 rows). With a query:
    /// case-insensitive name filter across the preloaded meals, foods,
    /// and the user's recipe library.
    private var filteredResults: [QuickLogItem] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()

        let mealItems: [QuickLogItem] = state.dashboardRecentMeals.compactMap { entry in
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

        let foodItems: [QuickLogItem] = state.dashboardRecentFoods.map { f in
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

        if q.isEmpty {
            // No query — apply the 2+2 split with cross-fill so the card
            // always renders up to 4 rows (or fewer if both wells dry).
            let target = 4
            let mealsAvailable = mealItems.count
            let foodsAvailable = foodItems.count
            let mealsToShow: Int
            let foodsToShow: Int
            if mealsAvailable >= 2 && foodsAvailable >= 2 {
                mealsToShow = 2
                foodsToShow = 2
            } else if mealsAvailable < 2 {
                mealsToShow = mealsAvailable
                foodsToShow = min(foodsAvailable, target - mealsToShow)
            } else {
                foodsToShow = foodsAvailable
                mealsToShow = min(mealsAvailable, target - foodsToShow)
            }
            return Array(mealItems.prefix(mealsToShow)) + Array(foodItems.prefix(foodsToShow))
        }

        // Search mode — filter the preloaded meals + foods, then add
        // recipe matches from the already-loaded recipe library so the
        // search box doubles as a "find a saved recipe to log" entry
        // point. Cap to 12 rows so the card doesn't unbound.
        var seenNames = Set<String>()
        var matches: [QuickLogItem] = []
        let pool: [QuickLogItem] = mealItems + foodItems
        for item in pool {
            let key = item.name.lowercased()
            if !key.contains(q) { continue }
            if seenNames.contains(key) { continue }
            seenNames.insert(key)
            matches.append(item)
        }
        for r in state.recipes {
            let key = r.name.lowercased()
            if !key.contains(q) { continue }
            if seenNames.contains(key) { continue }
            seenNames.insert(key)
            matches.append(QuickLogItem(
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
        return Array(matches.prefix(12))
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
                foodItemId: item.foodItemId
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
