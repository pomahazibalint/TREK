import { db } from '../db/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VacayPlan {
  id: number;
  owner_id: number;
  name: string;
  is_personal: number;
  block_weekends: number;
  holidays_enabled: number;
  holidays_region: string | null;
  company_holidays_enabled: number;
  carry_over_enabled: number;
  weekend_days?: string | null;
}

export interface VacayUserYear {
  user_id: number;
  plan_id: number;
  year: number;
  vacation_days: number;
  carried_over: number;
}

export interface VacayUser {
  id: number;
  username: string;
  email: string;
}

export interface VacayPlanMember {
  id: number;
  plan_id: number;
  user_id: number;
  status: string;
  created_at?: string;
}

export interface Holiday {
  date: string;
  localName?: string;
  name?: string;
  global?: boolean;
  counties?: string[] | null;
}

export interface VacayHolidayCalendar {
  id: number;
  plan_id: number;
  region: string;
  label: string | null;
  color: string;
  sort_order: number;
}

// ---------------------------------------------------------------------------
// Holiday cache (shared in-process)
// ---------------------------------------------------------------------------

const holidayCache = new Map<string, { data: unknown; time: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Color palette for auto-assign
// ---------------------------------------------------------------------------

const COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444',
  '#3b82f6', '#22c55e', '#06b6d4', '#f43f5e', '#a855f7',
  '#10b981', '#0ea5e9', '#64748b', '#be185d', '#0d9488',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getPersonalPlanId(userId: number): number | undefined {
  const row = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ? AND is_personal = 1').get(userId) as { id: number } | undefined;
  return row?.id;
}

function getMemberIds(planId: number): number[] {
  const plan = db.prepare('SELECT owner_id FROM vacay_plans WHERE id = ?').get(planId) as { owner_id: number } | undefined;
  if (!plan) return [];
  const members = db.prepare("SELECT user_id FROM vacay_plan_members WHERE plan_id = ? AND status = 'accepted'").all(planId) as { user_id: number }[];
  return [plan.owner_id, ...members.map(m => m.user_id)];
}

function getUserShareDetailsDefault(userId: number): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'vacay_share_details_default'").get(userId) as { value: string } | undefined;
  if (!row) return true;
  return row.value !== '0';
}

// ---------------------------------------------------------------------------
// Plan management
// ---------------------------------------------------------------------------

export function getOwnPlan(userId: number): VacayPlan {
  let plan = db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ? AND is_personal = 1').get(userId) as VacayPlan | undefined;
  if (!plan) {
    db.prepare("INSERT INTO vacay_plans (owner_id, name, is_personal) VALUES (?, 'My Calendar', 1)").run(userId);
    plan = db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ? AND is_personal = 1').get(userId) as VacayPlan;
    const yr = new Date().getFullYear();
    db.prepare('INSERT OR IGNORE INTO vacay_years (plan_id, year) VALUES (?, ?)').run(plan.id, yr);
    db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)').run(userId, plan.id, yr);
    db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(userId, plan.id, '#6366f1');
  }
  return plan;
}

export function createPlan(userId: number, name: string): VacayPlan {
  const result = db.prepare('INSERT INTO vacay_plans (owner_id, name, is_personal) VALUES (?, ?, 0)').run(userId, name.trim() || 'Shared Calendar');
  const planId = result.lastInsertRowid as number;
  const yr = new Date().getFullYear();
  db.prepare('INSERT OR IGNORE INTO vacay_years (plan_id, year) VALUES (?, ?)').run(planId, yr);
  db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)').run(userId, planId, yr);
  db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(userId, planId, '#6366f1');
  return db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan;
}

export function getAllPlansData(userId: number) {
  const personal = getOwnPlan(userId);
  const ownedShared = db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ? AND is_personal = 0').all(userId) as VacayPlan[];
  const memberOf = db.prepare(`
    SELECT p.* FROM vacay_plans p
    JOIN vacay_plan_members m ON m.plan_id = p.id
    WHERE m.user_id = ? AND m.status = 'accepted'
  `).all(userId) as VacayPlan[];

  return [personal, ...ownedShared, ...memberOf].map(p => ({
    id: p.id,
    name: p.name,
    is_personal: !!p.is_personal,
    is_owner: p.owner_id === userId,
    member_count: getMemberIds(p.id).length,
  }));
}

