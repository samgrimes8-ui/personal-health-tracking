import SwiftUI
import AuthenticationServices

/// Sign-in / sign-up / forgot-password tabbed screen. Email + password
/// only — Google native sign-in is a separate follow-up (logged in
/// TODO.md). UX mirrors the web `pages/auth.js` for muscle memory.
struct AuthView: View {
    enum Tab: String { case signIn, signUp, forgot }

    @Environment(AuthManager.self) private var auth
    @State private var tab: Tab = .signIn
    @State private var email: String = ""
    @State private var password: String = ""
    @State private var confirmPassword: String = ""
    @State private var loading = false
    @State private var error: String?
    @State private var success: String?
    @FocusState private var keyboardFocused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer().frame(height: 60)

                // Logo block
                VStack(spacing: 4) {
                    Text("MacroLens")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                    Text("AI nutrition tracker")
                        .font(.system(size: 11, weight: .medium))
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(Theme.text3)
                }
                .padding(.bottom, 28)

                // Card
                VStack(spacing: 0) {
                    tabBar

                    if let error {
                        errorBanner(error)
                    }
                    if let success {
                        successBanner(success)
                    }

                    switch tab {
                    case .signIn:    signInForm
                    case .signUp:    signUpForm
                    case .forgot:    forgotForm
                    }
                }
                .padding(28)
                .frame(maxWidth: 420)
                .background(Theme.bg2, in: .rect(cornerRadius: 20))
                .overlay(.linearGradient(colors: [Theme.border2, Theme.border], startPoint: .top, endPoint: .bottom).opacity(0.6),
                         in: .rect(cornerRadius: 20).stroke(lineWidth: 0))
                .padding(.horizontal, 20)

