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
            VStack(alignment: .leading, spacing: 6) {
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
                if isTrackingFullLabel,
                   let extras = FullLabelDisplay.compactSummary(entry: entry),
                   !extras.isEmpty {
                    Text(extras)
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.text3)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Mirrors AccountView/MacroBreakdownSection's read of the canonical
    /// full-nutrition-label opt-in — profile column wins, AppStorage
    /// cache fills in until the profile fetch completes.
    @AppStorage("macrolens_track_full_nutrition") private var trackFullNutritionCached: Bool = false
    private var isTrackingFullLabel: Bool {
        state.profile?.track_full_nutrition ?? trackFullNutritionCached
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
    /// Shared "is ANY field in this sheet focused" flag — drives the
    /// keyboard "Done" toolbar button visibility and lets every numeric
    /// field broadcast its focus state to the toolbar. Intentionally
    /// NOT bound to any specific TextField via `.focused(...)` —
    /// otherwise setting it from a numeric-field tap would steal focus
    /// to whichever field carries the binding (was the bug: tapping
    /// the amount field jumped the cursor into the Name field because
    /// they shared this @FocusState).
    @FocusState private var keyboardFocused: Bool
    /// Drives the Name TextField's `.focused(...)` modifier in
    /// isolation so a focus event on a numeric field can't bleed in.
    /// Mirrors into `keyboardFocused` via .onChange below so the
    /// toolbar Done button + the field-side dismissal logic still
    /// see "the Name field is focused" through the shared flag.
    @FocusState private var nameFocused: Bool

    /// Display unit for the amount field. Persisted across previews
    /// in UserDefaults so a user who logs grams once gets grams next
    /// time. Falls back to .servings when the source food doesn't
    /// carry serving_grams (which is required for any conversion).
    @State private var unitMode: MealLogUnitMode
    /// Amount as displayed in the current unit. Bound to the
    /// FractionalNumberField; the canonical servings value is
    /// recomputed via `currentServings` whenever this commits.
    @State private var displayedAmount: Double = 1.0

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
            _calories = State(initialValue: draft.calories)
            _protein  = State(initialValue: draft.protein)
            _carbs    = State(initialValue: draft.carbs)
            _fat      = State(initialValue: draft.fat)
            _fiber    = State(initialValue: draft.fiber)
        }
        // Default unit is always .servings per spec — most foods are
        // most natural in servings; the user picks grams/ounces from
        // the dropdown when they want precision. Don't change the
        // global default based on the user's last pick.
        let resolvedMode: MealLogUnitMode = .servings
        self._unitMode = State(initialValue: resolvedMode)
        // Initial displayed amount: 1 serving's worth in the chosen unit.
        let g: Double? = {
            switch mode {
            case .new(let d): return d.servingGrams
            case .edit(let e): return e.serving_grams
            }
        }()
        let oz: Double? = {
            switch mode {
            case .new(let d): return d.servingOz ?? d.servingGrams.map { $0 / 28.3495 }
            case .edit(let e): return e.serving_oz ?? e.serving_grams.map { $0 / 28.3495 }
            }
        }()
        let initialServings: Double = {
            switch mode {
            case .new: return 1.0
            case .edit(let e): return max(0.001, e.servings_consumed ?? 1)
            }
        }()
        let initialDisplayed: Double = {
            switch resolvedMode {
            case .servings: return initialServings
            case .grams:    return (g.map { initialServings * $0 }) ?? initialServings
            case .ounces:   return (oz.map { initialServings * $0 }) ?? initialServings
            }
        }()
        self._displayedAmount = State(initialValue: initialDisplayed)
    }

    /// gram weight per serving (if the source food has it).
    private var servingGrams: Double? {
        switch mode {
        case .new(let d): return d.servingGrams
        case .edit(let e): return e.serving_grams
        }
    }
    /// oz per serving — falls back to grams ÷ 28.3495 when the source
    /// only carries a gram weight.
    private var servingOz: Double? {
        switch mode {
        case .new(let d): return d.servingOz ?? d.servingGrams.map { $0 / 28.3495 }
        case .edit(let e): return e.serving_oz ?? e.serving_grams.map { $0 / 28.3495 }
        }
    }
    /// Which units make sense for THIS food. Always servings; grams
    /// added when serving_grams is present; ounces added when grams
    /// or oz is present (oz derives from grams).
    private var availableUnits: [MealLogUnitMode] {
        var out: [MealLogUnitMode] = [.servings]
        if servingGrams != nil { out.append(.grams) }
        if servingOz != nil    { out.append(.ounces) }
        return out
    }
    /// Convert the field's displayed value (in the active unit) into
    /// canonical servings. Used for save and macro computation.
    private func currentServings() -> Double {
        switch unitMode {
        case .servings: return displayedAmount
        case .grams:    return servingGrams.map { displayedAmount / max($0, 0.0001) } ?? displayedAmount
        case .ounces:   return servingOz.map    { displayedAmount / max($0, 0.0001) } ?? displayedAmount
        }
    }
    /// Switch to a specific unit. Re-formats displayedAmount so the
    /// SAME servings value reads correctly in the new unit. No-op if
    /// the unit is already active. Called from the dropdown's
    /// per-option Button — also updates the macro fields once the
    /// new displayed amount lands so the consumed kcal/P/C/F preview
    /// matches the new unit's value immediately.
    private func setUnit(_ next: MealLogUnitMode) {
        guard next != unitMode else { return }
        let s = currentServings()
        switch next {
        case .servings: displayedAmount = s
        case .grams:    displayedAmount = (servingGrams.map { s * $0 }) ?? s
        case .ounces:   displayedAmount = (servingOz.map    { s * $0 }) ?? s
        }
        unitMode = next
        recomputeMacrosFromAmount()
    }
    /// Dropdown for picking the unit (Serving / Gram / Ounce). Sits
    /// to the right of the amount field; tap a row to switch units.
    /// Gram/Ounce options are hidden when the source food doesn't
    /// carry a serving_grams weight (no conversion possible).
    @ViewBuilder
    private var unitPickerMenu: some View {
        Menu {
            // Always offer Serving — it's the default and never needs
            // a conversion factor.
            Button {
                setUnit(.servings)
            } label: {
                if unitMode == .servings {
                    Label(MealLogUnitMode.servings.displayName, systemImage: "checkmark")
                } else {
                    Text(MealLogUnitMode.servings.displayName)
                }
            }
            if servingGrams != nil {
                Button {
                    setUnit(.grams)
                } label: {
                    if unitMode == .grams {
                        Label(MealLogUnitMode.grams.displayName, systemImage: "checkmark")
                    } else {
                        Text(MealLogUnitMode.grams.displayName)
                    }
                }
                Button {
                    setUnit(.ounces)
                } label: {
                    if unitMode == .ounces {
                        Label(MealLogUnitMode.ounces.displayName, systemImage: "checkmark")
                    } else {
                        Text(MealLogUnitMode.ounces.displayName)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(unitMode.displayName)
                    .font(.system(size: 13, weight: .medium))
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
            }
            .foregroundStyle(Theme.text2)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Theme.bg3, in: Capsule())
            .overlay(Capsule().stroke(Theme.border, lineWidth: 1))
        }
        .accessibilityLabel("Unit")
        .accessibilityValue(unitMode.displayName)
        .accessibilityHint("Choose serving, gram, or ounce")
    }

    /// Recompute the consumed macro fields from the per-serving base
    /// times the current servings value. Called on amount-field commit
    /// and on unit changes so the kcal/P/C/F preview always matches
    /// what'll be saved.
    private func recomputeMacrosFromAmount() {
        let s = max(0, currentServings())
        calories = (baseCalories * s).rounded(toPlaces: 1)
        protein  = (baseProtein  * s).rounded(toPlaces: 1)
        carbs    = (baseCarbs    * s).rounded(toPlaces: 1)
        fat      = (baseFat      * s).rounded(toPlaces: 1)
        fiber    = (baseFiber    * s).rounded(toPlaces: 1)
    }
    /// Top-of-sheet "1 serving = …" hint. Pulls the structured
    /// serving_description when present (set by USDA / AI / barcode
    /// paths via worker-serving-units), falls back to a gram weight
    /// when only that's known, otherwise nothing.
    private var topServingHint: String? {
        let desc: String? = {
            switch mode {
            case .new(let d): return d.servingDescription
            case .edit(let e): return e.serving_description
            }
        }()
        if let desc, !desc.isEmpty { return "1 serving = \(desc)" }
        if let g = servingGrams, g > 0 {
            let formatted = g == g.rounded() ? "\(Int(g))" : String(format: "%.1f", g)
            return "1 serving ≈ \(formatted)g"
        }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Meal name", text: $name)
                        .focused($nameFocused)
                        .autocorrectionDisabled()
                    if let hint = topServingHint {
                        HStack(spacing: 6) {
                            Image(systemName: "scalemass")
                                .foregroundStyle(Theme.text3)
                                .font(.system(size: 11))
                            Text(hint)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.text3)
                        }
                    }
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
                        Spacer()
                        FractionalNumberField(
                            value: $displayedAmount,
                            placeholder: "1",
                            precision: unitMode == .servings ? 2 : 1,
                            width: 100,
                            keyboardFocused: $keyboardFocused,
                            onCommit: { recomputeMacrosFromAmount() }
                        )
                        unitPickerMenu
                    }
                } header: {
                    Text("Amount")
                } footer: {
                    Text(amountFooterHint)
                        .font(.system(size: 11))
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
            // Mirror Name field focus into the shared keyboardFocused
            // flag so the toolbar Done button shows whenever the Name
            // field is up. Numeric fields handle the same mirroring
            // inside FractionalNumberField, so the shared flag tracks
            // "any field focused" without any one TextField having to
            // own the binding.
            .onChange(of: nameFocused) { _, isFocused in
                if isFocused { keyboardFocused = true }
            }
            // Reverse direction: tapping Done clears the shared flag,
            // which propagates back to the Name field so the keyboard
            // actually dismisses (FractionalNumberField has its own
            // onChange that does the same for numeric fields).
            .onChange(of: keyboardFocused) { _, isFocused in
                if !isFocused, nameFocused { nameFocused = false }
            }
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

    /// Footer hint under the Amount field. In servings mode this is
    /// just "Tip: type 1/2 or ½ for a half-serving"; in grams/oz it
    /// shows the conversion ("≈ X servings") so the user can see what
    /// they're committing.
    private var amountFooterHint: String {
        let s = currentServings()
        let servingsLabel: String = {
            if s == s.rounded() { return "\(Int(s.rounded())) serving\(s == 1 ? "" : "s")" }
            let f = NumberFormatter()
            f.minimumFractionDigits = 0; f.maximumFractionDigits = 2
            return "\(f.string(from: NSNumber(value: s)) ?? "\(s)") servings"
        }()
        switch unitMode {
        case .servings:
            return "Type 1/2, ½, or 1.5 for partial servings."
        case .grams:
            return "≈ \(servingsLabel)"
        case .ounces:
            return "≈ \(servingsLabel)"
        }
    }

    private func macroField(_ label: String, value: Binding<Double>, suffix: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            FractionalNumberField(
                value: value,
                placeholder: "0",
                precision: 1,
                width: 80,
                keyboardFocused: $keyboardFocused
            )
            Text(suffix).foregroundStyle(Theme.text3).font(.system(size: 13))
        }
    }

    private func save() async {
        // Force any active TextField to flush its typed value to its
        // binding before we read displayedAmount / calories / etc.
        // FractionalNumberField wraps a UITextField that only commits
        // on focus loss, so tapping Save with the keyboard still up
        // would otherwise read the OLD bound value. Mirrors the web
        // fix in commit 8f6eb14 (document.activeElement.blur() before
        // reading the input).
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil, from: nil, for: nil
        )
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
                servingsConsumed: currentServings(),
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
                    servingsConsumed: currentServings(),
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

