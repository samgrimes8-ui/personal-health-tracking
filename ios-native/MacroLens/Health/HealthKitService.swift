import Foundation
import HealthKit
import UIKit

/// HKHealthStore wrapper for the two-way Apple Health sync (push macros +
/// weight to HK, pull weight from HK into our checkins history).
///
/// Why a dedicated service rather than calling HK from views/AppState:
///   - HK auth requests are slow + ask the system for an alert; want one
///     place that knows how to phrase + verify them per permission group.
///   - Anchor management for pull queries needs UserDefaults persistence
///     keyed per user (multi-account on the same device must not bleed).
///   - Push/pull paths need the same "exclude our own writes" rules so
///     dedup stays consistent — colocate the predicates here.
///
/// Dedup contract (mirror of supabase/migrations/healthkit_columns.sql):
///   - Every PUSH sample carries metadata identifying the source row in
///     our DB (macrolens_meal_id for meal_log, macrolens_metric_id for
///     checkins). Captured sample.uuid is stored on the DB row so we
///     can match a pulled-back sample to the row that originated it.
///   - Every PULL filters out samples produced by HKSource.default()
///     (us) AND samples carrying our metadata keys. The unique partial
///     index on checkins.healthkit_uuid is the last line of defense.
///
/// Background delivery is intentionally NOT wired (out-of-scope for v1;
/// adds entitlement + review complexity). Pulls run on:
///   1. Toggle-enable (HealthSettingsSection)
///   2. App foreground (.onAppear in SignedInShell)
@MainActor
final class HealthKitService {
    static let shared = HealthKitService()

    private let store = HKHealthStore()

    /// Whether HK is even present (false on iPad / Mac Catalyst etc.).
    nonisolated var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    enum Permission {
        case pushMacros, pushWeight, pullWeight
    }

    enum HealthKitError: LocalizedError {
        case notAvailable
        case writeAuthDenied
        case sampleSaveFailed(String)

        var errorDescription: String? {
            switch self {
            case .notAvailable:           return "HealthKit isn't available on this device."
            case .writeAuthDenied:        return "Permission denied. Open Settings → Privacy → Health → Macro Lens to enable."
            case .sampleSaveFailed(let m): return "Couldn't save to Apple Health: \(m)"
            }
        }
    }

    // ─── Authorization ─────────────────────────────────────────────────

    /// Requests authorization for one permission group. For write-only
    /// permissions, the returned bool reflects whether the user granted
    /// at least one of the requested types — Apple's own Health app
    /// pattern. For read permissions HK never reveals the answer (privacy
    /// by design), so we optimistically return true and let the pull
    /// query land empty if it's actually denied.
    func requestAuthorization(for permission: Permission) async throws -> Bool {
        guard isAvailable else { throw HealthKitError.notAvailable }
        let (write, read) = types(for: permission)
        try await store.requestAuthorization(toShare: write, read: read)
        guard !write.isEmpty else { return true }
        // sharingAuthorized only returns truthfully for write types — for
        // read types the system always reports notDetermined to protect
        // user privacy, so we never branch on it.
        for type in write {
            if store.authorizationStatus(for: type) == .sharingAuthorized {
                return true
            }
        }
        return false
    }

    private func types(for permission: Permission) -> (write: Set<HKSampleType>, read: Set<HKObjectType>) {
        switch permission {
        case .pushMacros:
            let w: Set<HKSampleType> = [
                HKQuantityType(.dietaryEnergyConsumed),
                HKQuantityType(.dietaryProtein),
                HKQuantityType(.dietaryCarbohydrates),
                HKQuantityType(.dietaryFatTotal)
            ]
            return (w, [])
        case .pushWeight:
            return ([HKQuantityType(.bodyMass)], [])
        case .pullWeight:
            return ([], [HKQuantityType(.bodyMass)])
        }
    }

