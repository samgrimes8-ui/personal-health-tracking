import SwiftUI

/// Top-level routing. Branches between auth screen and the signed-in
/// shell based on `AuthManager.state`. The `loading` state shows a brief
/// splash so we don't flash the auth screen for users with a persisted
/// session.
struct AppShell: View {
    @Environment(AuthManager.self) private var auth

    var body: some View {
        switch auth.state {
        case .loading:
            ZStack {
                Theme.bg.ignoresSafeArea()
                ProgressView().tint(Theme.accent)
            }
        case .signedOut:
            AuthView()
        case .signedIn:
            SignedInShell()
        }
    }
}

/// Tabs in the same order as the desktop sidebar
/// (`src/pages/app.js` ~L924–953). Splitting into "primary" (bottom bar)
/// vs "secondary" (More sheet) keeps the four most-trafficked screens
/// one tap away while avoiding the SwiftUI TabView "More" overflow,
/// which collapses everything past the fifth tab into an ugly system
/// list on iPhone.
enum AppTab: Hashable, CaseIterable {
    case dashboard, analytics, planner, goals, recipes, providers, foods, account

    var title: String {
        switch self {
        case .dashboard: return "Dashboard"
        case .analytics: return "Analytics"
        case .planner:   return "Planner"
        case .goals:     return "Goals"
        case .recipes:   return "Recipes"
        case .providers: return "Providers"
        case .foods:     return "Foods"
        case .account:   return "Account"
        }
    }

    var systemImage: String {
        switch self {
        case .dashboard: return "house.fill"
        case .analytics: return "chart.bar.fill"
        case .planner:   return "calendar"
        case .goals:     return "target"
        case .recipes:   return "book.fill"
        case .providers: return "person.2.fill"
        case .foods:     return "fork.knife"
        case .account:   return "person.crop.circle"
        }
    }

    /// Tabs in the bottom bar. Picked for traffic — Dashboard and
    /// Planner drive most sessions, Analytics is the second-most-opened
    /// surface, Account holds settings/sign-out. The other four (Goals,
    /// Recipes, Providers, Foods) live behind the More button. Order
    /// within each list mirrors the desktop sidebar so the surfaces
    /// feel like the same app.
    static let primary: [AppTab] = [.dashboard, .analytics, .planner, .account]
    static let secondary: [AppTab] = [.goals, .recipes, .providers, .foods]
}

/// Signed-in shell. Hosts a `TabView` with its system tab bar hidden
/// and overlays a custom bottom bar + slide-up "More" sheet so all
/// eight tabs are reachable without the SwiftUI More overflow. TabView
/// is kept (rather than swapped for a ZStack of NavigationStacks)
/// because it preserves per-tab navigation and scroll state for free.
struct SignedInShell: View {
    @State private var state = AppState()
    @State private var selected: AppTab = .dashboard
    @State private var showMore: Bool = false

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selected) {
                ForEach(AppTab.allCases, id: \.self) { tab in
                    NavigationStack {
                        rootView(for: tab)
                    }
                    .tag(tab)
                    .toolbar(.hidden, for: .tabBar)
                }
            }

            BottomBar(selected: $selected, showMore: $showMore)
        }
        .background(Theme.bg.ignoresSafeArea())
        .environment(state)
        .tint(Theme.accent)
        .sheet(isPresented: $showMore) {
            MoreSheet(selected: $selected, isPresented: $showMore)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
                .presentationBackground(Theme.bg)
        }
    }

    @ViewBuilder
    private func rootView(for tab: AppTab) -> some View {
        switch tab {
        case .dashboard: DashboardView()
        case .analytics: AnalyticsView()
        case .planner:   PlannerView()
        case .goals:     GoalsView()
        case .recipes:   RecipesView()
        case .providers: ProvidersView()
        case .foods:     FoodsView()
        case .account:   AccountView()
        }
    }
}

// MARK: - Bottom bar

private struct BottomBar: View {
    @Binding var selected: AppTab
    @Binding var showMore: Bool

    var body: some View {
        HStack(spacing: 0) {
            ForEach(AppTab.primary, id: \.self) { tab in
                BottomBarButton(
                    title: tab.title,
                    systemImage: tab.systemImage,
                    isActive: selected == tab && !showMore
                ) {
                    selected = tab
                }
            }
            BottomBarButton(
                title: "More",
                systemImage: "ellipsis",
                isActive: AppTab.secondary.contains(selected) || showMore
            ) {
                showMore = true
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .background(
            Theme.bg2
                .overlay(
                    Rectangle()
                        .fill(Theme.border)
                        .frame(height: 1),
                    alignment: .top
                )
                .ignoresSafeArea(edges: .bottom)
        )
    }
}

private struct BottomBarButton: View {
    let title: String
    let systemImage: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: systemImage)
                    .font(.system(size: 19, weight: .regular))
                Text(title)
                    .font(.system(size: 10, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .foregroundStyle(isActive ? Theme.accent : Theme.text2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - More sheet

/// Slide-up sheet listing the secondary tabs. Mirrors the desktop
/// sidebar styling — left-aligned icon + label, accent highlight on
/// the active row.
private struct MoreSheet: View {
    @Binding var selected: AppTab
    @Binding var isPresented: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("More")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 12)

            VStack(spacing: 0) {
                ForEach(Array(AppTab.secondary.enumerated()), id: \.element) { idx, tab in
                    MoreRow(tab: tab, isActive: selected == tab) {
                        selected = tab
                        isPresented = false
                    }
                    if idx < AppTab.secondary.count - 1 {
                        Rectangle()
                            .fill(Theme.border)
                            .frame(height: 1)
                            .padding(.leading, 56)
                    }
                }
            }
            .background(Theme.bg2)
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal, 16)

            Spacer(minLength: 0)
        }
        .padding(.top, 8)
    }
}

private struct MoreRow: View {
    let tab: AppTab
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: tab.systemImage)
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(isActive ? Theme.accent : Theme.text2)
                    .frame(width: 28, alignment: .center)
                Text(tab.title)
                    .font(.system(size: 16, weight: isActive ? .semibold : .regular))
                    .foregroundStyle(isActive ? Theme.accent : Theme.text)
                Spacer()
                if isActive {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