export function getPlanUsers(planId: number): VacayUser[] {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  if (!plan) return [];
  const owner = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(plan.owner_id) as VacayUser;
  const members = db.prepare(`
    SELECT u.id, u.username, u.email FROM vacay_plan_members m
    JOIN users u ON m.user_id = u.id
    WHERE m.plan_id = ? AND m.status = 'accepted'
  `).all(planId) as VacayUser[];
  return [owner, ...members];
}

export function getPlanData(userId: number, planId: number) {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  if (!plan) return null;

  const isOwner = plan.owner_id === userId;
  const isMember = isOwner || !!db.prepare("SELECT id FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'accepted'").get(planId, userId);
  if (!isMember) return null;

  const users = getPlanUsers(planId).map(u => {
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(u.id, planId) as { color: string } | undefined;
    return { ...u, color: colorRow?.color || '#6366f1' };
  });

  const pendingInvites = isOwner ? db.prepare(`
    SELECT m.id, m.user_id, u.username, u.email, m.created_at
    FROM vacay_plan_members m JOIN users u ON m.user_id = u.id
    WHERE m.plan_id = ? AND m.status = 'pending'
  `).all(planId) : [];

  const incomingInvites = db.prepare(`
    SELECT m.id, m.plan_id, p.name as plan_name, u.username, u.email, m.created_at
    FROM vacay_plan_members m
    JOIN vacay_plans p ON m.plan_id = p.id
    JOIN users u ON p.owner_id = u.id
    WHERE m.user_id = ? AND m.status = 'pending'
  `).all(userId);

  const holidayCalendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(planId) as VacayHolidayCalendar[];

  return {
    plan: {
      ...plan,
      block_weekends: !!plan.block_weekends,
      holidays_enabled: !!plan.holidays_enabled,
      company_holidays_enabled: !!plan.company_holidays_enabled,
      carry_over_enabled: !!plan.carry_over_enabled,
      is_personal: !!plan.is_personal,
      holiday_calendars: holidayCalendars,
    },
    users,
    pendingInvites,
    incomingInvites,
    isOwner,
    shareDetailsDefault: getUserShareDetailsDefault(userId),
  };
}

// ---------------------------------------------------------------------------
// WebSocket notifications
// ---------------------------------------------------------------------------

export function notifyPlanUsers(planId: number, excludeSid: string | undefined, event = 'vacay:update'): void {
  try {
    const { broadcastToUser } = require('../websocket');
    const userIds = getMemberIds(planId);
    userIds.forEach(id => broadcastToUser(id, { type: event }, excludeSid));
  } catch { /* websocket not available */ }
}

// ---------------------------------------------------------------------------
// Holiday calendar helpers
// ---------------------------------------------------------------------------

export async function applyHolidayCalendars(planId: number): Promise<void> {
  const plan = db.prepare('SELECT holidays_enabled, is_personal FROM vacay_plans WHERE id = ?').get(planId) as { holidays_enabled: number; is_personal: number } | undefined;
  if (!plan?.holidays_enabled) return;
  const calendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(planId) as VacayHolidayCalendar[];
  if (calendars.length === 0) return;
  const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(planId) as { year: number }[];
  for (const cal of calendars) {
    const country = cal.region.split('-')[0];
    const region = cal.region.includes('-') ? cal.region : null;
    for (const { year } of years) {
      try {
        const cacheKey = `${year}-${country}`;
        let holidays = holidayCache.get(cacheKey)?.data as Holiday[] | undefined;
        if (!holidays) {
          const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
          holidays = await resp.json() as Holiday[];
          holidayCache.set(cacheKey, { data: holidays, time: Date.now() });
        }
        const hasRegions = holidays.some((h: Holiday) => h.counties && h.counties.length > 0);
        if (hasRegions && !region) continue;
        for (const h of holidays) {
          if (h.global || !h.counties || (region && h.counties.includes(region))) {
            if (plan.is_personal) {
              db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, h.date);
            } else {
              for (const uid of getMemberIds(planId)) {
                const ppId = getPersonalPlanId(uid);
                if (ppId) db.prepare('DELETE FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date = ?').run(uid, ppId, h.date);
              }
            }
            db.prepare('DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date = ?').run(planId, h.date);
          }
        }
      } catch { /* API error, skip */ }
    }
  }
}