    /// Best-effort deep link into Settings → Privacy → Health → Macro Lens.
    /// iOS doesn't expose a per-app Health pane URL, so this lands the
    /// user in the app's general Settings page where they can tap into
    /// Health permissions from there.
    func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }

    // ─── Push: meal macros ─────────────────────────────────────────────

    /// Writes the four dietary samples (kcal, protein, carbs, fat) for a
    /// single meal_log row. start == end == the meal's logged timestamp
    /// — Apple Health treats zero-duration consumption as a single
    /// instant and that matches how we surface meals in the dashboard.
    func pushMealMacros(
        mealLogId: String,
        kcal: Double,
        protein: Double,
        carbs: Double,
        fat: Double,
        at: Date
    ) async throws {
        guard isAvailable else { throw HealthKitError.notAvailable }
        let metadata: [String: Any] = ["macrolens_meal_id": mealLogId]
        let samples: [HKQuantitySample] = [
            HKQuantitySample(
                type: HKQuantityType(.dietaryEnergyConsumed),
                quantity: HKQuantity(unit: .kilocalorie(), doubleValue: kcal),
                start: at, end: at, metadata: metadata
            ),
            HKQuantitySample(
                type: HKQuantityType(.dietaryProtein),
                quantity: HKQuantity(unit: .gram(), doubleValue: protein),
                start: at, end: at, metadata: metadata
            ),
            HKQuantitySample(
                type: HKQuantityType(.dietaryCarbohydrates),
                quantity: HKQuantity(unit: .gram(), doubleValue: carbs),
                start: at, end: at, metadata: metadata
            ),
            HKQuantitySample(
                type: HKQuantityType(.dietaryFatTotal),
                quantity: HKQuantity(unit: .gram(), doubleValue: fat),
                start: at, end: at, metadata: metadata
            )
        ]
        do {
            try await store.save(samples)
        } catch {
            throw HealthKitError.sampleSaveFailed(error.localizedDescription)
        }
    }

    // ─── Push: weight ──────────────────────────────────────────────────

    /// Writes one bodyMass sample for a checkins row. Returns the HK
    /// sample UUID string — caller writes it back to checkins.healthkit_uuid
    /// so the next pull dedupes cleanly via the unique partial index.
    @discardableResult
    func pushWeight(checkinId: String, kg: Double, at: Date) async throws -> String {
        guard isAvailable else { throw HealthKitError.notAvailable }
        let metadata: [String: Any] = ["macrolens_metric_id": checkinId]
        let sample = HKQuantitySample(
            type: HKQuantityType(.bodyMass),
            quantity: HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: kg),
            start: at, end: at, metadata: metadata
        )
        do {
            try await store.save(sample)
        } catch {
            throw HealthKitError.sampleSaveFailed(error.localizedDescription)
        }
        return sample.uuid.uuidString
    }

    // ─── Pull: weights ─────────────────────────────────────────────────

    struct PulledWeight {
        let uuid: String
        let kg: Double
        let recordedAt: Date
    }

    /// Runs HKAnchoredObjectQuery for bodyMass. On first call (anchor nil)
    /// the predicate window is the last 12 months — that's the brief's
    /// backfill spec. Subsequent calls use the persisted anchor and pull
    /// only what's new since last sync.
    ///
    /// Caller is responsible for the DB-side dedup (SELECT id WHERE
    /// healthkit_uuid = …) before insert; this method only filters the
    /// HK-side noise (our own writes).
    func pullWeights(userId: String) async throws -> [PulledWeight] {
        guard isAvailable else { throw HealthKitError.notAvailable }
        let bodyMass = HKQuantityType(.bodyMass)
        let anchorKey = "macrolens_hk_weight_anchor_\(userId)"
        let anchor: HKQueryAnchor? = {
            guard let data = UserDefaults.standard.data(forKey: anchorKey) else { return nil }
            return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
        }()

        // 12-month backfill window only matters on first sync (anchor
        // nil). Once the anchor is persisted HK delivers exactly the
        // delta and the predicate is just a no-op floor.
        let twelveMonthsAgo = Calendar.current.date(byAdding: .month, value: -12, to: Date()) ?? Date()
        let timeRange = HKQuery.predicateForSamples(withStart: twelveMonthsAgo, end: nil, options: [])

        // Exclude our own writes (primary defense) — HKSource.default()
        // resolves to this app's HK source at runtime.
        let mySource = HKQuery.predicateForObjects(from: [HKSource.default()])
        let notMySource = NSCompoundPredicate(notPredicateWithSubpredicate: mySource)

        // Belt-and-suspenders: exclude any sample carrying our metadata
        // key (covers re-installs where HKSource.default() isn't the same).
        let hasMyMetadata = HKQuery.predicateForObjects(withMetadataKey: "macrolens_metric_id")
        let noMyMetadata = NSCompoundPredicate(notPredicateWithSubpredicate: hasMyMetadata)

        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            timeRange, notMySource, noMyMetadata
        ])

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[PulledWeight], Error>) in
            let query = HKAnchoredObjectQuery(
                type: bodyMass,
                predicate: predicate,
                anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samples, _, newAnchor, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                if let newAnchor,
                   let data = try? NSKeyedArchiver.archivedData(
                    withRootObject: newAnchor, requiringSecureCoding: true
                   ) {
                    UserDefaults.standard.set(data, forKey: anchorKey)
                }
                let pulled: [PulledWeight] = (samples ?? [])
                    .compactMap { $0 as? HKQuantitySample }
                    .map { sample in
                        PulledWeight(
                            uuid: sample.uuid.uuidString,
                            kg: sample.quantity.doubleValue(for: .gramUnit(with: .kilo)),
                            recordedAt: sample.startDate
                        )
                    }
                cont.resume(returning: pulled)
            }
            store.execute(query)
        }
    }

    // ─── Toggle persistence ────────────────────────────────────────────
    //
    // Per-user toggle state. Multi-account on the same device must not
    // bleed (sign out + sign in as someone else and HK keeps using the
    // first user's preferences if we keyed globally).

    static func toggleKey(_ permission: Permission, userId: String) -> String {
        switch permission {
        case .pushMacros: return "macrolens_hk_push_macros_\(userId)"
        case .pushWeight: return "macrolens_hk_push_weight_\(userId)"
        case .pullWeight: return "macrolens_hk_pull_weight_\(userId)"
        }
    }

    static func isToggleOn(_ permission: Permission, userId: String) -> Bool {
        UserDefaults.standard.bool(forKey: toggleKey(permission, userId: userId))
    }

    static func setToggle(_ permission: Permission, userId: String, on: Bool) {
        UserDefaults.standard.set(on, forKey: toggleKey(permission, userId: userId))
    }
}
