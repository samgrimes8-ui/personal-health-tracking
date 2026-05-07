import SwiftUI

/// Aggregated grocery list for the visible week. Uses a per-week recipe
/// fetch (with ingredients jsonb) since the dashboard's RecipeRow projection
/// is name + macros only — the wider shape is local to this view to avoid
/// touching shared Models.swift.
///
/// Aggregation lives in GroceryAggregation.swift. This view owns the
/// recipe fetch, the smart-merge toggle, and the rendering. The smart-
/// merge toggle flips canonicalization on/off; without it, "red onion"
/// and "yellow onion" stay as separate rows. With it, they collapse to
/// a single "onion" row with summed amount.
struct GroceryListView: View {
    @Environment(AppState.self) private var state
    let weekStart: String

    @State private var recipesById: [String: GroceryRecipe] = [:]
    @State private var fetching = false
    @State private var loadErr: String?
    /// On by default — Smart merge button toggles canonicalization +
    /// the cross-dimension unit-merge pass off (rare, but useful when
    /// the user wants to see the raw per-recipe rows without combining).
    @State private var smartMergeApplied: Bool = true

    /// Custom items the user typed in (toilet paper, milk, etc) — not
    /// derived from any recipe. Persisted across app launches via
    /// @AppStorage, JSON-encoded so the array survives untouched.
    /// Mirrors state.groceryCustomItems on web.
    @AppStorage("grocery.customItemsJSON") private var customItemsJSON: String = "[]"
    @State private var customItems: [GroceryCustomItem] = []
    @FocusState private var focusedCustomItemId: String?

    /// Shopping date range. Both nil = auto: fromDate snaps to today
    /// (which gives the "Past days excluded" effect when the visible
    /// week has past days), toDate snaps to the end of the visible
    /// week. Once the user picks either date manually it stays sticky
    /// until they hit "Reset to today". Mirrors state.groceryFromDate /
    /// state.groceryToDate on web.
    @State private var fromDate: String? = nil
    @State private var toDate: String? = nil
    /// Meals fetched across the picked range when the range steps
    /// outside the visible week. nil = use plannerByDay (in-week range).
    @State private var rangeMealsRemote: [PlannerRow]? = nil
    @State private var fetchingRange: Bool = false

    /// Per-meal include/exclude overrides keyed by meal id. When the
    /// default rule (skip leftovers, include everything else) doesn't
    /// match the user's intent — e.g. they DO want to shop for an
    /// orphan leftover, or they DON'T want to shop for a particular
    /// meal because they already have the ingredients — flipping the
    /// per-meal toggle in the By-meal view writes here. Non-persisted;
    /// matches the web's session-scoped state.userMealOverrides.
    @State private var userMealOverrides: [String: String] = [:]

