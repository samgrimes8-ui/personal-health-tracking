import SwiftUI

/// Native Meal Planner. Mirrors renderPlanner() in src/pages/app.js —
/// week navigation + 7-day grid + grocery list + share modal.
///
/// State flow:
///   * `weekStart` is the visible Sunday's `YYYY-MM-DD` string. Local
///     to the view; bumping it triggers a state.loadPlanner() refresh.
///   * AppState owns the planner rows in `plannerByDay[0..6]` so the
///     grid + grocery view share one source of truth.
struct PlannerView: View {
    @Environment(AppState.self) private var state

    @State private var weekStart: String = PlannerDateMath.currentWeekStart()
    @State private var mode: Mode = .meals
    @State private var addSheet: AddTarget?
    @State private var editTarget: PlannerRow?
    @State private var showShare = false

    enum Mode: String, CaseIterable, Identifiable {
        case meals, grocery
        var id: String { rawValue }
        var label: String {
            switch self {
            case .meals: return "Meal plan"
            case .grocery: return "Grocery list"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                weekNavigation
                modeTabs
                content
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .navigationTitle("Meal Planner")
        .navigationBarTitleDisplayMode(.large)
        .task(id: weekStart) {
            await state.plannerLoadImpl(weekStart: weekStart)
        }
        .refreshable {
            await state.plannerLoadImpl(weekStart: weekStart)
        }
        .sheet(item: $addSheet) { target in
            AddPlannerMealSheet(
                weekStart: weekStart,
                dayIndex: target.dayIndex,
                slot: target.slot,
                onSaved: {
                    Task { await state.plannerLoadImpl(weekStart: weekStart) }
                }
            )
        }
        .sheet(item: $editTarget) { meal in
            EditPlannerMealSheet(
                meal: meal,
                weekStart: weekStart,
                onSaved: {
                    Task { await state.plannerLoadImpl(weekStart: weekStart) }
                }
            )
        }
        .sheet(isPresented: $showShare) {
            ShareWeekModal(weekStart: weekStart)
        }
    }

    // MARK: - Week navigation

    private var weekNavigation: some View {
        HStack(spacing: 8) {
            Button {
                weekStart = PlannerDateMath.addDays(weekStart, -7)
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .padding(.vertical, 8).padding(.horizontal, 12)
                    .background(Theme.bg2, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Previous week")

            Text(PlannerDateMath.weekLabel(weekStart))
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(Theme.bg2, in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))

            Button {
                weekStart = PlannerDateMath.addDays(weekStart, 7)
            } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .padding(.vertical, 8).padding(.horizontal, 12)
                    .background(Theme.bg2, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Next week")

            if weekStart != PlannerDateMath.currentWeekStart() {
                Button {
                    weekStart = PlannerDateMath.currentWeekStart()
                } label: {
                    Text("Today")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .padding(.vertical, 8).padding(.horizontal, 12)
                        .background(Theme.accent.opacity(0.10), in: .rect(cornerRadius: 8))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(Theme.accent.opacity(0.30), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Mode tabs

    private var modeTabs: some View {
        HStack(spacing: 8) {
            ForEach(Mode.allCases) { m in
                Button { mode = m } label: {
                    Text(m.label)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(mode == m ? Theme.accentFG : Theme.text2)
                        .padding(.vertical, 8).padding(.horizontal, 16)
                        .background(
                            mode == m ? Theme.accent : Theme.bg3,
                            in: .rect(cornerRadius: 999)
                        )
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 8)
            if mode == .meals && hasMealsThisWeek {
                Button { showShare = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "square.and.arrow.up")
                        Text("Share")
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .padding(.vertical, 7).padding(.horizontal, 12)
                    .background(Theme.accent.opacity(0.10), in: .rect(cornerRadius: 999))
                    .overlay(
                        RoundedRectangle(cornerRadius: 999)
                            .stroke(Theme.accent.opacity(0.30), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch mode {
        case .meals:
            PlannerWeekGrid(
                weekStart: weekStart,
                onAddMeal: { dayIndex, slot in
                    addSheet = AddTarget(dayIndex: dayIndex, slot: slot)
                },
                onEditMeal: { meal in
                    editTarget = meal
                }
            )
        case .grocery:
            GroceryListView(weekStart: weekStart)
        }
    }

    private var hasMealsThisWeek: Bool {
        state.plannerByDay.contains { !$0.isEmpty }
    }

    // MARK: - Sheet identifiers

    struct AddTarget: Identifiable {
        let dayIndex: Int
        let slot: PlannerMealSlot
        var id: String { "\(dayIndex)-\(slot.rawValue)" }
    }
}
