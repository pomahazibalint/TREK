import { db, canAccessTrip } from '../db/database';
import { BudgetItem, BudgetItemMember } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function avatarUrl(user: { avatar?: string | null }): string | null {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

function loadItemMembers(itemId: number | string) {
  return db.prepare(`
    SELECT bm.user_id, bm.amount_owed_ref, bm.amount_paid_ref, u.username, u.avatar
    FROM budget_item_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id = ?
  `).all(itemId) as BudgetItemMember[];
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listBudgetItems(tripId: string | number) {
  const items = db.prepare(
    'SELECT * FROM budget_items WHERE trip_id = ? ORDER BY category ASC, created_at ASC'
  ).all(tripId) as BudgetItem[];

  const itemIds = items.map(i => i.id);
  const membersByItem: Record<number, (BudgetItemMember & { avatar_url: string | null })[]> = {};

  if (itemIds.length > 0) {
    const allMembers = db.prepare(`
      SELECT bm.budget_item_id, bm.user_id, bm.amount_owed_ref, bm.amount_paid_ref, u.username, u.avatar
      FROM budget_item_members bm
      JOIN users u ON bm.user_id = u.id
      WHERE bm.budget_item_id IN (${itemIds.map(() => '?').join(',')})
    `).all(...itemIds) as (BudgetItemMember & { budget_item_id: number })[];

    for (const m of allMembers) {
      if (!membersByItem[m.budget_item_id]) membersByItem[m.budget_item_id] = [];
      membersByItem[m.budget_item_id].push({
        user_id: m.user_id,
        amount_owed_ref: m.amount_owed_ref,
        amount_paid_ref: m.amount_paid_ref,
        username: m.username,
        avatar_url: avatarUrl(m),
      });
    }
  }

  items.forEach(item => { item.members = membersByItem[item.id] || []; });
  return items;
}

export function createBudgetItem(
  tripId: string | number,
  data: {
    category?: string;
    name: string;
    total_price?: number;
    currency?: string;
    total_price_ref?: number | null;
    exchange_rate?: number | null;
    tip_ref?: number;
    note?: string | null;
    expense_date?: string | null;
  },
) {
  // Inherit trip currency as default for the item
  const trip = db.prepare('SELECT currency FROM trips WHERE id = ?').get(tripId) as { currency: string } | undefined;
  const tripCurrency = trip?.currency || 'EUR';
  const itemCurrency = data.currency || tripCurrency;

  const maxOrder = db.prepare(
    'SELECT MAX(sort_order) as max FROM budget_items WHERE trip_id = ?'
  ).get(tripId) as { max: number | null };
  const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const result = db.prepare(
    `INSERT INTO budget_items
      (trip_id, category, name, total_price, currency, total_price_ref, exchange_rate, tip_ref, note, sort_order, expense_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tripId,
    data.category || 'Other',
    data.name,
    data.total_price || 0,
    itemCurrency,
    data.total_price_ref !== undefined ? data.total_price_ref : null,
    data.exchange_rate !== undefined ? data.exchange_rate : null,
    data.tip_ref || 0,
    data.note || null,
    sortOrder,
    data.expense_date || null,
  );

  const item = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(result.lastInsertRowid) as BudgetItem & { members?: BudgetItemMember[] };
  item.members = [];
  return item;
}

export function updateBudgetItem(
  id: string | number,
  tripId: string | number,
  data: {
    category?: string;
    name?: string;
    total_price?: number;
    currency?: string;
    total_price_ref?: number | null;
    exchange_rate?: number | null;
    tip_ref?: number;
    note?: string | null;
    sort_order?: number;
    expense_date?: string | null;
  },
) {
  const item = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!item) return null;

  db.prepare(`
    UPDATE budget_items SET
      category     = COALESCE(?, category),
      name         = COALESCE(?, name),
      total_price  = CASE WHEN ? IS NOT NULL THEN ? ELSE total_price END,
      currency     = COALESCE(?, currency),
      total_price_ref = CASE WHEN ? THEN ? ELSE total_price_ref END,
      exchange_rate   = CASE WHEN ? THEN ? ELSE exchange_rate END,
      tip_ref      = CASE WHEN ? IS NOT NULL THEN ? ELSE tip_ref END,
      note         = CASE WHEN ? THEN ? ELSE note END,
      sort_order   = CASE WHEN ? IS NOT NULL THEN ? ELSE sort_order END,
      expense_date = CASE WHEN ? THEN ? ELSE expense_date END
    WHERE id = ?
  `).run(
    data.category || null,
    data.name || null,
    data.total_price !== undefined ? 1 : null, data.total_price !== undefined ? data.total_price : 0,
    data.currency || null,
    data.total_price_ref !== undefined ? 1 : 0, data.total_price_ref !== undefined ? data.total_price_ref : null,
    data.exchange_rate !== undefined ? 1 : 0, data.exchange_rate !== undefined ? data.exchange_rate : null,
    data.tip_ref !== undefined ? 1 : null, data.tip_ref !== undefined ? data.tip_ref : 0,
    data.note !== undefined ? 1 : 0, data.note !== undefined ? data.note : null,
    data.sort_order !== undefined ? 1 : null, data.sort_order !== undefined ? data.sort_order : 0,
    data.expense_date !== undefined ? 1 : 0, data.expense_date !== undefined ? (data.expense_date || null) : null,
    id,
  );

  const updated = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(id) as BudgetItem & { members?: BudgetItemMember[] };
  updated.members = loadItemMembers(id);
  return updated;
}

export function deleteBudgetItem(id: string | number, tripId: string | number): boolean {
  const item = db.prepare('SELECT id FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!item) return false;
  db.prepare('DELETE FROM budget_items WHERE id = ?').run(id);
  return true;
}

// ---------------------------------------------------------------------------
// Members — owed side
// ---------------------------------------------------------------------------

export function updateMemberOwed(
  id: string | number,
  tripId: string | number,
  members: { user_id: number; amount_owed_ref: number }[],
  tip_ref: number,
) {
  const item = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId) as BudgetItem | undefined;
  if (!item) return null;

  const ref = item.total_price_ref ?? item.total_price;
  const individualSum = members.reduce((s, m) => s + (Number(m.amount_owed_ref) || 0), 0);
  const effectiveTotal = individualSum + (Number(tip_ref) || 0);

  if (Math.abs(effectiveTotal - ref) > 0.01) {
    return { error: 'Owed amounts plus tip must sum to the total expense value' };
  }

  // Preserve existing amount_paid_ref values
  const existing = db.prepare('SELECT user_id, amount_paid_ref FROM budget_item_members WHERE budget_item_id = ?').all(id) as { user_id: number; amount_paid_ref: number }[];
  const paidByUser: Record<number, number> = {};
  for (const e of existing) paidByUser[e.user_id] = e.amount_paid_ref;

  db.prepare('DELETE FROM budget_item_members WHERE budget_item_id = ?').run(id);

  const insert = db.prepare('INSERT INTO budget_item_members (budget_item_id, user_id, amount_owed_ref, amount_paid_ref) VALUES (?, ?, ?, ?)');
  for (const m of members) insert.run(id, m.user_id, m.amount_owed_ref, paidByUser[m.user_id] || 0);

  // Persist the updated tip
  db.prepare('UPDATE budget_items SET tip_ref = ? WHERE id = ?').run(tip_ref, id);

  const updatedMembers = loadItemMembers(id).map(m => ({ ...m, avatar_url: avatarUrl(m) }));
  const updatedItem = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(id) as BudgetItem;
  return { members: updatedMembers, item: updatedItem };
}

// ---------------------------------------------------------------------------
// Members — paid side
// ---------------------------------------------------------------------------

export function updateMemberPayments(
  id: string | number,
  tripId: string | number,
  payments: { user_id: number; amount_paid_ref: number }[],
) {
  const item = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId) as BudgetItem | undefined;
  if (!item) return null;

  const ref = item.total_price_ref ?? item.total_price;
  const totalPaid = payments.reduce((s, p) => s + (Number(p.amount_paid_ref) || 0), 0);
  const allZero = totalPaid < 0.01;

  if (!allZero && Math.abs(totalPaid - ref) > 0.01) {
    return { error: 'Paid amounts must sum to the total expense value, or all be zero' };
  }

  const update = db.prepare('UPDATE budget_item_members SET amount_paid_ref = ? WHERE budget_item_id = ? AND user_id = ?');
  for (const p of payments) update.run(p.amount_paid_ref, id, p.user_id);

  const members = loadItemMembers(id).map(m => ({ ...m, avatar_url: avatarUrl(m) }));
  return { members };
}

// ---------------------------------------------------------------------------
// Settlement calculation (greedy debt matching — fully data-driven)
// ---------------------------------------------------------------------------

export function calculateSettlement(tripId: string | number) {
  const trip = db.prepare('SELECT currency FROM trips WHERE id = ?').get(tripId) as { currency: string } | undefined;
  const settlementCurrency = trip?.currency || 'EUR';

  const items = db.prepare('SELECT * FROM budget_items WHERE trip_id = ?').all(tripId) as BudgetItem[];
  const allMembers = db.prepare(`
    SELECT bm.budget_item_id, bm.user_id, bm.amount_owed_ref, bm.amount_paid_ref, u.username, u.avatar
    FROM budget_item_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id IN (SELECT id FROM budget_items WHERE trip_id = ?)
  `).all(tripId) as (BudgetItemMember & { budget_item_id: number })[];

  // Calculate net balance per user: positive = is owed money, negative = owes money
  const balances: Record<number, {
    user_id: number;
    username: string;
    avatar_url: string | null;
    total_charged: number;
    total_paid: number;
    balance: number;
  }> = {};

  for (const item of items) {
    const members = allMembers.filter(m => m.budget_item_id === item.id);
    if (members.length === 0) continue;

    const totalOwed = members.reduce((s, m) => s + m.amount_owed_ref, 0);
    const totalPaid = members.reduce((s, m) => s + m.amount_paid_ref, 0);

    // Skip items not yet fully configured on either side
    if (totalOwed < 0.01 || totalPaid < 0.01) continue;

    const tipPerMember = (item.tip_ref ?? 0) / members.length;

    for (const m of members) {
      if (!balances[m.user_id]) {
        balances[m.user_id] = {
          user_id: m.user_id,
          username: m.username,
          avatar_url: avatarUrl(m),
          total_charged: 0,
          total_paid: 0,
          balance: 0,
        };
      }
      const charged = m.amount_owed_ref + tipPerMember;
      balances[m.user_id].total_charged += charged;
      balances[m.user_id].total_paid += m.amount_paid_ref;
      balances[m.user_id].balance -= charged;
      balances[m.user_id].balance += m.amount_paid_ref;
    }
  }

  // Calculate optimized payment flows (greedy algorithm)
  const people = Object.values(balances).filter(b => Math.abs(b.balance) > 0.01);
  const debtors = people.filter(p => p.balance < -0.01).map(p => ({ ...p, amount: -p.balance }));
  const creditors = people.filter(p => p.balance > 0.01).map(p => ({ ...p, amount: p.balance }));

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const flows: {
    from: { user_id: number; username: string; avatar_url: string | null };
    to: { user_id: number; username: string; avatar_url: string | null };
    amount: number;
  }[] = [];

  let di = 0, ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const transfer = Math.min(debtors[di].amount, creditors[ci].amount);
    if (transfer > 0.01) {
      flows.push({
        from: { user_id: debtors[di].user_id, username: debtors[di].username, avatar_url: debtors[di].avatar_url },
        to: { user_id: creditors[ci].user_id, username: creditors[ci].username, avatar_url: creditors[ci].avatar_url },
        amount: Math.round(transfer * 100) / 100,
      });
    }
    debtors[di].amount -= transfer;
    creditors[ci].amount -= transfer;
    if (debtors[di].amount < 0.01) di++;
    if (creditors[ci].amount < 0.01) ci++;
  }

  return {
    settlement_currency: settlementCurrency,
    balances: Object.values(balances).map(b => ({
      ...b,
      total_charged: Math.round(b.total_charged * 100) / 100,
      total_paid: Math.round(b.total_paid * 100) / 100,
      balance: Math.round(b.balance * 100) / 100,
    })),
    flows,
  };
}