    /// Full categorized list (default) vs. by-meal grouping. By-meal
    /// renders one card per planned meal so the user can see exactly
    /// which recipe contributes which ingredients, and toggle a meal
    /// in/out of the aggregation.
    enum GroceryViewMode: String, CaseIterable, Identifiable {
        case full, byMeal
        var id: String { rawValue }
        var label: String {
            switch self {
            case .full: return "Full list"
            case .byMeal: return "By meal"
            }
        }
    }
    @State private var viewMode: GroceryViewMode = .full

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            dateRangeBar
            if !orphanLeftovers.isEmpty {
                orphanLeftoverBanner
            }
            viewModeTabs
            if fetching && recipesById.isEmpty {
                Card { ProgressView().frame(maxWidth: .infinity, alignment: .center) }
            } else if effectiveMeals.isEmpty && customItems.isEmpty {
                Card { EmptyState(icon: "cart", title: "No grocery list yet", message: "Add planned meals in this date range, or tap + Add item to add things by hand.") }
            } else if viewMode == .full && itemRows.isEmpty && customItems.isEmpty {
                Card { EmptyState(icon: "leaf", title: "No ingredients yet", message: "Save recipes with ingredients on them, then re-open this list.") }
            } else {
                Group {
                    switch viewMode {
                    case .full: listBody
                    case .byMeal: byMealBody
                    }
                }
            }
        }
        .task(id: weekStart) { await fetchRecipeIngredients() }
        .task(id: rangeKey) { await fetchRangeIfNeeded() }
        .onAppear { loadCustomItems() }
        .alert("Couldn't load grocery list", isPresented: Binding(
            get: { loadErr != nil },
            set: { if !$0 { loadErr = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(loadErr ?? "") }
    }

    /// Distinct key that triggers a range fetch when it changes —
    /// either bound dates or the visible week shifted under us.
    private var rangeKey: String {
        "\(weekStart)|\(fromDate ?? "auto")|\(toDate ?? "auto")"
    }

    // MARK: - Header / actions

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "cart.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Grocery list")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Text(rangeSummaryLabel)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }
                Spacer()
            }

            // Action buttons. Wrap so they reflow nicely on narrow widths.
            HStack(spacing: 8) {
                actionButton(label: "Copy", systemImage: "doc.on.doc", color: Theme.protein) {
                    copyToClipboard()
                }
                .disabled(itemRows.isEmpty && customItems.allSatisfy { $0.text.trimmingCharacters(in: .whitespaces).isEmpty })

                actionButton(
                    label: smartMergeApplied ? "Merged" : "Smart merge",
                    systemImage: "sparkles",
                    color: Theme.carbs,
                    filled: smartMergeApplied
                ) {
                    smartMergeApplied.toggle()
                }
                .disabled(itemRows.isEmpty)

                actionButton(
                    label: "Add item",
                    systemImage: "plus",
                    color: Theme.accent
                ) {
                    addCustomItem()
                }

                if !userMealOverrides.isEmpty {
                    actionButton(
                        label: "Reset",
                        systemImage: "arrow.uturn.backward",
                        color: Theme.text3
                    ) {
                        userMealOverrides = [:]
                    }
                }

                Spacer(minLength: 0)
            }
        }
    }

    private func actionButton(
        label: String,
        systemImage: String,
        color: Color,
        filled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: systemImage)
                Text(label)
            }
            .font(.system(size: 12, weight: .semibold))
            .padding(.vertical, 7).padding(.horizontal, 12)
            .foregroundStyle(filled ? Color.white : color)
            .background(filled ? color : color.opacity(0.10), in: .rect(cornerRadius: 999))
            .overlay(
                RoundedRectangle(cornerRadius: 999)
                    .stroke(color.opacity(filled ? 0.0 : 0.30), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Date range bar

    /// Two date pickers + an optional "✓ Past days excluded" badge and a
    /// "Reset to today" link when the user has overridden either picker.
    /// Mirrors the date-range bar in renderGroceryList (app.js:2526).
    private var dateRangeBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Shopping for:")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)

                DatePicker(
                    "",
                    selection: Binding(
                        get: { PlannerDateMath.parse(effectiveFromDate) ?? Date() },
                        set: { fromDate = PlannerDateMath.format($0) }
                    ),
                    displayedComponents: .date
                )
                .labelsHidden()
                .scaleEffect(0.9, anchor: .leading)
                .frame(maxWidth: 130)

                Text("→")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)

                DatePicker(
                    "",
                    selection: Binding(
                        get: { PlannerDateMath.parse(effectiveToDate) ?? Date() },
                        set: { toDate = PlannerDateMath.format($0) }
                    ),
                    displayedComponents: .date
                )
                .labelsHidden()
                .scaleEffect(0.9, anchor: .leading)
                .frame(maxWidth: 130)

                Spacer(minLength: 0)
            }
            HStack(spacing: 10) {
                if pastDaysExcluded {
                    Text("✓ Past days excluded")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.green)
                }
                if fromDate != nil || toDate != nil {
                    Button {
                        fromDate = nil
                        toDate = nil
                    } label: {
                        Text("Reset to today")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 0)
                if fetchingRange {
                    ProgressView().controlSize(.mini)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
    }

    // MARK: - View tabs

    private var viewModeTabs: some View {
        HStack(spacing: 6) {
            ForEach(GroceryViewMode.allCases) { mode in
                Button {
                    viewMode = mode
                } label: {
                    Text(mode.label)
                        .font(.system(size: 12, weight: .semibold))
                        .padding(.vertical, 6).padding(.horizontal, 14)
                        .foregroundStyle(viewMode == mode ? Theme.accentFG : Theme.text2)
                        .background(
                            viewMode == mode ? Theme.accent : Theme.bg3,
                            in: .rect(cornerRadius: 999)
                        )
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
            Text("\(includedMealCount) in list")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
        }
    }

    private var includedMealCount: Int {
        effectiveMeals.filter { isMealIncluded($0) }.count
    }

    private func isMealIncluded(_ meal: PlannerRow) -> Bool {
        if let v = userMealOverrides[meal.id] {
            if v == "include" { return true }
            if v == "exclude" { return false }
        }
        return !Self.isLeftover(meal)
    }

    private func toggleMealInclusion(_ meal: PlannerRow) {
        let included = isMealIncluded(meal)
        userMealOverrides[meal.id] = included ? "exclude" : "include"
    }

    // MARK: - Body

    private var listBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(GroceryCategory.order, id: \.self) { cat in
                if let rows = grouped[cat], !rows.isEmpty {
                    Card(padding: 0) {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 6) {
                                Text(cat.emoji)
                                Text(cat.label.uppercased())
                                    .font(.system(size: 11, weight: .semibold))
                                    .tracking(1.0)
                                Text("(\(rows.count))")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.text3)
                                Spacer()
                            }
                            .foregroundStyle(cat.color)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.bg3)

                            ForEach(rows) { row in
                                groceryRow(row, color: cat.color)
                                Divider().background(Theme.border)
                            }
                        }
                    }
                }
            }
            if !customItems.isEmpty {
                customItemsCard
            }
        }
    }

    // MARK: - By-meal view

    /// One card per planned meal, grouped by day. Lets the user see
    /// each recipe's ingredient set and flip individual meals in/out
    /// of the aggregation. Mirrors renderGroceryByMeal (app.js:2984).
    private var byMealBody: some View {
        let groups: [(day: String, meals: [PlannerRow])] = {
            var byDay: [String: [PlannerRow]] = [:]
            var dayOrder: [String] = []
            for meal in effectiveMeals.sorted(by: { ($0.actual_date ?? "") < ($1.actual_date ?? "") }) {
                let key = meal.actual_date ?? ""
                if byDay[key] == nil {
                    byDay[key] = []
                    dayOrder.append(key)
                }
                byDay[key]?.append(meal)
            }
            return dayOrder.map { ($0, byDay[$0] ?? []) }
        }()

        return VStack(alignment: .leading, spacing: 14) {
            if groups.isEmpty {
                Card { EmptyState(icon: "calendar", title: "Nothing planned in this range", message: "Add planned meals or widen the date range.") }
            }
            ForEach(groups, id: \.day) { group in
                VStack(alignment: .leading, spacing: 8) {
                    Text(dayLabel(for: group.day))
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.8)
                        .foregroundStyle(Theme.text2)
                    ForEach(group.meals) { meal in
                        mealCard(meal)
                    }
                }
            }
            if !customItems.isEmpty {
                customItemsCard
            }
        }
    }

    private func dayLabel(for day: String) -> String {
        guard let date = PlannerDateMath.parse(day) else { return day.uppercased() }
        let f = DateFormatter()
        f.calendar = PlannerDateMath.calendar
        f.timeZone = .current
        f.setLocalizedDateFormatFromTemplate("EEEE MMM d")
        return f.string(from: date).uppercased()
    }

    private func mealCard(_ meal: PlannerRow) -> some View {
        let mealName = meal.meal_name ?? ""
        let isLeft = Self.isLeftover(meal)
        let orphan = orphanLeftovers.contains(where: { $0.id == meal.id })
        let coveredLeftover = isLeft && !orphan
        let included = isMealIncluded(meal)
        let recipe = meal.recipe_id.flatMap { recipesById[$0] }
        let ingredients = recipe?.ingredients ?? []
        let baseServings = recipe?.servings ?? 1
        let plannedServings = meal.planned_servings ?? baseServings
        let multiplier = baseServings > 0 ? plannedServings / baseServings : 1

        return Card(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(mealName)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(included ? Theme.text : Theme.text2)
                            .lineLimit(2)
                        if coveredLeftover {
                            Text("↩ Leftovers from \(Self.originalMealName(meal)) — ingredients already on your list")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.text3)
                        } else if !ingredients.isEmpty {
                            Text("\(ingredients.count) ingredient\(ingredients.count == 1 ? "" : "s")")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.text3)
                        }
                    }
                    Spacer(minLength: 8)
                    if orphan {
                        Text("orphan leftover")
                            .font(.system(size: 10, weight: .medium))
                            .padding(.vertical, 3).padding(.horizontal, 8)
                            .foregroundStyle(Theme.fat)
                            .background(Theme.fat.opacity(0.10), in: .rect(cornerRadius: 999))
                            .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.fat.opacity(0.30), lineWidth: 1))
                    }
                    inclusionToggleButton(meal: meal, included: included)
                }
                .padding(.horizontal, 14).padding(.vertical, 10)

                if orphan && !included {
                    Text("Source cook is outside your shopping window. Add to list if you'll cook this fresh.")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .padding(.horizontal, 14).padding(.bottom, 8)
                }

                if !coveredLeftover, included, !ingredients.isEmpty {
                    Divider().background(Theme.border)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(ingredients.enumerated()), id: \.offset) { idx, ing in
                            ingredientRow(ing, multiplier: multiplier)
                            if idx < ingredients.count - 1 {
                                Divider().background(Theme.border)
                            }
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                }
            }
        }
        .opacity(included || orphan ? 1.0 : 0.6)
    }

    private func inclusionToggleButton(meal: PlannerRow, included: Bool) -> some View {
        Button {
            toggleMealInclusion(meal)
        } label: {
            HStack(spacing: 3) {
                Image(systemName: included ? "checkmark" : "plus")
                    .font(.system(size: 10, weight: .semibold))
                Text(included ? "In list" : "Add to list")
                    .font(.system(size: 11, weight: .semibold))
            }
            .padding(.vertical, 5).padding(.horizontal, 10)
            .foregroundStyle(included ? Theme.green : Theme.text3)
            .background(included ? Theme.green.opacity(0.12) : Theme.bg3, in: .rect(cornerRadius: 999))
            .overlay(
                RoundedRectangle(cornerRadius: 999)
                    .stroke(included ? Theme.green.opacity(0.30) : Theme.border2, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func ingredientRow(_ ing: RecipeIngredient, multiplier: Double) -> some View {
        let amount = ing.amountValue * multiplier
        let amountStr: String = amount > 0
            ? (amount == amount.rounded() ? String(Int(amount)) : String(format: "%.2f", amount))
            : "—"
        let unit = ing.unit ?? ""
        let cat = GroceryCategory.resolve(rawCategory: ing.category, name: ing.name)
        return HStack(alignment: .top, spacing: 8) {
            HStack(spacing: 3) {
                Text(cat.emoji)
                Text(cat.label)
                    .font(.system(size: 10, weight: .medium))
            }
            .foregroundStyle(cat.color)
            .padding(.vertical, 2).padding(.horizontal, 6)
            .background(cat.color.opacity(0.10), in: .rect(cornerRadius: 4))
            .frame(minWidth: 70, alignment: .leading)

            Text(unit.isEmpty ? amountStr : "\(amountStr) \(unit)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.text2)
                .frame(minWidth: 70, alignment: .leading)

            Text(ing.name)
                .font(.system(size: 13))
                .foregroundStyle(Theme.text)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private var customItemsCard: some View {
        Card(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Text("📝")
                    Text("CUSTOM ITEMS")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1.0)
                    Text("(\(customItems.count))")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                    Spacer()
                }
                .foregroundStyle(Theme.text2)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.bg3)

                ForEach($customItems) { $item in
                    HStack(spacing: 10) {
                        TextField("Type an item…", text: $item.text)
                            .textFieldStyle(.plain)
                            .focused($focusedCustomItemId, equals: item.id)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.text)
                            .onSubmit { saveCustomItems() }
                            .onChange(of: item.text) { _, _ in saveCustomItems() }
                        Button {
                            removeCustomItem(id: item.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 18))
                                .foregroundStyle(Theme.text3)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    Divider().background(Theme.border)
                }
            }
        }
    }

    private func groceryRow(_ row: GroceryItem, color: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(row.amountLabel)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 80, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name.capitalized)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.text)
                if !row.meals.isEmpty {
                    Text(row.meals.joined(separator: ", "))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    // MARK: - Aggregation pipeline

    /// Effective `from` for the picked range — user override OR today
    /// (auto). Today is used so that on first open, past days that
    /// have already been cooked drop off the shopping list.
    private var effectiveFromDate: String {
        fromDate ?? PlannerDateMath.todayString()
    }

    /// Effective `to` for the picked range — user override OR end of
    /// the visible week (auto). Web defaults to "end of furthest
    /// planned week" but iOS only loads the visible week into
    /// plannerByDay; this keeps the auto behavior matched to what's
    /// actually loaded without an extra fetch on first open.
    private var effectiveToDate: String {
        toDate ?? PlannerDateMath.addDays(weekStart, 6)
    }

    private var isAutoFrom: Bool { fromDate == nil }
    private var isAutoTo: Bool { toDate == nil }

    /// "3 meals · May 7 – May 13" style summary shown under the title.
    private var rangeSummaryLabel: String {
        let count = effectiveMeals.count
        let mealsLabel = count == 1 ? "1 meal" : "\(count) meals"
        return "\(mealsLabel) · \(PlannerDateMath.shortMonthDay(effectiveFromDate)) – \(PlannerDateMath.shortMonthDay(effectiveToDate))"
    }

    /// "Past days excluded" applies when the user hasn't overridden
    /// fromDate AND today actually falls past the visible week's start
    /// — i.e. there are days in the visible week that already happened.
    private var pastDaysExcluded: Bool {
        isAutoFrom && PlannerDateMath.todayString() > weekStart
    }

    /// Meals in the current shopping window. When the range is fully
    /// inside the visible week we filter plannerByDay (no extra
    /// fetch); otherwise we use the cross-week fetched list.
    private var effectiveMeals: [PlannerRow] {
        let from = effectiveFromDate
        let to = effectiveToDate
        let weekEnd = PlannerDateMath.addDays(weekStart, 6)
        if from >= weekStart && to <= weekEnd {
            return state.plannerByDay.flatMap { $0 }.filter {
                guard let d = $0.actual_date else { return false }
                return d >= from && d <= to
            }
        }
        return rangeMealsRemote ?? []
    }

    /// Aggregated rows. Skips leftovers by default (mirrors the
    /// `isMealIncludedInGroceries` default in app.js — leftovers reuse
    /// a previous cook and don't add to the grocery list).
    private var itemRows: [GroceryItem] {
        let inputs = effectiveMeals.map { row -> GroceryAggregator.PlannedMealInput in
            GroceryAggregator.PlannedMealInput(
                mealId: row.id,
                mealLabel: row.meal_name ?? recipesById[row.recipe_id ?? ""]?.name ?? "",
                recipeId: row.recipe_id,
                plannedServings: row.planned_servings,
                isLeftover: row.is_leftover ?? false
            )
        }
        let recipes = recipesById.mapValues { r -> GroceryAggregator.RecipeInput in
            GroceryAggregator.RecipeInput(
                id: r.id,
                name: r.name,
                servings: r.servings,
                ingredients: (r.ingredients ?? []).map { ing in
                    GroceryAggregator.IngredientInput(
                        name: ing.name,
                        amount: ing.amountValue,
                        unit: ing.unit ?? "",
                        category: GroceryCategory.resolve(rawCategory: ing.category, name: ing.name)
                    )
                }
            )
        }
        // Capture overrides so the closure stays a pure function of
        // its inputs (the closure can't read `self` after the call).
        let overrides = userMealOverrides
        return GroceryAggregator.aggregate(
            meals: inputs,
            recipesById: recipes,
            includeMeal: { meal in
                if let v = overrides[meal.mealId] {
                    if v == "include" { return true }
                    if v == "exclude" { return false }
                }
                return !meal.isLeftover
            },
            applyCanonicalization: smartMergeApplied
        )
    }

    // MARK: - Leftover detection

    /// Detect "orphaned" leftovers: leftover meals in the shopping
    /// window whose source cook (the non-leftover instance of the same
    /// recipe) lands OUTSIDE the window. If the source cook is in the
    /// window, the user is already shopping for the ingredients —
    /// nothing to warn about. If it isn't, the leftover effectively
    /// becomes a fresh cook the user has to shop for, and we surface a
    /// banner pointing at it. Mirrors findLeftoverSource (app.js:2603).
    private struct OrphanLeftover: Identifiable {
        let leftover: PlannerRow
        let source: PlannerRow?
        var id: String { leftover.id }
    }

    private var orphanLeftovers: [OrphanLeftover] {
        let inRange = effectiveMeals
        let broader = state.plannerByDay.flatMap { $0 }
        return inRange
            .filter { Self.isLeftover($0) }
            .map { lo -> OrphanLeftover in
                let recipeId = lo.recipe_id
                let nameKey = Self.originalMealName(lo).lowercased()
                let loDate = lo.actual_date

                // Prefer an in-range source — the user is already
                // buying ingredients for it.
                let inRangeSource = inRange.first { m in
                    if m.id == lo.id { return false }
                    if Self.isLeftover(m) { return false }
                    if let rid = recipeId, m.recipe_id == rid {
                        // empty body — id match is enough
                    } else if recipeId == nil,
                              (m.meal_name ?? "").lowercased() == nameKey {
                        // empty body — name match is enough
                    } else {
                        return false
                    }
                    // Source must be on or before the leftover.
                    if let lod = loDate, let md = m.actual_date {
                        return md <= lod
                    }
                    return true
                }
                if let s = inRangeSource {
                    return OrphanLeftover(leftover: lo, source: s)
                }
                // Fallback: peek at the broader visible-week pool so
                // the warning text can say where the source lives.
                let broadSource = broader.first { m in
                    if m.id == lo.id { return false }
                    if Self.isLeftover(m) { return false }
                    if let rid = recipeId, m.recipe_id == rid { return true }
                    if recipeId == nil,
                       (m.meal_name ?? "").lowercased() == nameKey { return true }
                    return false
                }
                return OrphanLeftover(leftover: lo, source: broadSource)
            }
            .filter { item in
                // An OrphanLeftover with an in-range source isn't an
                // orphan — only items whose source missed the window
                // (or doesn't exist at all) get surfaced.
                guard let s = item.source else { return true }
                return !inRange.contains(where: { $0.id == s.id })
            }
    }

    private static func isLeftover(_ meal: PlannerRow) -> Bool {
        if meal.is_leftover == true { return true }
        let name = (meal.meal_name ?? "").lowercased()
        return name.hasSuffix("(leftovers)")
    }

    private static func originalMealName(_ meal: PlannerRow) -> String {
        let name = meal.meal_name ?? ""
        return name.replacingOccurrences(
            of: "\\s*\\(leftovers\\)\\s*$",
            with: "",
            options: [.regularExpression, .caseInsensitive]
        ).trimmingCharacters(in: .whitespaces)
    }

    /// Yellow warning banner listing up to 5 orphan leftovers. Tells
    /// the user their leftover meal's source cook is outside the
    /// shopping window and they need to flip "Add to list" if they
    /// want to actually shop for it.
    private var orphanLeftoverBanner: some View {
        let count = orphanLeftovers.count
        let pluralL = count == 1 ? "" : "s"
        let allHaveSource = orphanLeftovers.allSatisfy { $0.source != nil }
        let detail = allHaveSource
            ? "These meals are planned as leftovers, but their source cook happens before this window."
            : "These meals are planned as leftovers, but their source cook isn't in your planner."
        return HStack(alignment: .top, spacing: 10) {
            Text("⚠️")
                .font(.system(size: 18))
            VStack(alignment: .leading, spacing: 6) {
                Text("\(count) leftover\(pluralL) without a cook in your shopping window")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text("\(detail) They're not in your shopping list — toggle \"Add to list\" on the meal in the By-meal tab if you need to shop for them.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text2)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(orphanLeftovers.prefix(5)) { item in
                    HStack(spacing: 4) {
                        Text(Self.originalMealName(item.leftover))
                            .foregroundStyle(Theme.text2)
                        if let d = item.leftover.actual_date {
                            Text("on \(PlannerDateMath.shortMonthDay(d))")
                                .foregroundStyle(Theme.text3)
                        }
                        if let src = item.source, let sd = src.actual_date {
                            Text("· source was \(PlannerDateMath.shortMonthDay(sd))")
                                .foregroundStyle(Theme.text3)
                        }
                    }
                    .font(.system(size: 11))
                }
                if count > 5 {
                    Text("+ \(count - 5) more")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.fat.opacity(0.10), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.fat.opacity(0.30), lineWidth: 1))
    }

    /// `itemRows` grouped by category for rendering.
    private var grouped: [GroceryCategory: [GroceryItem]] {
        Dictionary(grouping: itemRows) { $0.category }
    }

    // MARK: - Recipe fetch

    private func fetchRecipeIngredients() async {
        let inWeek = state.plannerByDay.flatMap { $0 }.compactMap { $0.recipe_id }
        let inRange = (rangeMealsRemote ?? []).compactMap { $0.recipe_id }
        let ids = Set(inWeek + inRange)
        guard !ids.isEmpty else {
            recipesById = [:]
            return
        }
        // Skip if we already have all of them.
        if ids.allSatisfy({ recipesById[$0] != nil }) { return }

        fetching = true
        defer { fetching = false }
        do {
            let userId = try await SupabaseService.client.auth.session.user.id.uuidString
            let rows: [GroceryRecipe] = try await SupabaseService.client
                .from("recipes")
                .select("id, name, servings, ingredients")
                .eq("user_id", value: userId)
                .in("id", values: Array(ids))
                .execute()
                .value
            var next: [String: GroceryRecipe] = [:]
            for r in rows { next[r.id] = r }
            recipesById = next
        } catch {
            loadErr = error.localizedDescription
        }
    }

    /// Cross-week meal fetch. Mirrors getPlannerRange in src/lib/db.js:
    /// 1) compute every Sunday-week_start that overlaps [from, to];
    /// 2) pull rows where week_start_date IN those weeks;
    /// 3) filter to actual_date within [from, to] (the actual_date
    ///    column is authoritative; older rows compute from
    ///    week_start_date + day_of_week).
    /// No-op when the range fits inside the visible week — that case
    /// uses plannerByDay directly.
    private func fetchRangeIfNeeded() async {
        let from = effectiveFromDate
        let to = effectiveToDate
        let weekEnd = PlannerDateMath.addDays(weekStart, 6)
        if from >= weekStart && to <= weekEnd {
            // In-week — let plannerByDay drive the list. Drop any
            // stale remote fetch so memory doesn't grow unbounded
            // when the user toggles between ranges.
            rangeMealsRemote = nil
            return
        }
        guard from <= to else { rangeMealsRemote = []; return }

        fetchingRange = true
        defer { fetchingRange = false }
        do {
            let userId = try await SupabaseService.client.auth.session.user.id.uuidString
            let weekStarts = enumerateWeekStarts(from: from, to: to)
            let rows: [PlannerRow] = try await SupabaseService.client
                .from("meal_planner")
                .select()
                .eq("user_id", value: userId)
                .in("week_start_date", values: weekStarts)
                .order("day_of_week", ascending: true)
                .execute()
                .value
            // Filter to days within the picked range. Prefer actual_date
            // when present; otherwise compute it from week_start +
            // day_of_week so older rows still flow through.
            let inRange = rows.filter { row in
                let d = row.actual_date ?? computedDate(for: row)
                guard let day = d else { return false }
                return day >= from && day <= to
            }
            rangeMealsRemote = inRange
            // The recipes fetch is keyed off the visible-week ids, so
            // when range exits the week we may need extra recipes —
            // re-run the fetch.
            await fetchRecipeIngredients()
        } catch {
            loadErr = error.localizedDescription
        }
    }

    private func enumerateWeekStarts(from: String, to: String) -> [String] {
        guard let fromDate = PlannerDateMath.parse(from),
              let toDate = PlannerDateMath.parse(to) else { return [] }
        // Snap fromDate to its Sunday — meal_planner.week_start_date is
        // always a Sunday, so we walk Sundays from that anchor forward.
        let cal = PlannerDateMath.calendar
        let weekday = cal.component(.weekday, from: fromDate)
        let offset = -(weekday - 1)
        guard let firstSunday = cal.date(byAdding: .day, value: offset, to: fromDate) else { return [] }
        var weeks: [String] = []
        var cursor = firstSunday
        while cursor <= toDate {
            weeks.append(PlannerDateMath.format(cursor))
            guard let next = cal.date(byAdding: .day, value: 7, to: cursor) else { break }
            cursor = next
        }
        return weeks
    }

    private func computedDate(for row: PlannerRow) -> String? {
        guard let weekStart = row.week_start_date,
              let dow = row.day_of_week else { return nil }
        return PlannerDateMath.addDays(weekStart, dow)
    }

    // MARK: - Custom items

    /// Decode persisted custom items on first appearance. Failures fall
    /// back to an empty list — a corrupted JSON blob shouldn't keep the
    /// user out of the grocery list. (The next saveCustomItems will
    /// overwrite the bad value with a clean encoding.)
    private func loadCustomItems() {
        guard let data = customItemsJSON.data(using: .utf8) else { return }
        if let decoded = try? JSONDecoder().decode([GroceryCustomItem].self, from: data) {
            customItems = decoded
        }
    }

    private func saveCustomItems() {
        if let data = try? JSONEncoder().encode(customItems),
           let str = String(data: data, encoding: .utf8) {
            customItemsJSON = str
        }
    }

    private func addCustomItem() {
        let item = GroceryCustomItem(id: UUID().uuidString, text: "")
        customItems.append(item)
        saveCustomItems()
        // Pop focus into the new field so the user can type immediately.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            focusedCustomItemId = item.id
        }
    }

    private func removeCustomItem(id: String) {
        customItems.removeAll { $0.id == id }
        saveCustomItems()
    }

    // MARK: - Clipboard

    private func copyToClipboard() {
        var lines: [String] = []
        lines.append("Grocery list — \(PlannerDateMath.weekLabel(weekStart))")
        for cat in GroceryCategory.order {
            guard let rows = grouped[cat], !rows.isEmpty else { continue }
            lines.append("")
            lines.append("\(cat.emoji) \(cat.label)")
            for r in rows {
                lines.append("  • \(r.amountLabel) \(r.name)")
            }
        }
        let nonEmptyCustom = customItems.filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
        if !nonEmptyCustom.isEmpty {
            lines.append("")
            lines.append("📝 Custom items")
            for c in nonEmptyCustom {
                lines.append("  • \(c.text)")
            }
        }
#if canImport(UIKit)
        UIPasteboard.general.string = lines.joined(separator: "\n")
#endif
    }
}

/// Persisted custom-item row. `id` lets SwiftUI's ForEach track rows
/// across re-renders so editing one field doesn't dismiss focus on
/// another. Codable so we can JSON-encode for @AppStorage.
struct GroceryCustomItem: Identifiable, Codable, Hashable {
    var id: String
    var text: String
}

// MARK: - Local fetch shapes

/// Minimal recipe shape with ingredients jsonb. Local to the planner
/// because the shared RecipeRow only carries name + macros — adding
/// ingredients there would touch Models.swift. `RecipeIngredient` (in
/// Recipes/RecipeFull.swift) handles the polymorphic amount column the
/// recipes table actually stores (string or number).
private struct GroceryRecipe: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var servings: Double?
    var ingredients: [RecipeIngredient]?
}

// MARK: - Categories

enum GroceryCategory: String, Hashable, CaseIterable {
    case produce, protein, dairy, grains, pantry, spices, frozen, bakery, beverages, other

    static let order: [GroceryCategory] = [
        .produce, .protein, .dairy, .grains, .pantry, .spices, .frozen, .bakery, .beverages, .other
    ]

    var label: String {
        switch self {
        case .produce: return "Produce"
        case .protein: return "Protein"
        case .dairy: return "Dairy"
        case .grains: return "Grains"
        case .pantry: return "Pantry"
        case .spices: return "Spices"
        case .frozen: return "Frozen"
        case .bakery: return "Bakery"
        case .beverages: return "Beverages"
        case .other: return "Other"
        }
    }

    var emoji: String {
        switch self {
        case .produce: return "🥦"
        case .protein: return "🥩"
        case .dairy: return "🧀"
        case .grains: return "🌾"
        case .pantry: return "🥫"
        case .spices: return "🧂"
        case .frozen: return "🧊"
        case .bakery: return "🍞"
        case .beverages: return "🧃"
        case .other: return "📦"
        }
    }

    var color: Color {
        switch self {
        case .produce: return Theme.protein
        case .protein: return Theme.fat
        case .dairy: return Theme.carbs
        case .grains: return Theme.cal
        case .pantry: return Theme.text2
        case .spices: return Theme.fiber
        case .frozen: return Theme.carbs
        case .bakery: return Theme.fat
        case .beverages: return Theme.text2
        case .other: return Theme.text3
        }
    }

    /// Best-guess category for an ingredient. Trusts the AI value when
    /// it parses; otherwise falls back to keyword matching so the list
    /// doesn't collapse into "Other" when the model omits the field.
    static func resolve(rawCategory: String?, name: String) -> GroceryCategory {
        if let raw = rawCategory?.lowercased(), let cat = GroceryCategory(rawValue: raw) {
            return cat
        }
        return inferByKeyword(name) ?? .other
    }

    private static let keywords: [(GroceryCategory, [String])] = [
        (.produce,   ["lettuce","spinach","tomato","onion","pepper","carrot","celery","cucumber","potato","garlic","ginger","kale","arugula","broccoli","cauliflower","zucchini","squash","mushroom","apple","banana","berry","strawberry","blueberry","raspberry","lemon","lime","orange","avocado","cilantro","parsley","basil","thyme","rosemary","mint","scallion"]),
        (.protein,   ["chicken","beef","pork","turkey","lamb","salmon","tuna","shrimp","fish","bacon","sausage","tofu","tempeh","egg","ground"]),
        (.dairy,     ["milk","yogurt","cheese","butter","cream","cottage","mozzarella","feta","parmesan","cheddar","kefir","greek yogurt"]),
        (.grains,    ["rice","quinoa","oat","oatmeal","barley","pasta","spaghetti","penne","noodle","couscous","tortilla","bread","wrap"]),
        (.pantry,    ["oil","olive oil","vinegar","sauce","mustard","mayo","ketchup","soy sauce","honey","sugar","syrup","peanut butter","almond butter","tahini","stock","broth","bean","lentil","chickpea","tomato paste","canned"]),
        (.spices,    ["salt","pepper","paprika","cumin","coriander","cinnamon","turmeric","oregano","chili","cayenne","garlic powder","onion powder","nutmeg","clove","sage","bay"]),
        (.frozen,    ["frozen"]),
        (.bakery,    ["baguette","bagel","roll","muffin","croissant","pita"]),
        (.beverages, ["coffee","tea","juice","soda","sparkling","milk alternative"]),
    ]

    private static func inferByKeyword(_ name: String) -> GroceryCategory? {
        let n = name.lowercased()
        for (cat, words) in keywords {
            if words.contains(where: { n.contains($0) }) { return cat }
        }
        return nil
    }
}
