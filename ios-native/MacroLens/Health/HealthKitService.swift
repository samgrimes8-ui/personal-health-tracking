import Foundation
import HealthKit
import UIKit
import os

/// HKHealthStore wrapper for the two-way Apple Health sync.
///
/// Why a dedicated service rather than calling HK from views/AppState:
///   - HK auth requests are slow + ask the system for an alert; want one
///     place that knows how to phrase + verify them per permission group.
///   - Anchor management for pull queries needs UserDefaults persistence
///     keyed per user (multi-account on the same device must not bleed).
///   - Push/pull paths need the same "exclude our own writes" rules so
///     dedup stays consistent — colocate the predicates here.
///
/// MACROS — daily-total model (NOT per-meal):
///   - For each calendar day with non-zero macros, we maintain exactly
///     four HKQuantitySamples (kcal, protein, carbs, fat). Each sample
///     carries metadata `macrolens_daily_total: "YYYY-MM-DD"` so we can
///     find + replace the day's samples atomically on every recompute.
///   - On every meal_log insert / update / delete we recompute that
///     day's totals from the DB and call `pushDailyMacroTotal` (or
///     `clearDailyMacroTotal` if zero). MacroLens-as-source-of-truth.
///   - On first install of the new build, a one-shot migration wipes
///     legacy per-meal samples (metadata `macrolens_meal_id`) and
///     backfills the last 90 days under the daily-total model. See
///     `deleteLegacyPerMealSamples` + AppState migration runner.
///
/// WEIGHT — per-row model:
///   - Push: one bodyMass sample per checkins row, metadata
///     `macrolens_metric_id`. Sample UUID stored back on the row for
///     pull-side dedup via the unique partial index.
///   - Pull: HKAnchoredObjectQuery, anchor persisted per-user. Filters
///     out our own writes via HKSource.default() + metadata key.
///
/// Background delivery IS wired now (v2): HKObserverQuery + enableBackgroundDelivery
/// for bodyMass means iOS wakes the app within seconds of a new weight
/// being added in HK (manual entry, smart scale, etc.) and runs the
/// pull. See `enableBackgroundWeightSync`.
///
/// Sync triggers, in order of latency:
///   1. Background delivery (HKObserverQuery) — seconds after change
///   2. App foreground (scenePhase → .active in AppShell) — every fg
///   3. Toggle-enable (HealthSettingsSection)
///   4. Every meal_log mutation (logMeal / updateMealLogEntry / delete) — macros only
///
/// Debug logging: Console.app or `log stream --predicate 'subsystem == "app.macrolens.native"'`
@MainActor
final class HealthKitService {
    static let shared = HealthKitService()

    private let store = HKHealthStore()

    /// Subsystem-tagged logger so the user can filter HK events from
    /// general app noise via Console.app or the `log stream` CLI.
    /// Public on purpose — AppShell + HealthMacroSync use the same
    /// channel so a single filter captures the whole HK pipeline.
    static let log = Logger(subsystem: "app.macrolens.native", category: "HealthKit")

    /// Whether the in-memory observer query is registered for this
    /// app launch. enableBackgroundDelivery is persistent across
    /// launches (iOS-side), but the observer query has to be
    /// re-registered every launch to handle wakes during that launch.
    private var weightObserverActive = false

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

    // ─── Push: daily macro totals ──────────────────────────────────────
    //
    // The four dietary types we touch. Pulled out as a constant because
    // the migration path (delete legacy + delete daily-total + delete on
    // clear) iterates over the same set in three places.
    private static let dietaryTypes: [HKQuantityType] = [
        HKQuantityType(.dietaryEnergyConsumed),
        HKQuantityType(.dietaryProtein),
        HKQuantityType(.dietaryCarbohydrates),
        HKQuantityType(.dietaryFatTotal)
    ]

