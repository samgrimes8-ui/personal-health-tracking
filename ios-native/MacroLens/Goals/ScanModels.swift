import Foundation

/// Body-composition shape that ScanService.extractBodyScan parses out
/// of an InBody / DEXA scan image. Mirrors the JSON contract in
/// src/lib/ai.js:478-525 — every field is optional because the model
/// returns null for any value it can't read off the scan. Stored as
/// metric (kg) regardless of whether the scan printed lbs; the prompt
/// instructs the model to convert.
///
/// Field set is intentionally a one-to-one mirror of the public.checkins
/// columns, so saveCheckin can splat the values straight into the row
/// without renaming. Keeps the code path linear: extract → auto-fill →
/// save → list.
struct BodyScanExtract: Codable, Hashable {
    var scan_type: String?            // "inbody" | "dexa"
    var scan_date: String?            // YYYY-MM-DD

    // Headline numbers (also auto-fill the basic weigh-in inputs)
    var weight_kg: Double?
    var body_fat_pct: Double?
    var muscle_mass_kg: Double?

    // Body composition
    var body_fat_mass_kg: Double?
    var lean_body_mass_kg: Double?
    var bone_mass_kg: Double?
    var total_body_water_kg: Double?
    var intracellular_water_kg: Double?
    var extracellular_water_kg: Double?
    var ecw_tbw_ratio: Double?
    var protein_kg: Double?
    var minerals_kg: Double?
    var bmr: Int?
    var bmi: Double?
    var inbody_score: Int?
    var visceral_fat_level: Double?
    var body_cell_mass_kg: Double?
    var smi: Double?

    // Segmental lean mass — kg + % of normal per limb
    var seg_lean_left_arm_kg: Double?
    var seg_lean_right_arm_kg: Double?
    var seg_lean_trunk_kg: Double?
    var seg_lean_left_leg_kg: Double?
    var seg_lean_right_leg_kg: Double?
    var seg_lean_left_arm_pct: Double?
    var seg_lean_right_arm_pct: Double?
    var seg_lean_trunk_pct: Double?
    var seg_lean_left_leg_pct: Double?
    var seg_lean_right_leg_pct: Double?

    // DEXA-specific
    var bone_mineral_density: Double?
    var t_score: Double?
    var z_score: Double?
    var android_fat_pct: Double?
    var gynoid_fat_pct: Double?
    var android_gynoid_ratio: Double?
    var vat_area_cm2: Double?
}