/// Reusable numeric field for the meal-log editor. Improvements over a
/// raw `TextField(value:format:)`:
///
///   • Tap-to-select-all on focus (so re-tapping a field with content
///     lets the user immediately type a replacement instead of having
///     to manually clear it).
///   • Inline ✕ clear button while focused with non-empty text.
///   • Fraction parsing on commit ("1/2", "1 1/2", "½", "1.5" all
///     resolve to a Double). Decimal pad keyboards don't have a `/`,
///     but the parser also catches anything else the user pasted in.
///   • Long-press still surfaces the system cut/copy/paste menu since
///     the underlying control is a stock SwiftUI TextField.
///
/// External `value` binding stays the source of truth — the field
/// re-syncs its visible text when `value` changes from outside (e.g.
/// the unit toggle re-formats it for grams/ounces) but only when the
/// field isn't focused, so user typing is never clobbered mid-edit.
struct FractionalNumberField: View {
    @Binding var value: Double
    var placeholder: String = "0"
    var precision: Int = 2
    var width: CGFloat? = 90
    var keyboardFocused: FocusState<Bool>.Binding? = nil
    var onCommit: (() -> Void)? = nil

    @State private var text: String
    @State private var isFocused: Bool = false

    init(value: Binding<Double>,
         placeholder: String = "0",
         precision: Int = 2,
         width: CGFloat? = 90,
         keyboardFocused: FocusState<Bool>.Binding? = nil,
         onCommit: (() -> Void)? = nil) {
        self._value = value
        self.placeholder = placeholder
        self.precision = precision
        self.width = width
        self.keyboardFocused = keyboardFocused
        self.onCommit = onCommit
        _text = State(initialValue: Self.format(value.wrappedValue, precision: precision))
    }

