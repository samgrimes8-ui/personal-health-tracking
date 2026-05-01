import SwiftUI

/// Native Foods tab — the user's saved food_items library.
///
/// Mirrors renderFoodsPage in src/pages/app.js (lines 2922-3232) at parity:
///   - Search field over name/brand/components
///   - "+ New food" CTA opens the editor sheet
///   - Each card shows name/brand, serving, component count, macro pills,
///     and a quick "+ Log this" action
///   - Tap a card to edit
///
/// The editor sheet itself lives in `FoodEditorView.swift`. Barcode scans
/// (live camera + manual entry) flow through the editor's component
/// add-panel, not from this list — same UX as web.
struct FoodsView: View {
    @Environment(AppState.self) private var state

    @State private var search: String = ""
    @State private var editingItem: FoodItemRow?
    @State private var creatingNew: Bool = false
    @State private var quickLogTarget: FoodItemRow?
    @State private var toast: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                greeting

                searchRow

                if filteredFoods.isEmpty {
                    emptyState
                } else {
                    foodsGrid
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await state.loadFoods() }
        .task { await state.loadFoods() }
        .navigationTitle("My Foods")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $creatingNew) {
            FoodEditorView(item: nil)
                .environment(state)
        }
        .sheet(item: $editingItem) { item in
            FoodEditorView(item: item)
                .environment(state)
        }
        .confirmationDialog(
            quickLogTarget.map { "Log \($0.name)" } ?? "",
            isPresented: Binding(get: { quickLogTarget != nil },
                                 set: { if !$0 { quickLogTarget = nil } }),
            titleVisibility: .visible,
            presenting: quickLogTarget
        ) { item in
            Button("Log as one food") {
                Task { await logAsOne(item) }
            }
            if (item.components?.count ?? 0) > 1 {
                Button("Log individual components") {
                    Task { await logComponents(item) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { item in
            let comps = item.components?.count ?? 0
            if comps > 1 {
                Text("This food has \(comps) components. How do you want to log it?")
            } else {
                Text("\(Int(item.calories ?? 0)) kcal · P\(Int(item.protein ?? 0))g · C\(Int(item.carbs ?? 0))g · F\(Int(item.fat ?? 0))g")
            }
        }
        .overlay(alignment: .bottom) {
            if let toast {
                Text(toast)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.accentFG)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(Theme.text.opacity(0.92), in: .rect(cornerRadius: 999))
                    .padding(.bottom, 28)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: toast)
    }

    // MARK: - Sections

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("My Foods")
                .font(.system(size: 26, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
            Text("Saved food items — single foods, combos, protein shakes.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
        }
        .padding(.top, 12)
    }

    private var searchRow: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text3)
                TextField("Search foods by name, brand, or component…", text: $search)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.text)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !search.isEmpty {
                    Button { search = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.text3)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))

            Button {
                creatingNew = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .semibold))
                    Text("New food")
                        .font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(Theme.accentFG)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.accent, in: .rect(cornerRadius: 10))
            }
        }
    }

    private var emptyState: some View {
        Card {
            EmptyState(
                icon: "fork.knife",
                title: state.foods.isEmpty ? "No saved foods yet." : "No foods match \"\(search)\".",
                message: state.foods.isEmpty
                    ? "Save packaged foods from a barcode scan, or build combos like protein shakes."
                    : "Try a different search."
            )
        }
    }

    private var foodsGrid: some View {
        let columns = [GridItem(.adaptive(minimum: 280), spacing: 12)]
        return LazyVGrid(columns: columns, spacing: 12) {
            ForEach(filteredFoods) { food in
                foodCard(food)
            }
        }
    }

    @ViewBuilder
    private func foodCard(_ f: FoodItemRow) -> some View {
        Button {
            editingItem = f
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(f.name)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.text)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if let brand = f.brand, !brand.isEmpty {
                            Text(brand)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.text3)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(f.serving_size?.isEmpty == false ? f.serving_size! : "1 serving")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                        if let count = f.components?.count, count > 0 {
                            Text("\(count) component\(count == 1 ? "" : "s")")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.carbs)
                        }
                    }
                }

                HStack(spacing: 6) {
                    MacroChip(.calories, label: "kcal", amount: f.calories ?? 0)
                    MacroChip(.protein, label: "P", amount: f.protein ?? 0)
                    MacroChip(.carbs, label: "C", amount: f.carbs ?? 0)
                    MacroChip(.fat, label: "F", amount: f.fat ?? 0)
                }

                Button {
                    handleQuickLog(f)
                } label: {
                    Text("+ Log this")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Theme.accentSoft(), in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.accent.opacity(0.25), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bg2, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Search

    private var filteredFoods: [FoodItemRow] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return state.foods }
        return state.foods
            .map { (food: $0, score: rank($0, q)) }
            .filter { $0.score > 0 }
            .sorted { (lhs, rhs) in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                let l = lhs.food.name.lowercased()
                let r = rhs.food.name.lowercased()
                if l.count != r.count { return l.count < r.count }
                return l < r
            }
            .map { $0.food }
    }

    /// Mirrors rankFoodMatch() in src/pages/app.js. Buckets:
    /// 100 starts-with name, 80 word-boundary, 70 contains, 50 brand,
    /// 25 component name match.
    private func rank(_ food: FoodItemRow, _ q: String) -> Int {
        let name = food.name.lowercased()
        let brand = (food.brand ?? "").lowercased()
        if name.hasPrefix(q) { return 100 }
        // word-boundary check: q at start, or preceded by a non-alphanum char
        if let r = name.range(of: q) {
            let idx = r.lowerBound
            if idx == name.startIndex { return 100 }
            let prev = name[name.index(before: idx)]
            if !prev.isLetter && !prev.isNumber { return 80 }
            return 70
        }
        if brand.contains(q) { return 50 }
        if let comps = food.components,
           comps.contains(where: { ($0.name ?? "").lowercased().contains(q) }) {
            return 25
        }
        return 0
    }

    // MARK: - Quick log

    private func handleQuickLog(_ item: FoodItemRow) {
        let comps = item.components ?? []
        if comps.count > 1 {
            quickLogTarget = item
        } else {
            Task { await logAsOne(item) }
        }
    }

    private func logAsOne(_ item: FoodItemRow) async {
        do {
            // Pass foodItemId so logMeal's auto-save short-circuits —
            // this food is already in the library by definition.
            try await state.logMeal(
                name: item.name,
                calories: item.calories ?? 0,
                protein: item.protein ?? 0,
                carbs: item.carbs ?? 0,
                fat: item.fat ?? 0,
                fiber: item.fiber ?? 0,
                foodItemId: item.id
            )
            showToast("\(item.name) logged!")
        } catch {
            showToast("Error: \(error.localizedDescription)")
        }
    }

    private func logComponents(_ item: FoodItemRow) async {
        let comps = item.components ?? []
        var logged = 0
        for c in comps {
            do {
                // Component macros are already scaled to its `qty` (see
                // FoodComponent doc in Models.swift), so pass them through
                // unmodified and record `qty` as servings_consumed — matches
                // src/pages/app.js:12732 (the web source of truth).
                try await state.logMeal(
                    name: c.name ?? item.name,
                    calories: c.calories ?? 0,
                    protein: c.protein ?? 0,
                    carbs: c.carbs ?? 0,
                    fat: c.fat ?? 0,
                    fiber: c.fiber ?? 0,
                    foodItemId: item.id,
                    servingsConsumed: c.qty ?? 1
                )
                logged += 1
            } catch {
                // Continue logging the rest — partial success matches web.
                continue
            }
        }
        showToast("\(logged) component\(logged == 1 ? "" : "s") logged!")
    }

    private func showToast(_ msg: String) {
        toast = msg
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if toast == msg { toast = nil }
        }
    }
}