    /// Replace-on-write: deletes any existing MacroLens samples in the
    /// day's time range (both new daily-total and legacy per-meal),
    /// then writes 4 fresh daily-total samples. The compound delete
    /// predicate makes the push self-healing — it cleans up legacy
    /// per-meal samples that iCloud might have resurrected from another
    /// device + double-pushed daily totals from a v1 push that didn't
    /// match metadata cleanly.
    ///
    /// `dateKey` MUST be `YYYY-MM-DD` in the user's local TZ — that's
    /// what the migration writes too, so the same key matches across
    /// reads and writes regardless of process restart.
    ///
    /// `start`/`end` are the sample times shown in HK (start = local
    /// midnight; end = `Date()` for today, end-of-day for past dates).
    /// `dayStart`/`dayEnd` define the delete window — usually
    /// [local-midnight, next-midnight) so we catch any sample whose
    /// start is anywhere in the day in user's TZ.
    func pushDailyMacroTotal(
        dateKey: String,
        start: Date,
        end: Date,
        dayStart: Date,
        dayEnd: Date,
        kcal: Double,
        protein: Double,
        carbs: Double,
        fat: Double
    ) async throws {
        guard isAvailable else { throw HealthKitError.notAvailable }
        try await clearDailyMacroTotal(dateKey: dateKey, dayStart: dayStart, dayEnd: dayEnd)
        let metadata: [String: Any] = ["macrolens_daily_total": dateKey]
        let samples: [HKQuantitySample] = [
            HKQuantitySample(
                type: HKQuantityType(.dietaryEnergyConsumed),
                quantity: HKQuantity(unit: .kilocalorie(), doubleValue: kcal),
                start: start, end: end, metadata: metadata
            ),
            HKQuantitySample(
                type: HKQuantityType(.dietaryProtein),
                quantity: HKQuantity(unit: .gram(), doubleValue: protein),
                start: start, end: end, metadata: metadata
            ),
            HKQuantitySample(
                type: HKQuantityType(.dietaryCarbohydrates),
                quantity: HKQuantity(unit: .gram(), doubleValue: carbs),
                start: start, end: end, metadata: metadata
            ),
            HKQuantitySample(
                type: HKQuantityType(.dietaryFatTotal),
                quantity: HKQuantity(unit: .gram(), doubleValue: fat),
                start: start, end: end, metadata: metadata
            )
        ]
        do {
            try await store.save(samples)
        } catch {
            throw HealthKitError.sampleSaveFailed(error.localizedDescription)
        }
    }