    var body: some View {
        UIKitNumericField(
            text: $text,
            isFocused: $isFocused,
            placeholder: placeholder,
            onCommit: { commit() }
        )
        .frame(width: width, height: 32)
        .onChange(of: isFocused) { _, isNowFocused in
            // Mirror focus into the parent's shared keyboard binding so
            // the "Done" toolbar button shows while any numeric field
            // is up. Only flip the shared flag in the "gained focus"
            // direction here; the reverse direction (Done tapped →
            // unfocus) flows through the second onChange below.
            if isNowFocused {
                keyboardFocused?.wrappedValue = true
            }
        }
        .onChange(of: keyboardFocused?.wrappedValue ?? false) { _, sharedNow in
            if !sharedNow && isFocused {
                // Done (or any other shared-flag clear) → unfocus this
                // field too. UIKitNumericField will resignFirstResponder
                // on the next updateUIView pass.
                isFocused = false
            }
        }
        .onChange(of: value) { _, newValue in
            // External update (parent recomputed value, e.g. unit
            // change). Don't clobber the user's mid-edit typing.
            if !isFocused {
                text = Self.format(newValue, precision: precision)
            }
        }
    }

    private func commit() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            value = 0
            text = Self.format(0, precision: precision)
        } else if let parsed = FractionParser.parse(trimmed) {
            value = parsed
            text = Self.format(parsed, precision: precision)
        } else {
            // Bad input — revert to last good value's formatted text.
            text = Self.format(value, precision: precision)
        }
        onCommit?()
    }

    private static func format(_ v: Double, precision: Int) -> String {
        if v == v.rounded() {
            return String(Int(v.rounded()))
        }
        let f = NumberFormatter()
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = precision
        return f.string(from: NSNumber(value: v)) ?? String(v)
    }
}