export async function migrateHolidayCalendars(planId: number, plan: VacayPlan): Promise<void> {
  const existing = db.prepare('SELECT id FROM vacay_holiday_calendars WHERE plan_id = ?').get(planId);
  if (existing) return;
  if (plan.holidays_enabled && plan.holidays_region) {
    db.prepare(
      'INSERT INTO vacay_holiday_calendars (plan_id, region, label, color, sort_order) VALUES (?, ?, NULL, ?, 0)'
    ).run(planId, plan.holidays_region, '#fecaca');
  }
}

// ---------------------------------------------------------------------------
// Plan settings
// ---------------------------------------------------------------------------

export interface UpdatePlanBody {
  block_weekends?: boolean;
  holidays_enabled?: boolean;
  holidays_region?: string;
  company_holidays_enabled?: boolean;
  carry_over_enabled?: boolean;
  weekend_days?: string;
  name?: string;
}

export async function updatePlan(planId: number, body: UpdatePlanBody, socketId: string | undefined) {
  const { block_weekends, holidays_enabled, holidays_region, company_holidays_enabled, carry_over_enabled, weekend_days, name } = body;

  const updates: string[] = [];
  const params: (string | number)[] = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name.trim() || 'Shared Calendar'); }
  if (block_weekends !== undefined) { updates.push('block_weekends = ?'); params.push(block_weekends ? 1 : 0); }
  if (holidays_enabled !== undefined) { updates.push('holidays_enabled = ?'); params.push(holidays_enabled ? 1 : 0); }
  if (holidays_region !== undefined) { updates.push('holidays_region = ?'); params.push(holidays_region); }
  if (company_holidays_enabled !== undefined) { updates.push('company_holidays_enabled = ?'); params.push(company_holidays_enabled ? 1 : 0); }
  if (carry_over_enabled !== undefined) { updates.push('carry_over_enabled = ?'); params.push(carry_over_enabled ? 1 : 0); }
  if (weekend_days !== undefined) { updates.push('weekend_days = ?'); params.push(String(weekend_days)); }

  if (updates.length > 0) {
    params.push(planId);
    db.prepare(`UPDATE vacay_plans SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const currentPlan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan;

  if (company_holidays_enabled === true) {
    const companyDates = db.prepare('SELECT date FROM vacay_company_holidays WHERE plan_id = ?').all(planId) as { date: string }[];
    for (const { date } of companyDates) {
      if (currentPlan.is_personal) {
        db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, date);
      } else {
        for (const uid of getMemberIds(planId)) {
          const ppId = getPersonalPlanId(uid);
          if (ppId) db.prepare('DELETE FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date = ?').run(uid, ppId, date);
        }
      }
    }
  }

  await migrateHolidayCalendars(planId, currentPlan);
  await applyHolidayCalendars(planId);

  if (carry_over_enabled === false) {
    db.prepare('UPDATE vacay_user_years SET carried_over = 0 WHERE plan_id = ?').run(planId);
  }

  if (carry_over_enabled === true) {
    const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId) as { year: number }[];
    const users = getPlanUsers(planId);
    for (let i = 0; i < years.length - 1; i++) {
      const yr = years[i].year;
      const nextYr = years[i + 1].year;
      for (const u of users) {
        const ppId = getPersonalPlanId(u.id) ?? planId;
        const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, ppId, `${yr}-%`) as { count: number }).count;
        const config = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, yr) as VacayUserYear | undefined;
        const total = (config ? config.vacation_days : 30) + (config ? config.carried_over : 0);
        const carry = Math.max(0, total - used);
        db.prepare(`
          INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)
          ON CONFLICT(user_id, plan_id, year) DO UPDATE SET carried_over = ?
        `).run(u.id, planId, nextYr, carry, carry);
      }
    }
  }

  notifyPlanUsers(planId, socketId, 'vacay:settings');

  const updated = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan;
  const updatedCalendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(planId) as VacayHolidayCalendar[];
  return {
    plan: {
      ...updated,
      block_weekends: !!updated.block_weekends,
      holidays_enabled: !!updated.holidays_enabled,
      company_holidays_enabled: !!updated.company_holidays_enabled,
      carry_over_enabled: !!updated.carry_over_enabled,
      is_personal: !!updated.is_personal,
      holiday_calendars: updatedCalendars,
    },
  };
}

// ---------------------------------------------------------------------------
// Holiday calendars CRUD
// ---------------------------------------------------------------------------

export function addHolidayCalendar(planId: number, region: string, label: string | null, color: string | undefined, sortOrder: number | undefined, socketId: string | undefined) {
  const result = db.prepare(
    'INSERT INTO vacay_holiday_calendars (plan_id, region, label, color, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(planId, region, label || null, color || '#fecaca', sortOrder ?? 0);
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ?').get(result.lastInsertRowid) as VacayHolidayCalendar;
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return cal;
}

export function updateHolidayCalendar(
  calId: number,
  planId: number,
  body: { region?: string; label?: string | null; color?: string; sort_order?: number },
  socketId: string | undefined,
): VacayHolidayCalendar | null {
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ? AND plan_id = ?').get(calId, planId) as VacayHolidayCalendar | undefined;
  if (!cal) return null;
  const { region, label, color, sort_order } = body;
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (region !== undefined) { updates.push('region = ?'); params.push(region); }
  if (label !== undefined) { updates.push('label = ?'); params.push(label); }
  if (color !== undefined) { updates.push('color = ?'); params.push(color); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
  if (updates.length > 0) {
    params.push(calId);
    db.prepare(`UPDATE vacay_holiday_calendars SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ?').get(calId) as VacayHolidayCalendar;
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return updated;
}

