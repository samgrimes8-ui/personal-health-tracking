import SwiftUI
import HealthKit

/// Apple Health card embedded in AccountView. Three independent toggles
/// — push macros, push weight, pull weight — each gated by an HKHealthStore
/// authorization request for the type(s) it touches.
///
/// Why per-toggle auth instead of one omnibus request: HK lets the user
/// approve types selectively, and our toggles map 1:1 to permission groups.
/// Asking for everything up front results in a wall-of-permissions sheet
/// that feels invasive when the user just wants weight sync.
///
/// On toggle-enable: request auth → if granted, persist toggle (per user)
/// + (for pull) kick off a backfill. On denial: revert the toggle and
/// surface a one-line hint linking to Settings.
struct HealthSettingsSection: View {
    @Environment(AppState.self) private var state
    @Environment(AuthManager.self) private var auth

    @State private var pushMacrosOn: Bool = false
    @State private var pushWeightOn: Bool = false
    @State private var pullWeightOn: Bool = false
    @State private var inFlight: HealthKitService.Permission?
    @State private var lastDenied: HealthKitService.Permission?
    @State private var pulling: Bool = false
    @State private var pullStatus: String?
    @State private var pullError: String?

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                cardLabel("Apple Health")

                if !HealthKitService.shared.isAvailable {
                    Text("HealthKit isn't available on this device.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                } else if let userId {
                    toggleRow(
                        title: "Sync macros to Apple Health",
                        subtitle: "Each meal you log writes calories, protein, carbs, and fat.",
                        permission: .pushMacros,
                        isOn: $pushMacrosOn,
                        userId: userId
                    )
                    Divider().background(Theme.border).padding(.vertical, 2)
                    toggleRow(
                        title: "Sync weight to Apple Health",
                        subtitle: "Each weigh-in you record gets pushed to Health.",
                        permission: .pushWeight,
                        isOn: $pushWeightOn,
                        userId: userId
                    )
                    Divider().background(Theme.border).padding(.vertical, 2)
                    toggleRow(
                        title: "Read weight from Apple Health",
                        subtitle: "On first enable, the last 12 months of weight history will be imported.",
                        permission: .pullWeight,
                        isOn: $pullWeightOn,
                        userId: userId
                    )

                    if pulling {
                        HStack(spacing: 8) {
                            ProgressView().scaleEffect(0.7)
                            Text("Importing weight history…")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.text3)
                        }
                    } else if let pullStatus {
                        Text(pullStatus)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                    }
                    if let pullError {
                        Text(pullError)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let denied = lastDenied {
                        deniedHint(for: denied)
                    }
                } else {
                    Text("Sign in to enable Apple Health sync.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }
            }
        }
        .onAppear { hydrateToggles() }
    }

    // MARK: - Toggle row

    @ViewBuilder
    private func toggleRow(
        title: String,
        subtitle: String,
        permission: HealthKitService.Permission,
        isOn: Binding<Bool>,
        userId: String
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.text)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if inFlight == permission {
                ProgressView()
            } else {
                Toggle("", isOn: isOn)
                    .labelsHidden()
                    .tint(Theme.accent)
                    .onChange(of: isOn.wrappedValue) { _, newValue in
                        Task { await handleToggle(permission, on: newValue, userId: userId) }
                    }
            }
        }
    }

    // MARK: - Toggle handling

    private func handleToggle(
        _ permission: HealthKitService.Permission,
        on: Bool,
        userId: String
    ) async {
        // OFF is a local-only operation — HK has no "revoke" surface for
        // an app to call programmatically (the user revokes from Settings).
        // We just stop pushing/pulling.
        if !on {
            HealthKitService.setToggle(permission, userId: userId, on: false)
            lastDenied = nil
            return
        }
        inFlight = permission
        defer { inFlight = nil }
        do {
            let granted = try await HealthKitService.shared.requestAuthorization(for: permission)
            // Read permissions can't be verified after the prompt (HK
            // privacy rule), so we trust the user's tap-through and let
            // the first pull either succeed or come back empty.
            if granted || permission == .pullWeight {
                HealthKitService.setToggle(permission, userId: userId, on: true)
                lastDenied = nil
                if permission == .pullWeight {
                    await runPull(userId: userId)
                }
                if permission == .pushMacros {
                    // Backfill the last 90 days of daily totals to HK so
                    // the user sees their MacroLens history immediately
                    // after enabling. Idempotent — pushDailyMacroTotal
                    // replaces samples by metadata key on every write.
                    try? await state.backfillDailyMacroTotals(userId: userId, days: 90)
                }
            } else {
                revertToggle(permission)
                lastDenied = permission
            }
        } catch {
            revertToggle(permission)
            lastDenied = permission
        }
    }

    private func revertToggle(_ permission: HealthKitService.Permission) {
        switch permission {
        case .pushMacros: pushMacrosOn = false
        case .pushWeight: pushWeightOn = false
        case .pullWeight: pullWeightOn = false
        }
    }

    private func runPull(userId: String) async {
        pulling = true
        pullError = nil
        defer { pulling = false }
        do {
            let pulled = try await HealthKitService.shared.pullWeights(userId: userId)
            var inserted = 0
            for sample in pulled {
                let didInsert = try await DBService.insertHealthKitWeight(
                    kg: sample.kg,
                    recordedAt: sample.recordedAt,
                    healthkitUUID: sample.uuid
                )
                if didInsert { inserted += 1 }
            }
            pullStatus = "Imported \(inserted) weight \(inserted == 1 ? "entry" : "entries") from Apple Health."
            // Refresh Goals data so the chart picks up the new rows.
            await state.loadGoals()
        } catch {
            pullError = "Couldn't read from Apple Health: \(error.localizedDescription)"
        }
    }

    // MARK: - Denied hint

    private func deniedHint(for permission: HealthKitService.Permission) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(deniedHintLabel(for: permission))
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                HealthKitService.shared.openSystemSettings()
            } label: {
                Text("Open Settings →")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.accent)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.bg3, in: .rect(cornerRadius: 8))
    }

    private func deniedHintLabel(for permission: HealthKitService.Permission) -> String {
        switch permission {
        case .pushMacros: return "Macro Lens needs permission to write nutrition data. Enable it in Settings → Privacy → Health → Macro Lens."
        case .pushWeight: return "Macro Lens needs permission to write weight. Enable it in Settings → Privacy → Health → Macro Lens."
        case .pullWeight: return "Macro Lens needs permission to read weight. Enable it in Settings → Privacy → Health → Macro Lens."
        }
    }

    // MARK: - Hydration

    private func hydrateToggles() {
        guard let userId else { return }
        pushMacrosOn = HealthKitService.isToggleOn(.pushMacros, userId: userId)
        pushWeightOn = HealthKitService.isToggleOn(.pushWeight, userId: userId)
        pullWeightOn = HealthKitService.isToggleOn(.pullWeight, userId: userId)
    }

    private var userId: String? {
        if case .signedIn(let user) = auth.state {
            return user.id.uuidString
        }
        return nil
    }

    private func cardLabel(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 12, weight: .medium))
            .tracking(1.0)
            .textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }
}