/// Subclass that calls `selectAll(nil)` after a brief delay on
/// becoming first responder, so a tap on a numeric field highlights
/// the existing value — typing then immediately replaces it instead
/// of appending. The 0.05s delay gives the system time to fully
/// install the field as first responder + show the keyboard before
/// the selection lands; without it, the selection sometimes gets
/// stomped by the cursor placement.
private final class SelectAllOnFocusTextField: UITextField {
    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                guard let self, self.isFirstResponder else { return }
                self.selectAll(nil)
            }
        }
        return became
    }
}

/// SwiftUI bridge over the SelectAllOnFocusTextField subclass.
/// FractionalNumberField wraps it; callers should generally use the
/// SwiftUI wrapper rather than this directly. Standard iOS edit menu
/// (cut/copy/paste/select) stays available on long-press because we
/// don't override anything menu-related.
private struct UIKitNumericField: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var placeholder: String
    var onCommit: () -> Void

    func makeUIView(context: Context) -> SelectAllOnFocusTextField {
        let tf = SelectAllOnFocusTextField()
        tf.delegate = context.coordinator
        tf.keyboardType = .decimalPad
        tf.textAlignment = .right
        tf.placeholder = placeholder
        tf.font = .preferredFont(forTextStyle: .body)
        tf.adjustsFontForContentSizeCategory = true
        tf.borderStyle = .none
        tf.clearButtonMode = .whileEditing  // standard ✕ inside the field
        tf.setContentHuggingPriority(.defaultLow, for: .horizontal)
        tf.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return tf
    }

    func updateUIView(_ tf: SelectAllOnFocusTextField, context: Context) {
        // Coordinator stores the latest props so its delegate callbacks
        // see the current bindings (struct value capture is fine but
        // closures hold the old `parent` until we refresh).
        context.coordinator.parent = self
        // Sync external text changes (unit toggle re-format etc.) only
        // when the user isn't actively editing — otherwise we'd clobber
        // their cursor + typing.
        if !tf.isFirstResponder, tf.text != text {
            tf.text = text
        }
        if tf.placeholder != placeholder {
            tf.placeholder = placeholder
        }
        // Programmatic focus: parent setting isFocused = false (Done
        // toolbar tap) should give up first responder.
        if isFocused, !tf.isFirstResponder {
            DispatchQueue.main.async { _ = tf.becomeFirstResponder() }
        } else if !isFocused, tf.isFirstResponder {
            DispatchQueue.main.async { _ = tf.resignFirstResponder() }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: UIKitNumericField
        init(parent: UIKitNumericField) { self.parent = parent }

        func textFieldDidBeginEditing(_ tf: UITextField) {
            parent.isFocused = true
        }

        func textFieldDidEndEditing(_ tf: UITextField) {
            parent.text = tf.text ?? ""
            parent.isFocused = false
            parent.onCommit()
        }

        // Mirror live keystrokes back to the binding so the parent's
        // commit() (called on focus loss) sees the current text. Also
        // covers the standard ✕ clear-button inside the field — it
        // empties the text without firing didEndEditing.
        func textField(_ tf: UITextField,
                       shouldChangeCharactersIn range: NSRange,
                       replacementString string: String) -> Bool {
            if let cur = tf.text, let r = Range(range, in: cur) {
                parent.text = cur.replacingCharacters(in: r, with: string)
            } else {
                parent.text = string
            }
            return true
        }

        func textFieldShouldClear(_ tf: UITextField) -> Bool {
            parent.text = ""
            return true
        }

        func textFieldShouldReturn(_ tf: UITextField) -> Bool {
            tf.resignFirstResponder()
            return true
        }
    }
}