export function deleteHolidayCalendar(calId: number, planId: number, socketId: string | undefined): boolean {
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ? AND plan_id = ?').get(calId, planId);
  if (!cal) return false;
  db.prepare('DELETE FROM vacay_holiday_calendars WHERE id = ?').run(calId);
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return true;
}

// ---------------------------------------------------------------------------
// User colors
// ---------------------------------------------------------------------------

export function setUserColor(userId: number, planId: number, color: string | undefined, socketId: string | undefined): void {
  db.prepare(`
    INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
    ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color
  `).run(userId, planId, color || '#6366f1');
  notifyPlanUsers(planId, socketId, 'vacay:update');
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export function sendInvite(planId: number, inviterId: number, inviterUsername: string, inviterEmail: string, targetUserId: number): { error?: string; status?: number } {
  if (targetUserId === inviterId) return { error: 'Cannot invite yourself', status: 400 };

  const plan = db.prepare('SELECT is_personal, name FROM vacay_plans WHERE id = ?').get(planId) as { is_personal: number; name: string } | undefined;
  if (!plan) return { error: 'Calendar not found', status: 404 };
  if (plan.is_personal) return { error: 'Cannot invite to a personal calendar', status: 400 };

  const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetUserId);
  if (!targetUser) return { error: 'User not found', status: 404 };

  const existing = db.prepare('SELECT id, status FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?').get(planId, targetUserId) as { id: number; status: string } | undefined;
  if (existing) {
    if (existing.status === 'accepted') return { error: 'Already a member', status: 400 };
    if (existing.status === 'pending') return { error: 'Invite already pending', status: 400 };
  }

  db.prepare('INSERT INTO vacay_plan_members (plan_id, user_id, status) VALUES (?, ?, ?)').run(planId, targetUserId, 'pending');

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(targetUserId, {
      type: 'vacay:invite',
      from: { id: inviterId, username: inviterUsername },
      planId,
      planName: plan.name,
    });
  } catch { /* websocket not available */ }

  import('../services/notificationService').then(({ send }) => {
    send({ event: 'vacay_invite', actorId: inviterId, scope: 'user', targetId: targetUserId, params: { actor: inviterEmail, planId: String(planId) } }).catch(() => {});
  });

  return {};
}

export function acceptInvite(userId: number, planId: number, socketId: string | undefined): { error?: string; status?: number } {
  const invite = db.prepare("SELECT * FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").get(planId, userId) as VacayPlanMember | undefined;
  if (!invite) return { error: 'No pending invite', status: 404 };

  db.prepare("UPDATE vacay_plan_members SET status = 'accepted' WHERE id = ?").run(invite.id);

  const existingColors = (db.prepare('SELECT color FROM vacay_user_colors WHERE plan_id = ? AND user_id != ?').all(planId, userId) as { color: string }[]).map(r => r.color);
  const myColor = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(userId, planId) as { color: string } | undefined;
  const effectiveColor = myColor?.color || '#6366f1';
  if (existingColors.includes(effectiveColor)) {
    const available = COLORS.find(c => !existingColors.includes(c));
    if (available) {
      db.prepare(`INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
        ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color`).run(userId, planId, available);
    }
  } else if (!myColor) {
    db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(userId, planId, effectiveColor);
  }

  const targetYears = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(planId) as { year: number }[];
  for (const y of targetYears) {
    db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)').run(userId, planId, y.year);
  }

  notifyPlanUsers(planId, socketId, 'vacay:accepted');
  return {};
}

