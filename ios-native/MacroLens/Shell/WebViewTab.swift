import SwiftUI
import WebKit
import Supabase

/// SwiftUI wrapper around WKWebView for the not-yet-migrated screens.
/// Loads the live web app at `Config.apiBaseURL` with two URL params and
/// the session tokens forwarded via fragment so the webview signs in
/// silently as the same user the native app is signed in as.
///
/// URL shape:
///   https://.../?page=<page>&embed=1#access_token=<jwt>&refresh_token=<jwt>
///
///   page=<page>     → web app picks the right screen on init
///   embed=1         → web app hides its sidebar/hamburger so the native
///                     tab bar is the only nav
///   #access_token   → Supabase JS client's detectSessionInUrl picks
///                     this up automatically — same flow as OAuth callbacks
struct WebViewTab: View {
    let page: String
    let title: String

    @Environment(AuthManager.self) private var auth

    var body: some View {
        NavigationStack {
            Group {
                if let url = makeURL() {
                    WebViewRepresentable(url: url)
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    // currentSession not yet loaded — brief placeholder.
                    ZStack {
                        Theme.bg.ignoresSafeArea()
                        ProgressView().tint(Theme.accent)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func makeURL() -> URL? {
        guard let session = auth.currentSession else { return nil }
        var components = URLComponents(url: Config.apiBaseURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "page", value: page),
            URLQueryItem(name: "embed", value: "1"),
        ]
        // URLComponents URL-encodes queryItems but doesn't touch the
        // fragment, so we set it raw. Tokens are already base64url-safe
        // from Supabase (no special chars that need encoding).
        components.fragment = "access_token=\(session.accessToken)&refresh_token=\(session.refreshToken)&token_type=bearer&expires_in=\(Int(session.expiresIn))&type=embed"
        return components.url
    }
}

/// Bare WKWebView in a UIViewRepresentable. We only need to load once on
/// first presentation; subsequent navigations (link clicks, form posts)
/// happen inside the webview itself.
private struct WebViewRepresentable: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.websiteDataStore = .default()        // shares cookies + storage across tabs

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // No-op. We don't reload on session refresh — the web app's own
        // Supabase client handles token rotation in cookies/localStorage
        // once the initial session is established.
    }
}