                Spacer(minLength: 40)
            }
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if keyboardFocused {
                    Button("Done") { keyboardFocused = false }
                }
            }
        }
    }

    // MARK: - Tab bar

    private var tabBar: some View {
        HStack(spacing: 4) {
            tabButton("Sign in", tab: .signIn)
            tabButton("Create account", tab: .signUp)
        }
        .padding(4)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
        .padding(.bottom, 20)
    }

    private func tabButton(_ label: String, tab target: Tab) -> some View {
        Button {
            tab = target
            error = nil
        } label: {
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(tab == target ? Theme.text : Theme.text3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(tab == target ? Theme.bg4 : .clear, in: .rect(cornerRadius: 8))
        }
    }

    // MARK: - Forms

    private var signInForm: some View {
        VStack(spacing: 14) {
            field("Email", text: $email, type: .email)
            field("Password", text: $password, type: .password)

            HStack {
                Spacer()
                Button("Forgot password?") {
                    tab = .forgot
                    error = nil
                }
                .font(.system(size: 12))
                .foregroundStyle(Theme.accent)
            }
            .padding(.bottom, 4)

            primaryButton("Sign in", loading: loading) { Task { await handleSignIn() } }

            HStack(spacing: 10) {
                line()
                Text("or")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
                line()
            }
            .padding(.vertical, 4)

            if Config.appleSignInEnabled {
                appleButton
            }
            googleButton
        }
    }

    @ViewBuilder
    private var appleButton: some View {
        SignInWithAppleButton(
            onRequest: { request in
                auth.configureAppleRequest(request)
                error = nil
            },
            onCompletion: { result in
                Task { await handleApple(result) }
            }
        )
        .signInWithAppleButtonStyle(.black)
        .frame(height: 44)
        .clipShape(.rect(cornerRadius: 10))
    }

    private func line() -> some View {
        Rectangle().fill(Theme.border).frame(height: 1)
    }

    private var googleButton: some View {
        Button {
            Task { await handleGoogle() }
        } label: {
            HStack(spacing: 10) {
                if loading {
                    ProgressView().tint(Theme.text)
                } else {
                    googleLogo
                }
                Text("Continue with Google")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.text)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
        }
        .disabled(loading)
    }

    /// Single-color "G" stand-in. Drop a real four-color Google asset
    /// into Assets.xcassets later if we want the brand-correct logo —
    /// for now the SF Symbol reads clearly.
    private var googleLogo: some View {
        Image(systemName: "g.circle.fill")
            .resizable()
            .frame(width: 18, height: 18)
            .foregroundStyle(Color(hex: 0x4285F4))
    }

    private var signUpForm: some View {
        VStack(spacing: 14) {
            field("Email", text: $email, type: .email)
            field("Password", text: $password, type: .password, placeholder: "At least 6 characters")
            field("Confirm password", text: $confirmPassword, type: .password)
            primaryButton("Create account", loading: loading) { Task { await handleSignUp() } }
        }
    }

    private var forgotForm: some View {
        VStack(spacing: 14) {
            Text("Enter your email and we'll send you a link to reset your password.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
                .frame(maxWidth: .infinity, alignment: .leading)

            field("Email", text: $email, type: .email)
            primaryButton("Send reset link", loading: loading) { Task { await handleForgot() } }

            Button("← Back to sign in") {
                tab = .signIn
                error = nil
            }
            .font(.system(size: 12))
            .foregroundStyle(Theme.text3)
            .frame(maxWidth: .infinity)
            .padding(.top, 4)
        }
    }

    // MARK: - Field + button factories

    private enum FieldType { case email, password, plain }

    private func field(_ label: String, text: Binding<String>, type: FieldType, placeholder: String = "") -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
            Group {
                switch type {
                case .password:
                    SecureField(placeholder.isEmpty ? "••••••••" : placeholder, text: text)
                case .email:
                    TextField(placeholder.isEmpty ? "you@example.com" : placeholder, text: text)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                case .plain:
                    TextField(placeholder, text: text)
                }
            }
            .focused($keyboardFocused)
            .font(.system(size: 14))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 13).padding(.vertical, 11)
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
        }
    }

    private func primaryButton(_ label: String, loading: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                if loading {
                    ProgressView().tint(Theme.accentFG)
                }
                Text(loading ? "Working…" : label)
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(Theme.accentFG)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Theme.accent, in: .rect(cornerRadius: 10))
        }
        .disabled(loading)
        .opacity(loading ? 0.7 : 1.0)
    }

    private func errorBanner(_ msg: String) -> some View {
        Text(msg)
            .font(.system(size: 13))
            .foregroundStyle(Theme.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 13).padding(.vertical, 10)
            .background(Theme.red.opacity(0.1), in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.3), lineWidth: 1))
            .padding(.bottom, 14)
    }

    private func successBanner(_ msg: String) -> some View {
        Text(msg)
            .font(.system(size: 13))
            .foregroundStyle(Theme.green)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 13).padding(.vertical, 10)
            .background(Theme.green.opacity(0.1), in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.green.opacity(0.3), lineWidth: 1))
            .padding(.bottom, 14)
    }

    // MARK: - Actions

    private func handleSignIn() async {
        guard !email.isEmpty, !password.isEmpty else {
            error = "Please enter email and password"; return
        }
        loading = true; error = nil; success = nil
        do {
            try await auth.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password)
            // AuthManager.authStateChanges will route us to the shell.
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func handleSignUp() async {
        guard !email.isEmpty, password.count >= 6 else {
            error = "Password must be at least 6 characters"; return
        }
        guard password == confirmPassword else {
            error = "Passwords do not match"; return
        }
        loading = true; error = nil; success = nil
        do {
            try await auth.signUp(email: email.trimmingCharacters(in: .whitespaces), password: password)
            success = "Account created. Check your email to confirm, then sign in."
            tab = .signIn
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func handleForgot() async {
        guard !email.isEmpty else { error = "Please enter your email"; return }
        loading = true; error = nil; success = nil
        do {
            try await auth.sendPasswordReset(email: email.trimmingCharacters(in: .whitespaces))
            success = "Reset link sent. Check your email."
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func handleApple(_ result: Result<ASAuthorization, Error>) async {
        loading = true
        do {
            try await auth.handleAppleCompletion(result)
            // authStateChanges → SignedInShell.
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func handleGoogle() async {
        loading = true; error = nil; success = nil
        do {
            try await auth.signInWithGoogle()
            // authStateChanges → AppShell flips to SignedInShell.
        } catch {
            // ASWebAuthenticationSession surfaces user-cancel as an
            // error; squash that one so the form doesn't flash a
            // pointless "canceled" message.
            let nsErr = error as NSError
            let canceled = nsErr.domain == "com.apple.AuthenticationServices.WebAuthenticationSession"
                && nsErr.code == 1
            if !canceled {
                self.error = error.localizedDescription
            }
        }
        loading = false
    }
}
