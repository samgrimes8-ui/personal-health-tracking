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

/// Tab bar. All 8 tabs are native after Phase 2 — Dashboard, Goals,
/// Analytics, Planner, Recipes, Providers, Foods, Account. WebViewTab
/// remains in the codebase as a fallback if any future tab needs to
/// fall back to the web app inside a WKWebView, but is not currently
/// used here.
///
/// SwiftUI's TabView caps at 5 visible tabs on iPhone before collapsing
/// the rest into a "More" overflow — the extra three (Providers, Foods,
/// Account) live in there until we either add a custom tab bar or cut
/// the surface area down. Acceptable tradeoff during the native port.
struct SignedInShell: View {
    @State private var state = AppState()

    var body: some View {
        TabView {
            NavigationStack {
                DashboardView()
            }
            .tabItem { Label("Dashboard", systemImage: "house.fill") }

            NavigationStack {
                GoalsView()
            }
            .tabItem { Label("Goals", systemImage: "target") }

            NavigationStack {
                AnalyticsView()
            }
            .tabItem { Label("Analytics", systemImage: "chart.bar.fill") }

            NavigationStack {
                PlannerView()
            }
            .tabItem { Label("Planner", systemImage: "calendar") }

            NavigationStack {
                RecipesView()
            }
            .tabItem { Label("Recipes", systemImage: "book.fill") }

            NavigationStack {
                ProvidersView()
            }
            .tabItem { Label("Providers", systemImage: "person.2.fill") }

            NavigationStack {
                FoodsView()
            }
            .tabItem { Label("Foods", systemImage: "fork.knife") }

            NavigationStack {
                AccountView()
            }
            .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .environment(state)
        .tint(Theme.accent)
    }
}