export function declineInvite(userId: number, planId: number, socketId: string | undefined): void {
  db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").run(planId, userId);
  notifyPlanUsers(planId, socketId, 'vacay:declined');
}

export function cancelInvite(planId: number, targetUserId: number): void {
  db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").run(planId, targetUserId);
  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(targetUserId, { type: 'vacay:cancelled' });
  } catch { /* */ }
}

// ---------------------------------------------------------------------------
// Leave / delete calendar
// ---------------------------------------------------------------------------

export function leaveCalendar(userId: number, planId: number, socketId: string | undefined): { error?: string; status?: number } {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  if (!plan) return { error: 'Not found', status: 404 };
  if (plan.is_personal) return { error: 'Cannot leave personal calendar', status: 400 };

  const allUserIds = getMemberIds(planId);

  if (plan.owner_id === userId) {
    db.prepare('DELETE FROM vacay_plans WHERE id = ?').run(planId);
  } else {
    db.prepare('DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?').run(planId, userId);
    db.prepare('DELETE FROM vacay_user_years WHERE plan_id = ? AND user_id = ?').run(planId, userId);
    db.prepare('DELETE FROM vacay_user_colors WHERE plan_id = ? AND user_id = ?').run(planId, userId);
  }

  try {
    const { broadcastToUser } = require('../websocket');
    allUserIds.filter(id => id !== userId).forEach(id => broadcastToUser(id, { type: 'vacay:dissolved' }));
  } catch { /* */ }

  return {};
}

// ---------------------------------------------------------------------------
// Available users
// ---------------------------------------------------------------------------

export function getAvailableUsers(userId: number, planId: number) {
  return db.prepare(`
    SELECT u.id, u.username, u.email FROM users u
    WHERE u.id != ?
    AND u.id NOT IN (SELECT user_id FROM vacay_plan_members WHERE plan_id = ? AND status != 'declined')
    AND u.id != (SELECT owner_id FROM vacay_plans WHERE id = ?)
    ORDER BY u.username
  `).all(userId, planId, planId);
}

// ---------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------

export function listYears(planId: number): number[] {
  const rows = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId) as { year: number }[];
  return rows.map(y => y.year);
}

export function addYear(planId: number, year: number, socketId: string | undefined): number[] {
  try {
    db.prepare('INSERT INTO vacay_years (plan_id, year) VALUES (?, ?)').run(planId, year);
    const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
    const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
    const users = getPlanUsers(planId);
    for (const u of users) {
      let carriedOver = 0;
      if (carryOverEnabled) {
        const ppId = getPersonalPlanId(u.id) ?? planId;
        const prevConfig = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, year - 1) as VacayUserYear | undefined;
        if (prevConfig) {
          const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, ppId, `${year - 1}-%`) as { count: number }).count;
          const total = prevConfig.vacation_days + prevConfig.carried_over;
          carriedOver = Math.max(0, total - used);
        }
      }
      db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)').run(u.id, planId, year, carriedOver);
    }
  } catch { /* year already exists */ }
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return listYears(planId);
}

