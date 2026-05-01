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

/// Tab bar. Dashboard is native; the rest are WebViewTab fallbacks
/// that load the existing web app inside a WKWebView. As each screen
/// gets a native rewrite, swap that tab from WebViewTab(page:) to the
/// new SwiftUI view. See TODO.md "iOS native migration roadmap" for
/// the order.
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

            WebViewTab(page: "planner", title: "Planner")
                .tabItem { Label("Planner", systemImage: "calendar") }

            WebViewTab(page: "recipes", title: "Recipes")
                .tabItem { Label("Recipes", systemImage: "book.fill") }

            WebViewTab(page: "account", title: "Account")
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .environment(state)
        .tint(Theme.accent)
    }
}
