import Foundation

/// Pure date helpers for the planner. The web app does all of this with
/// the local-time `Date` constructor and a `'YYYY-MM-DD'` string at the
/// edges; we mirror that here with explicit components so we never run
/// into a UTC drift bug when crossing midnight (the same issue that
/// `addPlannerMeal` in db.js calls out).
enum PlannerDateMath {
    /// Web convention: weeks start on Sunday. `weekday` 1=Sunday, 7=Saturday.
    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = .current
        c.firstWeekday = 1
        return c
    }()

    static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = calendar
        f.timeZone = .current
        return f
    }()

    /// Parse a `YYYY-MM-DD` string into a midnight-local Date. Returns nil
    /// for malformed input.
    static func parse(_ ymd: String) -> Date? {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var c = DateComponents()
        c.year = parts[0]; c.month = parts[1]; c.day = parts[2]
        return calendar.date(from: c)
    }

    static func format(_ date: Date) -> String {
        dateFormatter.string(from: date)
    }

    /// Snap an arbitrary `YYYY-MM-DD` to the Sunday of its week. Returns
    /// the formatted string. nil if input can't be parsed.
    static func snapToSunday(_ ymd: String) -> String? {
        guard let d = parse(ymd) else { return nil }
        let weekday = calendar.component(.weekday, from: d)   // 1=Sun … 7=Sat
        let offset = -(weekday - 1)
        guard let sunday = calendar.date(byAdding: .day, value: offset, to: d) else { return nil }
        return format(sunday)
    }

    /// Sunday of *this* week, in local time.
    static func currentWeekStart() -> String {
        let today = format(Date())
        return snapToSunday(today) ?? today
    }

    /// Add `days` to a `YYYY-MM-DD`, returning the resulting `YYYY-MM-DD`.
    static func addDays(_ ymd: String, _ days: Int) -> String {
        guard let d = parse(ymd),
              let next = calendar.date(byAdding: .day, value: days, to: d) else { return ymd }
        return format(next)
    }

    /// Slot a planner row falls into (0=Sun..6=Sat). Prefers `actual_date`
    /// over `day_of_week` because older rows may have a stale weekday.
    static func slotIndex(for row: PlannerRow) -> Int? {
        if let ymd = row.actual_date, let d = parse(ymd) {
            return calendar.component(.weekday, from: d) - 1
        }
        return row.day_of_week
    }

    /// Day name for a slot (0=Sunday). Long form ("Sunday").
    static func dayName(_ idx: Int) -> String {
        ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][idx % 7]
    }

    /// "Mar 3 – Mar 9" for the week starting at `weekStart`.
    static func weekLabel(_ weekStart: String) -> String {
        guard let start = parse(weekStart),
              let end = calendar.date(byAdding: .day, value: 6, to: start) else { return weekStart }
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = .current
        f.setLocalizedDateFormatFromTemplate("MMM d")
        return "\(f.string(from: start)) – \(f.string(from: end))"
    }

    /// Friendly "Mar 3" style for a single date string.
    static func shortMonthDay(_ ymd: String) -> String {
        guard let d = parse(ymd) else { return ymd }
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = .current
        f.setLocalizedDateFormatFromTemplate("MMM d")
        return f.string(from: d)
    }

    /// "YYYY-MM-DD" for "today" in the user's local time.
    static func todayString() -> String {
        format(Date())
    }
}
