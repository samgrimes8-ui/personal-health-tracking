import SwiftUI

/// Provider channel editor. Shown to users whose loaded `state.profile`
/// has a provider/admin role; lets them update name / specialty /
/// credentials / bio. Avatar upload is deferred to a follow-up since
/// it needs storage write to the provider-avatars bucket.
///
/// Read-source: state.profile (loaded by the Account tab worker).
/// Write-source: DBService.updateProfile, which patches only the
/// non-nil columns we send.
struct EditChannelSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var specialty: String = ""
    @State private var credentials: String = ""
    @State private var bio: String = ""
    @State private var saving: Bool = false
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    intro

                    field(label: "Display name",
                          placeholder: "Your full name",
                          text: $name)
                    field(label: "Specialty",
                          placeholder: "e.g. Sports nutrition, weight loss",
                          text: $specialty)
                    field(label: "Credentials",
                          placeholder: "e.g. RD, LD, MS, CSCS",
                          text: $credentials,
                          hint: "Comma-separated. Shown as chips on your provider card.")
                    bioField

                    if let saveError {
                        Text(saveError)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.red)
                    }

                    Button(action: save) {
                        HStack {
                            if saving { ProgressView().tint(Theme.accentFG) }
                            Text(saving ? "Saving…" : "Save profile")
                                .font(.system(size: 15, weight: .semibold))
                        }
                        .foregroundStyle(Theme.accentFG)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(Theme.accent, in: .rect(cornerRadius: 12))
                    }
                    .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    .opacity(name.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1)
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 40)
            }
            .background(Theme.bg)
            .navigationTitle("My channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.text3)
                }
            }
            .onAppear { hydrate() }
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Provider profile")
                .font(.system(size: 11, weight: .medium))
                .tracking(1.0)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            Text("This appears on your card in the Providers directory and on shared meal-plan pages.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
        }
    }

    private func field(label: String,
                       placeholder: String,
                       text: Binding<String>,
                       hint: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.text2)
            TextField(placeholder, text: text)
                .font(.system(size: 14))
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
            if let hint {
                Text(hint).font(.system(size: 11)).foregroundStyle(Theme.text3)
            }
        }
    }

    private var bioField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Bio")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.text2)
            TextEditor(text: $bio)
                .font(.system(size: 14))
                .frame(minHeight: 100)
                .padding(8)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                .scrollContentBackground(.hidden)
        }
    }

    private func hydrate() {
        guard let p = state.profile else { return }
        name = p.provider_name ?? ""
        specialty = p.provider_specialty ?? ""
        credentials = p.credentials ?? ""
        bio = p.provider_bio ?? ""
    }

    private func save() {
        saveError = nil
        saving = true
        let patch = ProfilePatch(
            providerName: name.trimmingCharacters(in: .whitespaces),
            providerBio: bio,
            providerSpecialty: specialty,
            providerSlug: nil,
            providerAvatarUrl: nil,
            credentials: credentials,
            hiddenTagPresets: nil
        )
        Task {
            do {
                try await DBService.updateProfile(patch)
                // Reflect locally so the next time they open the sheet
                // it shows what they just saved.
                if var p = state.profile {
                    p.provider_name = patch.providerName
                    p.provider_bio = patch.providerBio
                    p.provider_specialty = patch.providerSpecialty
                    p.credentials = patch.credentials
                    state.profile = p
                }
                // Reload directory so our own row reflects the update
                // when other workers later wire this view up. The
                // self-row is hidden from the list by ProvidersView.
                await state.providersLoadImpl()
                saving = false
                dismiss()
            } catch {
                saveError = error.localizedDescription
                saving = false
            }
        }
    }
}