export function deleteYear(planId: number, year: number, socketId: string | undefined): number[] {
  const plan = db.prepare('SELECT is_personal FROM vacay_plans WHERE id = ?').get(planId) as { is_personal: number } | undefined;

  db.prepare('DELETE FROM vacay_years WHERE plan_id = ? AND year = ?').run(planId, year);
  db.prepare("DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  db.prepare('DELETE FROM vacay_user_years WHERE plan_id = ? AND year = ?').run(planId, year);

  if (plan?.is_personal) {
    db.prepare("DELETE FROM vacay_entries WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  } else {
    for (const uid of getMemberIds(planId)) {
      const ppId = getPersonalPlanId(uid);
      if (ppId) db.prepare("DELETE FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").run(uid, ppId, `${year}-%`);
    }
  }

  const nextYearExists = db.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?').get(planId, year + 1);
  if (nextYearExists) {
    const carryOverEnabled = plan ? !!(db.prepare('SELECT carry_over_enabled FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan).carry_over_enabled : true;
    const users = getPlanUsers(planId);
    const prevYear = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? AND year < ? ORDER BY year DESC LIMIT 1').get(planId, year + 1) as { year: number } | undefined;

    for (const u of users) {
      let carry = 0;
      if (carryOverEnabled && prevYear) {
        const ppId = getPersonalPlanId(u.id) ?? planId;
        const prevConfig = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, prevYear.year) as VacayUserYear | undefined;
        if (prevConfig) {
          const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, ppId, `${prevYear.year}-%`) as { count: number }).count;
          const total = prevConfig.vacation_days + prevConfig.carried_over;
          carry = Math.max(0, total - used);
        }
      }
      db.prepare('UPDATE vacay_user_years SET carried_over = ? WHERE user_id = ? AND plan_id = ? AND year = ?').run(carry, u.id, planId, year + 1);
    }
  }

  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return listYears(planId);
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export function getEntries(planId: number, year: string, requestingUserId?: number) {
  const plan = db.prepare('SELECT is_personal FROM vacay_plans WHERE id = ?').get(planId) as { is_personal: number } | undefined;
  if (!plan) return { entries: [], companyHolidays: [] };

  let entries: unknown[];

  if (plan.is_personal) {
    entries = db.prepare(`
      SELECT e.*, u.username as person_name, COALESCE(c.color, '#6366f1') as person_color
      FROM vacay_entries e
      JOIN users u ON e.user_id = u.id
      LEFT JOIN vacay_user_colors c ON c.user_id = e.user_id AND c.plan_id = e.plan_id
      WHERE e.plan_id = ? AND e.date LIKE ?
    `).all(planId, `${year}-%`);
  } else {
    const memberIds = getMemberIds(planId);
    if (memberIds.length === 0) {
      return { entries: [], companyHolidays: [] };
    }
    const placeholders = memberIds.map(() => '?').join(',');
    const rawEntries = db.prepare(`
      SELECT e.*, u.username as person_name, COALESCE(c.color, '#6366f1') as person_color
      FROM vacay_entries e
      JOIN users u ON e.user_id = u.id
      LEFT JOIN vacay_user_colors c ON c.user_id = e.user_id AND c.plan_id = ?
      JOIN vacay_plans pp ON pp.owner_id = e.user_id AND pp.is_personal = 1 AND pp.id = e.plan_id
      WHERE e.user_id IN (${placeholders}) AND e.date LIKE ?
    `).all(planId, ...memberIds, `${year}-%`) as Record<string, unknown>[];

    entries = rawEntries.map(e => {
      if (requestingUserId && e.user_id !== requestingUserId && !e.show_details) {
        return { ...e, note: null, event_name: null, location: null, busy_only: true };
      }
      return e;
    });
  }

  const companyHolidays = db.prepare("SELECT * FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").all(planId, `${year}-%`);
  return { entries, companyHolidays };
}

export function toggleEntry(userId: number, planId: number, date: string, socketId: string | undefined): { action: string } {
  const personalPlan = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ? AND is_personal = 1').get(userId) as { id: number } | undefined;
  if (!personalPlan) return { action: 'error' };

  const existing = db.prepare('SELECT id FROM vacay_entries WHERE user_id = ? AND date = ? AND plan_id = ?').get(userId, date, personalPlan.id) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vacay_entries WHERE id = ?').run(existing.id);
    notifyPlanUsers(planId, socketId);
    return { action: 'removed' };
  } else {
    const showDetails = getUserShareDetailsDefault(userId) ? 1 : 0;
    db.prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note, event_name, location, show_details) VALUES (?, ?, ?, ?, ?, ?, ?)').run(personalPlan.id, userId, date, '', '', '', showDetails);
    notifyPlanUsers(planId, socketId);
    return { action: 'added' };
  }
}

