import { db } from '../db/database';
import { getOwnPlan } from './vacayService';

function generateDateRange(startDate: string, endDate: string): string[] {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  const dates: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 86400000) {
    const d = new Date(ms);
    dates.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return dates;
}

function getLockedDates(planId: number, startDate: string, endDate: string): Set<string> {
  const plan = db.prepare('SELECT block_weekends, weekend_days FROM vacay_plans WHERE id = ?')
    .get(planId) as { block_weekends: number; weekend_days: string | null } | undefined;

  const locked = new Set<string>();

  // Company holidays stored in the DB
  const companyHolidays = db.prepare(
    'SELECT date FROM vacay_company_holidays WHERE plan_id = ? AND date BETWEEN ? AND ?'
  ).all(planId, startDate, endDate) as { date: string }[];
  for (const { date } of companyHolidays) locked.add(date);

  // Weekend days (only if block_weekends is enabled for this plan)
  if (plan?.block_weekends) {
    const weekendDayNums = new Set(
      (plan.weekend_days || '0,6').split(',').map(Number).filter(n => !isNaN(n))
    );
    for (const date of generateDateRange(startDate, endDate)) {
      const [y, m, d] = date.split('-').map(Number);
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      if (weekendDayNums.has(dow)) locked.add(date);
    }
  }

  return locked;
}

export function syncTripToCalendar(tripId: string | number, userId: number): void {
  const trip = db.prepare('SELECT start_date, end_date, title FROM trips WHERE id = ?').get(tripId) as { start_date: string | null; end_date: string | null; title: string } | undefined;
  if (!trip) return;

  const settings = db.prepare('SELECT add_to_calendar FROM trip_user_settings WHERE trip_id = ? AND user_id = ?').get(tripId, userId) as { add_to_calendar: number } | undefined;

  if (!settings?.add_to_calendar || !trip.start_date || !trip.end_date) {
    removeTripCalendarEntries(tripId, userId);
    return;
  }

  const plan = getOwnPlan(userId);
  const planId = plan.id;
  const locked = getLockedDates(planId, trip.start_date, trip.end_date);
  const newDates = generateDateRange(trip.start_date, trip.end_date).filter(d => !locked.has(d));
  const newDateSet = new Set(newDates);

  db.transaction(() => {
    const existingLinks = db.prepare(`
      SELECT tce.id, e.date, e.id as entry_id
      FROM trip_calendar_entries tce
      JOIN vacay_entries e ON e.id = tce.vacay_entry_id
      WHERE tce.trip_id = ? AND tce.user_id = ?
    `).all(tripId, userId) as { id: number; date: string; entry_id: number }[];

    const existingDates = new Set<string>();
    for (const link of existingLinks) {
      if (!newDateSet.has(link.date)) {
        db.prepare('DELETE FROM vacay_entries WHERE id = ?').run(link.entry_id);
      } else {
        existingDates.add(link.date);
      }
    }

    const insertEntry = db.prepare(`
      INSERT OR IGNORE INTO vacay_entries (plan_id, user_id, date, event_name, show_details)
      VALUES (?, ?, ?, ?, 0)
    `);
    const getEntry = db.prepare('SELECT id FROM vacay_entries WHERE plan_id = ? AND user_id = ? AND date = ?');
    const insertLink = db.prepare(`
      INSERT OR IGNORE INTO trip_calendar_entries (trip_id, user_id, vacay_entry_id)
      VALUES (?, ?, ?)
    `);

    for (const date of newDates) {
      if (!existingDates.has(date)) {
        const result = insertEntry.run(planId, userId, date, trip.title);
        if (result.changes > 0) {
          const entry = getEntry.get(planId, userId, date) as { id: number } | undefined;
          if (entry) insertLink.run(tripId, userId, entry.id);
        }
      }
    }
  })();
}

export function removeTripCalendarEntries(tripId: string | number, userId: number): void {
  const entryIds = db.prepare('SELECT vacay_entry_id FROM trip_calendar_entries WHERE trip_id = ? AND user_id = ?')
    .all(tripId, userId) as { vacay_entry_id: number }[];
  if (entryIds.length === 0) return;
  db.transaction(() => {
    for (const { vacay_entry_id } of entryIds) {
      db.prepare('DELETE FROM vacay_entries WHERE id = ?').run(vacay_entry_id);
    }
  })();
}

export function removeTripCalendarEntriesForAllUsers(tripId: string | number): void {
  const rows = db.prepare('SELECT DISTINCT user_id FROM trip_calendar_entries WHERE trip_id = ?')
    .all(tripId) as { user_id: number }[];
  for (const { user_id } of rows) {
    removeTripCalendarEntries(tripId, user_id);
  }
}

export function getUserCalendarConflicts(tripId: string | number, userId: number): string[] {
  const trip = db.prepare('SELECT start_date, end_date FROM trips WHERE id = ?').get(tripId) as { start_date: string | null; end_date: string | null } | undefined;
  if (!trip?.start_date || !trip.end_date) return [];

  const rows = db.prepare(`
    SELECT e.date FROM vacay_entries e
    JOIN vacay_plans p ON p.id = e.plan_id AND p.is_personal = 1 AND p.owner_id = ?
    WHERE e.user_id = ?
      AND e.date BETWEEN ? AND ?
      AND NOT EXISTS (
        SELECT 1 FROM trip_calendar_entries tce
        WHERE tce.vacay_entry_id = e.id AND tce.trip_id = ?
      )
    ORDER BY e.date
  `).all(userId, userId, trip.start_date, trip.end_date, tripId) as { date: string }[];

  return rows.map(r => r.date);
}

export function syncAllUsersForTrip(tripId: string | number): void {
  const users = db.prepare('SELECT user_id FROM trip_user_settings WHERE trip_id = ? AND add_to_calendar = 1')
    .all(tripId) as { user_id: number }[];
  for (const { user_id } of users) {
    syncTripToCalendar(tripId, user_id);
  }
}
