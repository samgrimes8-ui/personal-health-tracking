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
/// (`src/pages/app.js` ~L924–953). All eight live in a single
/// horizontally-scrollable bar at the bottom — no More overflow.
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
}

/// Signed-in shell. Hosts a `TabView` in `.page` style for swipe-to-page
/// navigation between tabs, with a custom horizontally-scrollable bar
/// pinned to the bottom safe-area inset. Page style preserves per-tab
/// navigation/scroll state automatically (each child is held alive in
/// the underlying UIPageViewController).
struct SignedInShell: View {
    @Environment(AuthManager.self) private var auth
    @Environment(\.scenePhase) private var scenePhase
    @State private var state = AppState()
    /// Throttle for the foreground re-pull. .task fires once per view
    /// lifetime; scenePhase active fires every time the user reopens
    /// the app — without throttling, a quick fg/bg/fg burst would run
    /// the pull three times in a few seconds.
    @State private var lastForegroundPull: Date?

    var body: some View {
        // Bind both the swipe-paged TabView and the bottom bar to
        // AppState.selectedTab so cross-tab navigation works from any
        // view that has the AppState environment (e.g. the Dashboard's
        // "View all →" analytics shortcut). Bindable() exposes a
        // SwiftUI Binding into an @Observable property.
        @Bindable var state = state
        TabView(selection: $state.selectedTab) {
            ForEach(AppTab.allCases, id: \.self) { tab in
                NavigationStack {
                    rootView(for: tab)
                }
                .tag(tab)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ScrollableTabBar(selected: $state.selectedTab)
        }
        .environment(state)
        .tint(Theme.accent)
        // Apple Health: initial pull on shell appear + register the
        // background-delivery observer so HK changes wake the app.
        .task { await runHealthKitPullIfEnabled(reason: "initial-task") }
        // Re-pull on every transition to .active. .task only fires
        // once per view lifetime — without this hook, foregrounding
        // the app after adding weight in HK would never trigger a sync.
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            // Throttle to once per minute. Cheap pull but still want
            // to avoid burning HK quota / DB roundtrips on rapid
            // fg/bg cycles.
            if let last = lastForegroundPull, Date().timeIntervalSince(last) < 60 {
                return
            }
            Task { await runHealthKitPullIfEnabled(reason: "scene-active") }
        }
    }

    private func runHealthKitPullIfEnabled(reason: String) async {
        guard HealthKitService.shared.isAvailable,
              case .signedIn(let user) = auth.state else { return }
        let userId = user.id.uuidString
        HealthKitService.log.info("runHealthKitPullIfEnabled triggered (reason=\(reason, privacy: .public))")
        // Set up the background observer alongside the pull. Idempotent
        // (no-op after first call per launch). Decoupled from the
        // pullWeight toggle on purpose — observer registration is harmless
        // even if read auth is denied; it just won't fire any callbacks.
        do {
            try await HealthKitService.shared.enableBackgroundWeightSync(userId: userId)
        } catch {
            HealthKitService.log.error("enableBackgroundWeightSync failed: \(error.localizedDescription, privacy: .public)")
        }
        guard HealthKitService.isToggleOn(.pullWeight, userId: userId) else {
            HealthKitService.log.debug("pullWeight toggle off — skipping pull")
            return
        }
        lastForegroundPull = Date()
        do {
            let pulled = try await HealthKitService.shared.pullWeightsWithFallback(userId: userId)
            var inserted = 0
            for sample in pulled {
                if let did = try? await DBService.insertHealthKitWeight(
                    kg: sample.kg,
                    recordedAt: sample.recordedAt,
                    healthkitUUID: sample.uuid
                ), did {
                    inserted += 1
                }
            }
            HealthKitService.log.info("Foreground pull inserted \(inserted, privacy: .public) checkin(s)")
            if inserted > 0 {
                await state.loadGoals()
            }
        } catch {
            HealthKitService.log.error("Foreground pull failed: \(error.localizedDescription, privacy: .public)")
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

// MARK: - Scrollable bottom tab bar

/// Horizontally-scrollable tab bar. All eight tabs are present in a
/// single HStack; the user swipes the bar L/R, and a selection change
/// auto-scrolls the new tab to center via ScrollViewReader. Background
/// uses `.bar` material so the surface matches the system tab bar
/// chrome (translucent blur). Only the icon/label tint is themed.
private struct ScrollableTabBar: View {
    @Binding var selected: AppTab

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(AppTab.allCases, id: \.self) { tab in
                        TabBarButton(
                            title: tab.title,
                            systemImage: tab.systemImage,
                            isActive: selected == tab
                        ) {
                            selected = tab
                        }
                        .id(tab)
                    }
                }
                .padding(.horizontal, 4)
            }
            .background(.bar)
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Theme.border)
                    .frame(height: 0.5)
            }
            .onAppear {
                // Land the initial selection in view without animation
                // so first paint isn't a visible scroll.
                proxy.scrollTo(selected, anchor: .center)
            }
            .onChange(of: selected) { _, newValue in
                withAnimation(.easeInOut(duration: 0.25)) {
                    proxy.scrollTo(newValue, anchor: .center)
                }
            }
        }
    }
}

private struct TabBarButton: View {
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
                    .lineLimit(1)
            }
            .frame(minWidth: 78)
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .foregroundStyle(isActive ? Theme.accent : Theme.text2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
