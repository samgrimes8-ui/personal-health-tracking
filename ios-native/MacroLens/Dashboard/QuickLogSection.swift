import SwiftUI

/// Searchable list of recent meal_log entries + recipes. Tap any row
/// to log it again as today's meal. AI-free path: just inserts into
/// meal_log with the row's stored macros.
struct QuickLogSection: View {
    @Environment(AppState.self) private var state
    @State private var query: String = ""
    @State private var showAll: Bool = false
    @State private var loggingId: String?
    @State private var toast: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Quick log")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.text)
                Spacer()
                Text("from recipes & history")
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
            TextField("Search meals and recipes to log…", text: $query)
                .font(.system(size: 13))
                .foregroundStyle(Theme.text)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
        }
        .padding(.horizontal, 13).padding(.vertical, 9)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
    }

    private var resultsList: some View {
        let results = filteredResults
        let visible = showAll ? results : Array(results.prefix(8))
        return VStack(spacing: 6) {
            if results.isEmpty {
                Text(query.isEmpty
                    ? "Log a meal here, or analyze something below."
                    : "No matches.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            } else {
                ForEach(visible) { item in
                    quickLogRow(item)
                }
                if results.count > visible.count {
                    Button("Show \(results.count - visible.count) more") {
                        showAll = true
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                }
            }
        }
    }

    private func quickLogRow(_ item: QuickLogItem) -> some View {
        Button {
            Task { await log(item) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: item.kind == .recipe ? "book.fill" : "clock.arrow.circlepath")
                    .foregroundStyle(item.kind == .recipe ? Theme.accent : Theme.text3)
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

    /// Combined results: today's recent log entries (deduped by name)
    /// first, then recipe library matches. Recent items sort to top so
    /// "log what I had yesterday" stays one tap away.
    private var filteredResults: [QuickLogItem] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()

        var seenNames = Set<String>()
        var recentItems: [QuickLogItem] = []
        for entry in state.todayLog {
            let name = entry.name ?? ""
            if name.isEmpty { continue }
            let key = name.lowercased()
            if seenNames.contains(key) { continue }
            seenNames.insert(key)
            if !q.isEmpty && !key.contains(q) { continue }
            recentItems.append(QuickLogItem(
                id: "log-\(entry.id)",
                name: name,
                calories: entry.calories ?? 0,
                protein: entry.protein ?? 0,
                carbs: entry.carbs ?? 0,
                fat: entry.fat ?? 0,
                fiber: entry.fiber ?? 0,
                recipeId: entry.recipe_id,
                kind: .recent
            ))
        }

        let recipeItems: [QuickLogItem] = state.recipes.compactMap { r in
            let key = r.name.lowercased()
            if seenNames.contains(key) { return nil }
            if !q.isEmpty && !key.contains(q) { return nil }
            return QuickLogItem(
                id: "recipe-\(r.id)",
                name: r.name,
                calories: r.calories ?? 0,
                protein: r.protein ?? 0,
                carbs: r.carbs ?? 0,
                fat: r.fat ?? 0,
                fiber: r.fiber ?? 0,
                recipeId: r.id,
                kind: .recipe
            )
        }

        return recentItems + recipeItems
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
                recipeId: item.recipeId
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
    enum Kind { case recipe, recent }
    let id: String
    let name: String
    let calories: Double
    let protein: Double
    let carbs: Double
    let fat: Double
    let fiber: Double
    let recipeId: String?
    let kind: Kind
}
