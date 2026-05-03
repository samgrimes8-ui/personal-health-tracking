import SwiftUI

/// Native dashboard. v1 ships with the two highest-signal sections —
/// Daily macro counts and Today's meals. Quick log, Analyze food, charts
/// and the analytics widget come in subsequent passes; layout matches the
/// post-reorder web dashboard so users see the same flow.
struct DashboardView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(AppState.self) private var state
    @State private var editingEntry: MealLogEntry?
    /// Set while a planned-meal toggle is in flight so a fast double-tap
    /// can't fire two inserts before the first round-trip resolves.
    /// Cleared in defer regardless of success/failure.
    @State private var togglingPlannerId: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                greeting
                AnalyzeFoodSection()
                QuickLogSection()
                macroCountsRow
                todayMealsCard
                MacroBreakdownSection()
                AnalyticsSection()
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        // Tap-outside-to-dismiss for the Quick Log search and Analyze
        // describe-food fields. Bare tap registers on empty space only,
        // so it doesn't fight TextField/TextEditor for hits inside them
        // — and it pairs with the keyboard's "Done" button so users
        // always have an obvious way out of the input.
        .onTapGesture {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder),
                to: nil, from: nil, for: nil
            )
        }
        .refreshable { await state.loadDashboard() }
        .task { await state.loadDashboard() }
        .sheet(item: $editingEntry) { entry in
            MealLogEditor(mode: .edit(entry))
                .environment(state)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Sign out") { Task { await auth.signOut() } }
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text3)
            }
        }
        .navigationTitle("MacroLens")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Sections

    private var greeting: some View {
        let h = Calendar.current.component(.hour, from: Date())
        let salutation = h < 12 ? "Good morning." : h < 17 ? "Good afternoon." : "Good evening."
        return VStack(alignment: .leading, spacing: 4) {
            Text(salutation)
                .font(.system(size: 26, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
            Text("Log your meals and track your macros.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
        }
        .padding(.top, 12)
    }

    private var macroCountsRow: some View {
        let totals = DailyMacroTotals.sum(state.todayLog)
        return VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Daily macro counts")
            HStack(spacing: 10) {
                macroTile(label: "Calories", value: Int(totals.calories), unit: "kcal", goal: state.goals.calories, color: Theme.cal)
                macroTile(label: "Protein", value: Int(totals.protein), unit: "g", goal: state.goals.protein, color: Theme.protein)
                macroTile(label: "Carbs", value: Int(totals.carbs), unit: "g", goal: state.goals.carbs, color: Theme.carbs)
                macroTile(label: "Fat", value: Int(totals.fat), unit: "g", goal: state.goals.fat, color: Theme.fat)
            }
        }
    }

    private var todayMealsCard: some View {
        // Match the web dashboard: bucket today's entries into the four
        // canonical meal types, render only sections that have logs, and
        // show a small per-section macro tally next to the section title.
        // Entries arrive newest-first (loadDashboard sorts by logged_at
        // desc); we re-sort each bucket oldest-first so the day reads
        // chronologically inside each section.
        //
        // Planned meals from meal_planner.actual_date == selectedDate get
        // rendered as check-off placeholders ABOVE the consumed rows in
        // each meal_type section — same layout the web's renderTodayMeals
        // uses (src/pages/app.js). The "consumed" state is computed by
        // name-matching the planned row against today's meal_log; web has
        // no consumed_at column and we mirror that 1:1 so the two stay
        // consistent.
        let buckets = Self.bucketByMealType(state.todayLog)
        let plannedBuckets = Self.bucketPlannedByMealType(state.todayPlanned)
        let active = Self.mealTypeOrder.filter {
            !(buckets[$0]?.isEmpty ?? true) || !(plannedBuckets[$0]?.isEmpty ?? true)
        }
        let isToday = Calendar.current.isDateInToday(state.selectedDate)
        // Lowercased meal_log names — drives the planned-row strikethrough.
        // Recomputed per render because state.todayLog is @Observable.
        let consumedNames: Set<String> = Set(
            state.todayLog.compactMap { $0.name?.lowercased() }
        )

        return VStack(alignment: .leading, spacing: 0) {
            // Date-nav header. Chevron-left walks one day backward;
            // chevron-right walks forward (clamped to today — there's
            // no use case for logging into the future, and the macros
            // dashboard doesn't anticipate future days).
            HStack(spacing: 8) {
                Button {
                    Task { await shiftDay(by: -1) }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.text2)
                        .frame(width: 28, height: 28)
                        .background(Theme.bg3, in: .rect(cornerRadius: 8))
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 0) {
                    Text(headerLabel)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.text)
                    if !isToday {
                        Text(Self.absoluteDateLabel(state.selectedDate))
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                    }
                }

                Spacer()

                if !isToday {
                    Button {
                        Task { await state.setSelectedDate(Date()) }
                    } label: {
                        Text("Today")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.accentFG)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Theme.accent, in: .rect(cornerRadius: 999))
                    }
                    .buttonStyle(.plain)
                }

                Button {
                    Task { await shiftDay(by: 1) }
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(isToday ? Theme.text3 : Theme.text2)
                        .frame(width: 28, height: 28)
                        .background(Theme.bg3, in: .rect(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(isToday)
                .opacity(isToday ? 0.4 : 1)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)

            Divider().background(Theme.border)

            if active.isEmpty {
                Text(isToday
                     ? "No entries yet. Analyze a meal to get started."
                     : "Nothing logged on this day. Use the search or Analyze section above to log retroactively.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 40)
                    .multilineTextAlignment(.center)
            } else {
                ForEach(active, id: \.self) { mealType in
                    let entries = (buckets[mealType] ?? []).sorted {
                        ($0.logged_at ?? "") < ($1.logged_at ?? "")
                    }
                    let plans = plannedBuckets[mealType] ?? []
                    mealTypeSectionHeader(mealType, entries: entries)
                    // Planned rows first — they're placeholders the user
                    // hasn't acted on yet, so they read as a to-do above
                    // the actual log entries. Web does the same ordering.
                    ForEach(plans) { plan in
                        plannedRow(plan, isConsumed: consumedNames.contains(
                            (plan.meal_name ?? "").lowercased()
                        ))
                        Divider().background(Theme.border).padding(.leading, 20)
                    }
                    ForEach(entries) { entry in
                        mealRow(entry)
                        Divider().background(Theme.border).padding(.leading, 20)
                    }
                }
            }
        }
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
    }

    /// Shift `state.selectedDate` by `delta` days. Forward shift past
    /// today is clamped — the chevron also disables in that case but
    /// keep the guard here too in case a swipe gesture is wired in
    /// later.
    private func shiftDay(by delta: Int) async {
        let cal = Calendar.current
        guard let next = cal.date(byAdding: .day, value: delta, to: state.selectedDate) else { return }
        let snapped = cal.startOfDay(for: next)
        let today = cal.startOfDay(for: Date())
        if snapped > today { return }
        await state.setSelectedDate(snapped)
    }

    private var headerLabel: String {
        let cal = Calendar.current
        if cal.isDateInToday(state.selectedDate) { return "Today's meals" }
        if cal.isDateInYesterday(state.selectedDate) { return "Yesterday's meals" }
        let f = DateFormatter()
        f.dateFormat = "EEEE"
        f.timeZone = .current
        return "\(f.string(from: state.selectedDate))'s meals"
    }

    private static func absoluteDateLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.timeZone = .current
        // "Apr 30" / "May 1" — no year (the dashboard isn't a time
        // machine and the chevron walks day-by-day, so the year is
        // self-evident from the user's recent path).
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f.string(from: date)
    }

    private func mealTypeSectionHeader(_ mealType: String, entries: [MealLogEntry]) -> some View {
        let totals = DailyMacroTotals.sum(entries)
        let label = mealType.capitalized
        let icon = Self.mealTypeIcon[mealType] ?? ""
        return HStack {
            Text("\(icon) \(label)")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text2)
            Spacer()
            HStack(spacing: 6) {
                Text("\(Int(totals.calories)) kcal")
                    .foregroundStyle(Theme.cal)
                Text("P\(Int(totals.protein))")
                    .foregroundStyle(Theme.protein)
                Text("C\(Int(totals.carbs))")
                    .foregroundStyle(Theme.carbs)
                Text("F\(Int(totals.fat))")
                    .foregroundStyle(Theme.fat)
            }
            .font(.system(size: 10, weight: .medium))
        }
        .padding(.horizontal, 20).padding(.vertical, 8)
        .background(Theme.bg3)
    }

    /// Canonical render order for the four meal_type buckets.
    private static let mealTypeOrder = ["breakfast", "lunch", "snack", "dinner"]
    /// Lowercase meal_type → header emoji. Matches the web's
    /// MEAL_TYPE_ICONS map in src/pages/app.js.
    private static let mealTypeIcon: [String: String] = [
        "breakfast": "🌅", "lunch": "☀️", "snack": "🍎", "dinner": "🌙"
    ]
    /// Group meal_log entries by meal_type. Entries with a missing or
    /// unrecognized meal_type get bucketed by their logged_at hour using
    /// the same windows the web uses (`getMealTypeFromTime` in app.js).
    /// Pre-existing rows from before the auto-assign fix in logMeal go
    /// through this fallback path.
    private static func bucketByMealType(_ entries: [MealLogEntry]) -> [String: [MealLogEntry]] {
        var out: [String: [MealLogEntry]] = [:]
        for e in entries {
            let key = normalizedMealType(e)
            out[key, default: []].append(e)
        }
        return out
    }

    /// Bucket planned meal_planner rows by meal_type, mirroring the same
    /// fallback chain bucketByMealType uses for meal_log: prefer the
    /// row's own meal_type, otherwise position-fallback so an unlabeled
    /// planner row still lands somewhere sensible. Web does the same
    /// (renderTodayMeals: `m.meal_type || MEAL_TYPES[Math.min(i, len-1)]`).
    private static func bucketPlannedByMealType(_ rows: [PlannerRow]) -> [String: [PlannerRow]] {
        var out: [String: [PlannerRow]] = [:]
        for (i, row) in rows.enumerated() {
            let key: String = {
                if let raw = row.meal_type?.lowercased(),
                   mealTypeOrder.contains(raw) {
                    return raw
                }
                return mealTypeOrder[min(i, mealTypeOrder.count - 1)]
            }()
            out[key, default: []].append(row)
        }
        return out
    }

    private static func normalizedMealType(_ entry: MealLogEntry) -> String {
        if let raw = entry.meal_type?.lowercased(),
           mealTypeOrder.contains(raw) {
            return raw
        }
        if let iso = entry.logged_at,
           let date = AppState.parseISOTimestamp(iso) {
            return AppState.inferMealType(at: date)
        }
        return "snack"
    }

    // MARK: - Helpers

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 13, weight: .medium))
            .tracking(1.0)
            .textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private func macroTile(label: String, value: Int, unit: String, goal: Int?, color: Color) -> some View {
        // Fixed font sizes (no minimumScaleFactor) so all four cards render
        // at the same visual weight — sized to fit the worst-case strings
        // ("CALORIES" / "1,110" / "of 2,616 kcal") inside an iPhone-12-width
        // card without wrapping. Subline keeps a defensive scale factor
        // because "of 2,616 kcal" vs "of 32g" is too wide a variance to
        // absorb at a single fixed size.
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .tracking(0.5)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
                .lineLimit(1)
            Text("\(value)\(unit == "g" ? "g" : "")")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(color)
                .lineLimit(1)
            if let goal {
                Text("of \(goal)\(unit == "g" ? "g" : "") \(unit == "kcal" ? "kcal" : "")")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            } else {
                Text("Set a goal")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    /// Planned-meal placeholder row. Visually distinct from a logged
    /// meal row: a circular checkbox on the left (filled green w/ a
    /// checkmark when name-matched against today's meal_log), lighter
    /// secondary text, and a "Planned · X kcal" subline so the user
    /// understands these calories don't count against the macro tiles
    /// until they tap to consume. Tapping toggles via
    /// AppState.togglePlannedMeal — insert when unconsumed, delete when
    /// consumed.
    private func plannedRow(_ plan: PlannerRow, isConsumed: Bool) -> some View {
        let mealName = plan.meal_name ?? "—"
        let inFlight = togglingPlannerId == plan.id
        return Button {
            Task { await togglePlanned(plan) }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                ZStack {
                    Circle()
                        .stroke(isConsumed ? Theme.protein : Theme.border2, lineWidth: 2)
                        .frame(width: 20, height: 20)
                    if isConsumed {
                        Circle()
                            .fill(Theme.protein)
                            .frame(width: 20, height: 20)
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(mealName)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(isConsumed ? Theme.text3 : Theme.text2)
                        .strikethrough(isConsumed, color: Theme.text3)
                        .multilineTextAlignment(.leading)
                    Text("Planned · \(Int(plan.calories ?? 0)) kcal")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
                Spacer()
                if inFlight {
                    ProgressView().scaleEffect(0.7)
                } else {
                    Text(isConsumed ? "Tap to unlog" : "Log it →")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .opacity(isConsumed ? 0.55 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(inFlight)
    }

    /// Wraps state.togglePlannedMeal in the in-flight gate + a refresh
    /// of the visible day's planner slice so a deletion (unlog) doesn't
    /// leave the row's checkbox state stale until the next dashboard
    /// load. The toggle insert path already mutates todayLog locally
    /// inside logMeal, which propagates to the consumedNames computation
    /// on the next render.
    private func togglePlanned(_ plan: PlannerRow) async {
        if togglingPlannerId == plan.id { return }
        togglingPlannerId = plan.id
        defer { togglingPlannerId = nil }
        do {
            try await state.togglePlannedMeal(plan)
        } catch {
            // Best-effort — a transient failure just leaves the checkbox
            // in its previous state; a pull-to-refresh re-syncs from DB.
        }
    }

    /// Subtitle for a meal row. Combines the rendered serving (when the
    /// entry has serving_description / serving_grams) with the meal type.
    /// Returns nil when neither is available.
    private func mealRowSubtitle(_ entry: MealLogEntry) -> String? {
        let consumed = entry.servings_consumed ?? 1
        let serving = ServingFormat.render(
            description: entry.serving_description,
            grams: entry.serving_grams,
            servings: consumed
        )
        let mealType = entry.meal_type?.capitalized
        switch (serving, mealType) {
        case let (s?, m?): return "\(s) · \(m)"
        case let (s?, nil): return s
        case let (nil, m?): return m
        default: return nil
        }
    }

    private func mealRow(_ entry: MealLogEntry) -> some View {
        Button {
            editingEntry = entry
        } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name ?? "—")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.text)
                        .multilineTextAlignment(.leading)
                    // Prefer a serving-aware subtitle over just the meal_type.
                    // Renders "0.5 medium avocados (75g) · Snack" when the
                    // entry has serving fields; falls back to the bare meal
                    // type for older rows / recipe-linked rows that don't
                    // carry serving info on meal_log.
                    if let label = mealRowSubtitle(entry) {
                        Text(label)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(Int(entry.calories ?? 0)) kcal")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.cal)
                    Text("\(Int(entry.protein ?? 0))P · \(Int(entry.carbs ?? 0))C · \(Int(entry.fat ?? 0))F")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

}

/// Sheet for editing a single meal_log row. Mirrors the web edit
/// modal in src/pages/app.js (openEditModal/saveEditEntry): name,
/// meal type, servings (auto-rescales macros from per-serving base),
/// kcal/P/C/F/Fiber overrides, and a Delete button. Per-serving
/// "base" macros aren't stored on iOS yet, so we derive them on
/// open as `current / servings_consumed` (same fallback the web
/// uses when base_* columns are missing).
/// Reusable preview/edit sheet for a meal_log row. Two modes:
///
///   .new(MealLogDraft) — the user picked a food (Quick Log result,
///       AI describe, USDA generic_foods, recipe match, …) and is
///       previewing before commit. Save options:
///         • "Save and log" → writes meal_log + auto-saves to
///           food_items via logMeal's normal pipeline + fires HK push.
///         • "Save to my foods" → writes food_items only (no log,
///           no HK push). Hidden when the draft is recipe-linked
///           since recipes have their own library.
///
///   .edit(MealLogEntry) — tap-to-edit on Today's Meals. Save options:
///         • "Save" updates the existing row.
///         • "Delete" (confirmation-gated) removes it.
struct MealLogEditor: View {
    enum Mode {
        case new(MealLogDraft)
        case edit(MealLogEntry)
    }

    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    let mode: Mode

    @State private var name: String
    @State private var mealType: String
    @State private var servings: Double
    @State private var calories: Double
    @State private var protein: Double
    @State private var carbs: Double
    @State private var fat: Double
    @State private var fiber: Double
    /// Logged-at as a Date for the DatePicker. Edit mode captures the
    /// original separately (`originalLoggedAt`) so we only send a
    /// logged_at patch when the user actually moved the picker.
    @State private var loggedAtDate: Date
    private let originalLoggedAt: Date
    @State private var saving = false
    @State private var savingToFoods = false
    @State private var deleting = false
    @State private var errorMessage: String?
    @State private var savedToFoodsToast: String?
    @State private var alreadyInLibrary: Bool = false
    @State private var showingDeleteConfirm = false
    @FocusState private var keyboardFocused: Bool

    /// Per-serving "base" macros — divide consumed values by servings to
    /// recover base, then re-multiply when the user changes servings.
    /// (meal_log rows pre-base_macros migration don't expose base
    /// columns to iOS; web does the same fallback.)
    private let baseCalories: Double
    private let baseProtein: Double
    private let baseCarbs: Double
    private let baseFat: Double
    private let baseFiber: Double

    private static let mealTypes = ["breakfast", "lunch", "snack", "dinner"]

    private var isNew: Bool {
        if case .new = mode { return true }
        return false
    }

    private var navTitle: String {
        switch mode {
        case .new:  return "Log meal"
        case .edit: return "Edit meal"
        }
    }

    /// Hide the "Save to my foods" CTA when the draft is recipe-linked
    /// (recipes have their own library) or when we're editing an
    /// existing meal_log row (the food was already auto-saved when the
    /// row was first created).
    private var canSaveToFoods: Bool {
        guard case .new(let draft) = mode else { return false }
        if draft.recipeId != nil { return false }
        return true
    }

    /// Field label for the Servings input. Reads "How many medium
    /// avocados?" when the source has a serving_description; falls back
    /// to "Consumed" otherwise.
    private var servingsFieldLabel: String {
        let desc: String? = {
            switch mode {
            case .new(let draft): return draft.servingDescription
            case .edit(let entry): return entry.serving_description
            }
        }()
        if let unit = ServingFormat.unitNoun(description: desc), !unit.isEmpty {
            return "How many \(unit)?"
        }
        return "Consumed"
    }

    private var servingDescriptionLabel: String? {
        let desc: String? = {
            switch mode {
            case .new(let draft): return draft.servingDescription
            case .edit(let entry): return entry.serving_description
            }
        }()
        guard let d = desc, !d.isEmpty else { return nil }
        return "1 serving = \(d)"
    }

    init(mode: Mode, defaultLoggedAt: Date? = nil) {
        self.mode = mode
        switch mode {
        case .edit(let entry):
            let consumed = max(0.001, entry.servings_consumed ?? 1)
            self.baseCalories = (entry.calories ?? 0) / consumed
            self.baseProtein  = (entry.protein  ?? 0) / consumed
            self.baseCarbs    = (entry.carbs    ?? 0) / consumed
            self.baseFat      = (entry.fat      ?? 0) / consumed
            self.baseFiber    = (entry.fiber    ?? 0) / consumed
            let parsed: Date = {
                if let raw = entry.logged_at,
                   let d = AppState.parseISOTimestamp(raw) { return d }
                return Date()
            }()
            self.originalLoggedAt = parsed
            _loggedAtDate = State(initialValue: parsed)
            _name = State(initialValue: entry.name ?? "")
            _mealType = State(initialValue: entry.meal_type?.lowercased() ?? Self.inferMealType(entry.logged_at))
            _servings = State(initialValue: consumed)
            _calories = State(initialValue: entry.calories ?? 0)
            _protein  = State(initialValue: entry.protein  ?? 0)
            _carbs    = State(initialValue: entry.carbs    ?? 0)
            _fat      = State(initialValue: entry.fat      ?? 0)
            _fiber    = State(initialValue: entry.fiber    ?? 0)
        case .new(let draft):
            // Draft macros are per-serving (caller sends the food's
            // canonical values; servings stepper re-multiplies for
            // display + save).
            self.baseCalories = draft.calories
            self.baseProtein  = draft.protein
            self.baseCarbs    = draft.carbs
            self.baseFat      = draft.fat
            self.baseFiber    = draft.fiber
            let initial = defaultLoggedAt ?? Date()
            self.originalLoggedAt = initial
            _loggedAtDate = State(initialValue: initial)
            _name = State(initialValue: draft.name)
            _mealType = State(initialValue: AppState.inferMealType(at: initial))
            _servings = State(initialValue: 1.0)
            _calories = State(initialValue: draft.calories)
            _protein  = State(initialValue: draft.protein)
            _carbs    = State(initialValue: draft.carbs)
            _fat      = State(initialValue: draft.fat)
            _fiber    = State(initialValue: draft.fiber)
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Meal name", text: $name)
                        .focused($keyboardFocused)
                        .autocorrectionDisabled()
                }

                Section("Meal type") {
                    Picker("Type", selection: $mealType) {
                        ForEach(Self.mealTypes, id: \.self) { t in
                            Text(t.capitalized).tag(t)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section {
                    // Date+time picker for retroactive shift. `in: ...today`
                    // matches the dashboard's chevron clamp — the macros
                    // dashboard isn't designed for future-dated logs.
                    DatePicker(
                        "Logged at",
                        selection: $loggedAtDate,
                        in: ...Date(),
                        displayedComponents: [.date, .hourAndMinute]
                    )
                } header: {
                    Text("When")
                } footer: {
                    Text("Move this entry to a different time or day. Changing the date updates that day's macro totals (and Apple Health, if enabled).")
                        .font(.system(size: 11))
                }

                Section {
                    HStack {
                        Text(servingsFieldLabel)
                        Spacer()
                        TextField("1.0", value: $servings, format: .number.precision(.fractionLength(0...2)))
                            .keyboardType(.decimalPad)
                            .focused($keyboardFocused)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 90)
                            .onChange(of: servings) { _, new in
                                let s = max(0, new)
                                calories = (baseCalories * s).rounded(toPlaces: 1)
                                protein  = (baseProtein  * s).rounded(toPlaces: 1)
                                carbs    = (baseCarbs    * s).rounded(toPlaces: 1)
                                fat      = (baseFat      * s).rounded(toPlaces: 1)
                                fiber    = (baseFiber    * s).rounded(toPlaces: 1)
                            }
                    }
                } header: {
                    Text("Servings")
                } footer: {
                    if let label = servingDescriptionLabel {
                        Text(label).font(.system(size: 11))
                    }
                }

                Section("Macros") {
                    macroField("Calories", value: $calories, suffix: "kcal")
                    macroField("Protein",  value: $protein,  suffix: "g")
                    macroField("Carbs",    value: $carbs,    suffix: "g")
                    macroField("Fat",      value: $fat,      suffix: "g")
                    macroField("Fiber",    value: $fiber,    suffix: "g")
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).font(.system(size: 13)) }
                }
                if let savedToFoodsToast {
                    Section {
                        Text(savedToFoodsToast)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.green)
                    }
                }

                if isNew {
                    if canSaveToFoods {
                        Section {
                            Button {
                                Task { await saveToFoodsOnly() }
                            } label: {
                                HStack {
                                    Spacer()
                                    if savingToFoods { ProgressView() }
                                    else { Text(alreadyInLibrary ? "Already in your foods" : "Save to my foods") }
                                    Spacer()
                                }
                            }
                            .disabled(saving || savingToFoods || deleting || alreadyInLibrary
                                      || name.trimmingCharacters(in: .whitespaces).isEmpty)
                        } footer: {
                            Text("Adds this food to your library so you can re-log it later. Doesn't affect today's macros.")
                                .font(.system(size: 11))
                        }
                    }
                } else {
                    Section {
                        Button(role: .destructive) {
                            showingDeleteConfirm = true
                        } label: {
                            HStack {
                                Spacer()
                                if deleting { ProgressView() }
                                else { Text("Delete entry") }
                                Spacer()
                            }
                        }
                        .disabled(saving || deleting)
                    }
                }
            }
            .navigationTitle(navTitle)
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving || deleting || savingToFoods)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(primaryButtonLabel) { Task { await save() } }
                        .disabled(saving || deleting || savingToFoods
                                  || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    if keyboardFocused {
                        Button("Done") { keyboardFocused = false }
                    }
                }
            }
            .confirmationDialog("Delete this entry?",
                                isPresented: $showingDeleteConfirm,
                                titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { await delete() } }
                Button("Cancel", role: .cancel) { }
            }
        }
    }

    private var primaryButtonLabel: String {
        if saving { return "Saving…" }
        return isNew ? "Save and log" : "Save"
    }

    private func macroField(_ label: String, value: Binding<Double>, suffix: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("0", value: value, format: .number.precision(.fractionLength(0...1)))
                .keyboardType(.decimalPad)
                .focused($keyboardFocused)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
            Text(suffix).foregroundStyle(Theme.text3).font(.system(size: 13))
        }
    }

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }
        switch mode {
        case .edit(let entry):
            // Only ship logged_at when the user actually moved the picker —
            // a no-op picker should not blank or rewrite the column. Tolerance
            // is 1s because DatePicker can wobble sub-second on display.
            let movedTimestamp = abs(loggedAtDate.timeIntervalSince(originalLoggedAt)) > 1
            let patch = MealEntryPatch(
                name: name.trimmingCharacters(in: .whitespaces),
                mealType: mealType,
                calories: calories,
                protein: protein,
                carbs: carbs,
                fat: fat,
                fiber: fiber,
                servingsConsumed: servings,
                loggedAt: movedTimestamp ? ISO8601DateFormatter().string(from: loggedAtDate) : nil
            )
            do {
                try await state.updateMealLogEntry(id: entry.id, patch)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        case .new(let draft):
            do {
                try await state.logMeal(
                    name: name.trimmingCharacters(in: .whitespaces),
                    mealType: mealType,
                    calories: calories,
                    protein: protein,
                    carbs: carbs,
                    fat: fat,
                    fiber: fiber,
                    recipeId: draft.recipeId,
                    foodItemId: draft.foodItemId,
                    servingsConsumed: servings,
                    loggedAt: loggedAtDate,
                    fullLabel: draft.fullLabel
                )
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// "Save to my foods" — write food_items only, no meal_log,
    /// no HK push. Calls AppState.saveFoodToLibrary which handles
    /// dedup; surfaces "Already in your foods" in-place when the row
    /// already exists. Macros sent are PER-SERVING (the editor's
    /// base values, not the consumed-multiplied display values) so
    /// the library row stays canonical.
    private func saveToFoodsOnly() async {
        guard case .new(let draft) = mode else { return }
        savingToFoods = true
        errorMessage = nil
        savedToFoodsToast = nil
        defer { savingToFoods = false }
        do {
            let result = try await state.saveFoodToLibrary(
                name: name.trimmingCharacters(in: .whitespaces),
                calories: baseCalories,
                protein: baseProtein,
                carbs: baseCarbs,
                fat: baseFat,
                fiber: baseFiber,
                servingDescription: draft.servingDescription,
                servingGrams: draft.servingGrams,
                servingOz: draft.servingOz,
                fullLabel: draft.fullLabel
            )
            alreadyInLibrary = true
            savedToFoodsToast = result.wasNew
                ? "✓ Saved to your foods"
                : "Already in your foods — no changes made"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete() async {
        guard case .edit(let entry) = mode else { return }
        deleting = true
        errorMessage = nil
        defer { deleting = false }
        do {
            try await state.deleteMealLogEntry(id: entry.id)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Same buckets as web's getMealTypeFromTime() — Breakfast 5–10am,
    /// Lunch 10am–2pm, Snack 2–5pm, Dinner 5–10pm (everything else
    /// falls into snack as a sane default).
    private static func inferMealType(_ iso: String?) -> String {
        guard let iso else { return "snack" }
        let date: Date? = ISO8601DateFormatter().date(from: iso)
            ?? {
                let f = DateFormatter()
                f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
                return f.date(from: iso)
            }()
        guard let d = date else { return "snack" }
        let h = Calendar.current.component(.hour, from: d)
        switch h {
        case 5..<10:  return "breakfast"
        case 10..<14: return "lunch"
        case 14..<17: return "snack"
        case 17..<22: return "dinner"
        default:      return "snack"
        }
    }
}

private extension Double {
    func rounded(toPlaces n: Int) -> Double {
        let mult = pow(10.0, Double(n))
        return (self * mult).rounded() / mult
    }
}

/// Per-serving snapshot of a food the user is about to log. Carries the
/// macros + provenance flags MealLogEditor needs to either log a row,
/// save to the food library, or both. Macros are PER ONE SERVING — the
/// editor's servings stepper re-multiplies for display + save.
struct MealLogDraft {
    var name: String
    /// Per-serving kcal.
    var calories: Double
    /// Per-serving protein (g).
    var protein: Double
    /// Per-serving carbs (g).
    var carbs: Double
    /// Per-serving fat (g).
    var fat: Double
    /// Per-serving fiber (g).
    var fiber: Double = 0
    /// Existing food_items.id when re-logging a saved food. logMeal
    /// short-circuits its auto-save when set.
    var foodItemId: String? = nil
    /// Existing recipes.id when logging from a recipe library row.
    /// Hides the "Save to my foods" CTA on the editor.
    var recipeId: String? = nil
    /// Optional structured serving info (e.g. "1 medium banana, 118g")
    /// — surfaces in the Servings field's footer hint.
    var servingDescription: String? = nil
    var servingGrams: Double? = nil
    var servingOz: Double? = nil
    /// Optional full-label nutrition (cholesterol, sodium, vitamins, …)
    /// from worker-full-label. Threaded through to logMeal +
    /// saveFoodToLibrary so neither Save action loses the data.
    var fullLabel: AppState.FullLabelPayload? = nil
}