export function batchEntries(
  userId: number, planId: number, dates: string[],
  note: string | null, eventName: string | null, location: string | null, showDetails: number | null,
  socketId: string | undefined,
): void {
  const personalPlan = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ? AND is_personal = 1').get(userId) as { id: number } | undefined;
  if (!personalPlan) return;

  const run = db.transaction(() => {
    for (const date of dates) {
      const existing = db.prepare('SELECT id FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date = ?').get(userId, personalPlan.id, date) as { id: number } | undefined;
      if (existing) {
        const sets: string[] = [];
        const vals: (string | number)[] = [];
        if (note !== null)        { sets.push('note = ?');        vals.push(note); }
        if (eventName !== null)   { sets.push('event_name = ?');  vals.push(eventName); }
        if (location !== null)    { sets.push('location = ?');    vals.push(location); }
        if (showDetails !== null) { sets.push('show_details = ?'); vals.push(showDetails); }
        if (sets.length > 0) {
          vals.push(existing.id);
          db.prepare(`UPDATE vacay_entries SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        }
      } else {
        db.prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note, event_name, location, show_details) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(personalPlan.id, userId, date, note ?? '', eventName ?? '', location ?? '', showDetails ?? 1);
      }
    }
  });
  run();
  notifyPlanUsers(planId, socketId);
}

export function removeEntries(userId: number, planId: number, dates: string[], socketId: string | undefined): void {
  const personalPlan = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ? AND is_personal = 1').get(userId) as { id: number } | undefined;
  if (!personalPlan) return;
  const run = db.transaction(() => {
    for (const date of dates) {
      db.prepare('DELETE FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date = ?').run(userId, personalPlan.id, date);
    }
  });
  run();
  notifyPlanUsers(planId, socketId);
}

export function toggleCompanyHoliday(planId: number, date: string, note: string | undefined, socketId: string | undefined): { action: string } {
  const plan = db.prepare('SELECT is_personal FROM vacay_plans WHERE id = ?').get(planId) as { is_personal: number } | undefined;
  const existing = db.prepare('SELECT id FROM vacay_company_holidays WHERE plan_id = ? AND date = ?').get(planId, date) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vacay_company_holidays WHERE id = ?').run(existing.id);
    notifyPlanUsers(planId, socketId);
    return { action: 'removed' };
  } else {
    db.prepare('INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)').run(planId, date, note || '');
    if (plan?.is_personal) {
      db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, date);
    } else {
      for (const uid of getMemberIds(planId)) {
        const ppId = getPersonalPlanId(uid);
        if (ppId) db.prepare('DELETE FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date = ?').run(uid, ppId, date);
      }
    }
    notifyPlanUsers(planId, socketId);
    return { action: 'added' };
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getStats(planId: number, year: number) {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
  const users = getPlanUsers(planId);

  return users.map(u => {
    const ppId = getPersonalPlanId(u.id) ?? planId;
    const used = (db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, ppId, `${year}-%`) as { count: number }).count;
    const config = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, year) as VacayUserYear | undefined;
    const vacationDays = config ? config.vacation_days : 30;
    const carriedOver = carryOverEnabled ? (config ? config.carried_over : 0) : 0;
    const total = vacationDays + carriedOver;
    const remaining = total - used;
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(u.id, planId) as { color: string } | undefined;

    const nextYearExists = db.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?').get(planId, year + 1);
    if (nextYearExists && carryOverEnabled) {
      const carry = Math.max(0, remaining);
      db.prepare(`
        INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)
        ON CONFLICT(user_id, plan_id, year) DO UPDATE SET carried_over = ?
      `).run(u.id, planId, year + 1, carry, carry);
    }

    return {
      user_id: u.id, person_name: u.username, person_color: colorRow?.color || '#6366f1',
      year, vacation_days: vacationDays, carried_over: carriedOver,
      total_available: total, used, remaining,
    };
  });
}

export function updateStats(userId: number, planId: number, year: number, vacationDays: number, socketId: string | undefined): void {
  db.prepare(`
    INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(user_id, plan_id, year) DO UPDATE SET vacation_days = excluded.vacation_days
  `).run(userId, planId, year, vacationDays);
  notifyPlanUsers(planId, socketId);
}

// ---------------------------------------------------------------------------
// Share details default
// ---------------------------------------------------------------------------

export function setShareDetailsDefault(userId: number, value: boolean): void {
  db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, 'vacay_share_details_default', ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, value ? '1' : '0');
}

// ---------------------------------------------------------------------------
// Holidays (nager.at proxy with cache)
// ---------------------------------------------------------------------------

export async function getCountries(): Promise<{ data?: unknown; error?: string }> {
  const cacheKey = 'countries';
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return { data: cached.data };
  try {
    const resp = await fetch('https://date.nager.at/api/v3/AvailableCountries');
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    return { data };
  } catch {
    return { error: 'Failed to fetch countries' };
  }
}

export async function getHolidays(year: string, country: string): Promise<{ data?: unknown; error?: string }> {
  const cacheKey = `${year}-${country}`;
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return { data: cached.data };
  try {
    const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    return { data };
  } catch {
    return { error: 'Failed to fetch holidays' };
  }
}