    /// Self-healing daily-total cleanup. Deletes anything we wrote that
    /// falls within [dayStart, dayEnd) — that catches:
    ///   - daily-total samples for this dateKey (current model)
    ///   - daily-total samples whose dateKey was different (e.g. TZ
    ///     change between writes — predicate matches by metadata key
    ///     existence, not specific value)
    ///   - legacy per-meal samples (metadata.macrolens_meal_id) within
    ///     this day, which the v1 migration may have missed if iCloud
    ///     re-synced them from another device
    /// HK enforces own-source ownership on delete so we never touch
    /// the user's other-app data.
    func clearDailyMacroTotal(dateKey: String, dayStart: Date, dayEnd: Date) async throws {
        guard isAvailable else { return }
        let timeRange = HKQuery.predicateForSamples(
            withStart: dayStart, end: dayEnd, options: [.strictStartDate]
        )
        let isDailyTotal = HKQuery.predicateForObjects(withMetadataKey: "macrolens_daily_total")
        let isLegacyMeal = HKQuery.predicateForObjects(withMetadataKey: "macrolens_meal_id")
        let ours = NSCompoundPredicate(orPredicateWithSubpredicates: [isDailyTotal, isLegacyMeal])
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [timeRange, ours])
        for type in Self.dietaryTypes {
            // Returns success+count=0 if nothing matched — no exception
            // for empty deletes, so try? swallows transient auth issues.
            _ = try? await store.deleteObjects(of: type, predicate: predicate)
        }
    }

    /// Migration helper: wipes ALL legacy per-meal samples we wrote in
    /// the previous build. Predicate matches "any value present" for
    /// the legacy `macrolens_meal_id` metadata key. HK enforces
    /// own-source ownership so we can't nuke samples the user created
    /// in another app.
    func deleteLegacyPerMealSamples() async throws {
        guard isAvailable else { return }
        let predicate = HKQuery.predicateForObjects(withMetadataKey: "macrolens_meal_id")
        for type in Self.dietaryTypes {
            _ = try? await store.deleteObjects(of: type, predicate: predicate)
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
    /// Prefer `pullWeightsWithFallback` for normal use — it adds the
    /// HKSampleQuery safety net for retroactively-dated samples that
    /// HK's anchor logic can miss.
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
                Self.log.info("pullWeights anchored returned \(pulled.count, privacy: .public) sample(s)")
                cont.resume(returning: pulled)
            }
            store.execute(query)
        }
    }

    /// pullWeights with a safety net: if the anchored query returns
    /// nothing AND we haven't synced in over an hour, also runs an
    /// HKSampleQuery for the last 24h. Catches:
    ///   - retroactively-dated samples that HK's anchor logic might
    ///     skip (samples added now with start_date in the past)
    ///   - the case where the persisted anchor got corrupted/lost
    ///   - first-launch-after-update where the anchor blob shape
    ///     changed and decode silently returned nil
    /// The 24h window is a deliberate compromise — wide enough to
    /// catch "I added today's morning weigh-in this evening", narrow
    /// enough to keep the dedup query cheap (the partial unique index
    /// on healthkit_uuid handles any duplicates from the union of
    /// anchored + sample queries).
    func pullWeightsWithFallback(userId: String) async throws -> [PulledWeight] {
        guard isAvailable else { throw HealthKitError.notAvailable }
        let lastSyncKey = "macrolens_hk_weight_last_sync_\(userId)"
        let primary = try await pullWeights(userId: userId)
        if !primary.isEmpty {
            UserDefaults.standard.set(Date(), forKey: lastSyncKey)
            return primary
        }
        let lastSync = UserDefaults.standard.object(forKey: lastSyncKey) as? Date
        let staleThreshold = Date().addingTimeInterval(-3600)
        let isStale = lastSync == nil || lastSync! < staleThreshold
        guard isStale else {
            // Recent successful sync + nothing new — anchored is the
            // source of truth, no fallback needed.
            return []
        }
        Self.log.info("pullWeights anchored empty + stale (last=\(lastSync?.description ?? "never", privacy: .public)) — running 24h fallback")
        let fallback = try await pullWeightsLast24Hours()
        UserDefaults.standard.set(Date(), forKey: lastSyncKey)
        Self.log.info("pullWeights fallback returned \(fallback.count, privacy: .public) sample(s)")
        return fallback
    }

    /// Bypass the anchor — straight HKSampleQuery over the last 24h
    /// with the same source/metadata exclusions as the anchored path.
    /// Caller dedupes on the DB side via the unique partial index, so
    /// it's safe to also include samples the anchored query already
    /// surfaced.
    private func pullWeightsLast24Hours() async throws -> [PulledWeight] {
        let bodyMass = HKQuantityType(.bodyMass)
        let twentyFourHoursAgo = Date().addingTimeInterval(-86400)
        let timeRange = HKQuery.predicateForSamples(withStart: twentyFourHoursAgo, end: nil, options: [])
        let mySource = HKQuery.predicateForObjects(from: [HKSource.default()])
        let notMySource = NSCompoundPredicate(notPredicateWithSubpredicate: mySource)
        let hasMyMetadata = HKQuery.predicateForObjects(withMetadataKey: "macrolens_metric_id")
        let noMyMetadata = NSCompoundPredicate(notPredicateWithSubpredicate: hasMyMetadata)
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            timeRange, notMySource, noMyMetadata
        ])
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[PulledWeight], Error>) in
            let query = HKSampleQuery(
                sampleType: bodyMass,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: nil
            ) { _, samples, error in
                if let error {
                    cont.resume(throwing: error)
                    return
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

    // ─── Background delivery (HKObserverQuery) ─────────────────────────

    /// Wires up background delivery so iOS wakes the app within seconds
    /// of any new bodyMass sample. Composed of:
    ///   - `enableBackgroundDelivery` — persistent across app launches.
    ///     iOS keeps the registration even after the app is killed.
    ///   - `HKObserverQuery` — registered fresh each launch. Handles
    ///     wakes during this app session (cold launch from background
    ///     wake re-runs this method via the AppShell .task hook).
    ///
    /// The observer's update handler MUST call its `completionHandler`
    /// when finished, otherwise iOS deprioritises future updates. We
    /// run the pull + insert and call the handler at the end.
    ///
    /// Idempotent: subsequent calls within the same launch no-op via
    /// the `weightObserverActive` flag.
    func enableBackgroundWeightSync(userId: String) async throws {
        guard isAvailable else { return }
        guard !weightObserverActive else {
            Self.log.debug("enableBackgroundWeightSync skipped — already active this launch")
            return
        }
        let bodyMass = HKQuantityType(.bodyMass)
        do {
            try await store.enableBackgroundDelivery(for: bodyMass, frequency: .immediate)
            Self.log.info("enableBackgroundDelivery succeeded for bodyMass")
        } catch {
            Self.log.error("enableBackgroundDelivery failed: \(error.localizedDescription, privacy: .public)")
            // Carry on — the observer query alone still works for
            // foreground-active app sessions.
        }
        let query = HKObserverQuery(sampleType: bodyMass, predicate: nil) { [weak self] _, completionHandler, error in
            // Capture self locally so the Task closure isn't holding
            // the actor-isolated reference across hops.
            if let error {
                HealthKitService.log.error("HKObserverQuery error: \(error.localizedDescription, privacy: .public)")
                completionHandler()
                return
            }
            guard let self else {
                completionHandler()
                return
            }
            HealthKitService.log.info("HKObserverQuery fired (userId=\(userId, privacy: .public))")
            Task {
                do {
                    let pulled = try await self.pullWeightsWithFallback(userId: userId)
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
                    HealthKitService.log.info("Observer-triggered pull inserted \(inserted, privacy: .public) checkin(s)")
                } catch {
                    HealthKitService.log.error("Observer pull failed: \(error.localizedDescription, privacy: .public)")
                }
                // MUST call completion or iOS deprioritises future
                // updates for this observer.
                completionHandler()
            }
        }
        store.execute(query)
        weightObserverActive = true
        Self.log.info("HKObserverQuery registered for bodyMass")
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