/// Tolerant fraction/mixed-number parser. Accepts:
///   "1.5"       → 1.5
///   "1/2"       → 0.5
///   "1 1/2"     → 1.5
///   "½", "¼"…   → unicode fraction characters
///   "  1/4 "    → leading/trailing whitespace
/// Returns nil for empty/garbage so the caller can keep the prior
/// value rather than defaulting to 0.
enum FractionParser {
    private static let unicodeFractions: [Character: String] = [
        "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4",
        "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5",
        "⅙": "1/6", "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8"
    ]

    static func parse(_ raw: String) -> Double? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return nil }

        // Expand any unicode fraction characters first so "1½" → "1 1/2".
        var expanded = ""
        for ch in trimmed {
            if let frac = unicodeFractions[ch] {
                if !expanded.isEmpty,
                   let last = expanded.last,
                   last.isNumber || last == "." {
                    expanded.append(" ")
                }
                expanded.append(frac)
            } else {
                expanded.append(ch)
            }
        }

        // Try mixed number "1 1/2"
        let parts = expanded.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        if parts.count == 2,
           let whole = Double(parts[0]),
           let frac = parseSimpleFraction(parts[1]) {
            return whole + frac
        }
        // Pure fraction
        if let frac = parseSimpleFraction(expanded) { return frac }
        // Plain number
        return Double(expanded)
    }

    private static func parseSimpleFraction(_ text: String) -> Double? {
        let parts = text.split(separator: "/").map(String.init)
        guard parts.count == 2,
              let num = Double(parts[0]),
              let den = Double(parts[1]),
              den != 0 else { return nil }
        return num / den
    }
}

/// Display unit for the Amount field in the meal-log preview. Default
/// is always `.servings` per spec — most foods are most natural in
/// servings; the user opts into grams/ounces when they want precision.
/// Available alternates are gated by serving_grams / serving_oz on
/// the source row (foods without a gram weight stay servings-only).
enum MealLogUnitMode: String, CaseIterable {
    case servings, grams, ounces

    /// Singular noun for the menu label + Amount section header.
    /// Reads more naturally than the plural in the picker since the
    /// picker is showing the unit *category*, not a count.
    var displayName: String {
        switch self {
        case .servings: return "Serving"
        case .grams:    return "Gram"
        case .ounces:   return "Ounce"
        }
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
