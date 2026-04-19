import { db, canAccessTrip } from '../db/database';
import { BudgetItem, BudgetItemMember } from '../types';
import { fetchExchangeRate } from '../utils/exchangeRate';

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
    SELECT bm.user_id, bm.amount_owed, bm.amount_paid, bm.amount_owed_ref, bm.amount_paid_ref, u.username, u.avatar
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
    'SELECT * FROM budget_items WHERE trip_id = ? ORDER BY is_draft ASC, category ASC, created_at ASC'
  ).all(tripId) as BudgetItem[];

  const itemIds = items.map(i => i.id);
  const membersByItem: Record<number, (BudgetItemMember & { avatar_url: string | null })[]> = {};

  if (itemIds.length > 0) {
    const allMembers = db.prepare(`
      SELECT bm.budget_item_id, bm.user_id, bm.amount_owed, bm.amount_paid, bm.amount_owed_ref, bm.amount_paid_ref, u.username, u.avatar
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

export async function createBudgetItem(
  tripId: string | number,
  data: {
    category?: string;
    name: string;
    total_price?: number;
    currency?: string;
    note?: string | null;
    expense_date?: string | null;
  },
) {
  const trip = db.prepare('SELECT currency FROM trips WHERE id = ?').get(tripId) as { currency: string } | undefined;
  const tripCurrency = trip?.currency || 'EUR';
  const itemCurrency = data.currency || tripCurrency;
  const totalPrice = data.total_price || 0;

  let exchangeRate: number | null = null;
  let totalPriceRef: number | null = null;

  if (itemCurrency !== tripCurrency) {
    const rate = await fetchExchangeRate(itemCurrency, tripCurrency);
    if (rate === null) throw new Error(`Could not fetch exchange rate for ${itemCurrency} → ${tripCurrency}`);
    exchangeRate = rate;
    totalPriceRef = Math.round(totalPrice * rate * 100) / 100;
  }

  const maxOrder = db.prepare(
    'SELECT MAX(sort_order) as max FROM budget_items WHERE trip_id = ?'
  ).get(tripId) as { max: number | null };
  const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const result = db.prepare(
    `INSERT INTO budget_items
      (trip_id, category, name, total_price, currency, total_price_ref, exchange_rate, tip, tip_ref, note, sort_order, expense_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tripId,
    data.category || 'Other',
    data.name,
    totalPrice,
    itemCurrency,
    totalPriceRef,
    exchangeRate,
    0,
    0,
    data.note || null,
    sortOrder,
    data.expense_date || null,
  );

  const item = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(result.lastInsertRowid) as BudgetItem & { members?: BudgetItemMember[] };
  item.members = [];
  return item;
}

export async function updateBudgetItem(
  id: string | number,
  tripId: string | number,
  data: {
    category?: string;
    name?: string;
    total_price?: number;
    currency?: string;
    note?: string | null;
    sort_order?: number;
    expense_date?: string | null;
  },
) {
  const item = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId) as BudgetItem | undefined;
  if (!item) return null;

  const trip = db.prepare('SELECT currency FROM trips WHERE id = ?').get(tripId) as { currency: string } | undefined;
  const tripCurrency = trip?.currency || 'EUR';
  const newCurrency = data.currency ?? item.currency;
  const newTotalPrice = data.total_price ?? item.total_price;

  let exchangeRate: number | null | undefined = undefined;
  let totalPriceRef: number | null | undefined = undefined;

  if (newCurrency === tripCurrency) {
    exchangeRate = null;
    totalPriceRef = null;
  } else {
    const currencyChanged = data.currency !== undefined && data.currency !== item.currency;
    const missingRate = !item.exchange_rate;
    if (currencyChanged || missingRate) {
      const rate = await fetchExchangeRate(newCurrency, tripCurrency);
      if (rate === null) throw new Error(`Could not fetch exchange rate for ${newCurrency} → ${tripCurrency}`);
      exchangeRate = rate;
    } else {
      exchangeRate = item.exchange_rate;
    }
    totalPriceRef = Math.round(newTotalPrice * (exchangeRate as number) * 100) / 100;
  }

  const hasRateUpdate = exchangeRate !== undefined;

  db.prepare(`
    UPDATE budget_items SET
      category     = COALESCE(?, category),
      name         = COALESCE(?, name),
      total_price  = CASE WHEN ? IS NOT NULL THEN ? ELSE total_price END,
      currency     = COALESCE(?, currency),
      total_price_ref = CASE WHEN ? THEN ? ELSE total_price_ref END,
      exchange_rate   = CASE WHEN ? THEN ? ELSE exchange_rate END,
      note         = CASE WHEN ? THEN ? ELSE note END,
      sort_order   = CASE WHEN ? IS NOT NULL THEN ? ELSE sort_order END,
      expense_date = CASE WHEN ? THEN ? ELSE expense_date END
    WHERE id = ?
  `).run(
    data.category || null,
    data.name || null,
    data.total_price !== undefined ? 1 : null, data.total_price !== undefined ? data.total_price : 0,
    data.currency || null,
    hasRateUpdate ? 1 : 0, hasRateUpdate ? totalPriceRef : null,
    hasRateUpdate ? 1 : 0, hasRateUpdate ? exchangeRate : null,
    data.note !== undefined ? 1 : 0, data.note !== undefined ? data.note : null,
    data.sort_order !== undefined ? 1 : null, data.sort_order !== undefined ? data.sort_order : 0,
    data.expense_date !== undefined ? 1 : 0, data.expense_date !== undefined ? (data.expense_date || null) : null,
    id,
  );

  // Recalculate member ref amounts from stored originals when the exchange rate changed
  if (hasRateUpdate) {
    const effectiveNewRate = (exchangeRate as number | null) ?? 1;
    const members = db.prepare('SELECT user_id, amount_owed, amount_paid FROM budget_item_members WHERE budget_item_id = ?').all(id) as { user_id: number; amount_owed: number; amount_paid: number }[];
    const update = db.prepare('UPDATE budget_item_members SET amount_owed_ref = ?, amount_paid_ref = ? WHERE budget_item_id = ? AND user_id = ?');
    db.transaction(() => {
      for (const m of members) {
        const owedRef = Math.round(m.amount_owed * effectiveNewRate * 100) / 100;
        const paidRef = Math.round(m.amount_paid * effectiveNewRate * 100) / 100;
        update.run(owedRef, paidRef, id, m.user_id);
      }
      const newTipRef = Math.round(item.tip * effectiveNewRate * 100) / 100;
      db.prepare('UPDATE budget_items SET tip_ref = ? WHERE id = ?').run(newTipRef, id);
    })();
  }

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
  members: { user_id: number; amount_owed: number }[],
  tip: number,
) {
  const item = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId) as BudgetItem | undefined;
  if (!item) return null;

  const rate = item.exchange_rate || 1;
  const individualSum = members.reduce((s, m) => s + (Number(m.amount_owed) || 0), 0);
  const effectiveTotal = individualSum + (Number(tip) || 0);

  if (Math.abs(effectiveTotal - item.total_price) > 0.01) {
    return { error: 'Owed amounts plus tip must sum to the total expense value' };
  }

  const tipValue = tip || 0;
  const tip_ref = Math.round(tipValue * rate * 100) / 100;

  db.transaction(() => {
    // Preserve existing paid values
    const existing = db.prepare('SELECT user_id, amount_paid, amount_paid_ref FROM budget_item_members WHERE budget_item_id = ?').all(id) as { user_id: number; amount_paid: number; amount_paid_ref: number }[];
    const paidByUser: Record<number, { amount_paid: number; amount_paid_ref: number }> = {};
    for (const e of existing) paidByUser[e.user_id] = { amount_paid: e.amount_paid, amount_paid_ref: e.amount_paid_ref };

    db.prepare('DELETE FROM budget_item_members WHERE budget_item_id = ?').run(id);

    const insert = db.prepare('INSERT INTO budget_item_members (budget_item_id, user_id, amount_owed, amount_owed_ref, amount_paid, amount_paid_ref) VALUES (?, ?, ?, ?, ?, ?)');
    for (const m of members) {
      const amount_owed_ref = Math.round((m.amount_owed || 0) * rate * 100) / 100;
      const prev = paidByUser[m.user_id];
      insert.run(id, m.user_id, m.amount_owed || 0, amount_owed_ref, prev?.amount_paid || 0, prev?.amount_paid_ref || 0);
    }

    db.prepare('UPDATE budget_items SET tip = ?, tip_ref = ? WHERE id = ?').run(tipValue, tip_ref, id);
  })();

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
  payments: { user_id: number; amount_paid: number }[],
) {
  const item = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId) as BudgetItem | undefined;
  if (!item) return null;

  const rate = item.exchange_rate || 1;
  const totalPaid = payments.reduce((s, p) => s + (Number(p.amount_paid) || 0), 0);
  const allZero = totalPaid < 0.01;

  if (!allZero && Math.abs(totalPaid - item.total_price) > 0.01) {
    return { error: 'Paid amounts must sum to the total expense value, or all be zero' };
  }

  const existingMemberIds = new Set(
    (db.prepare('SELECT user_id FROM budget_item_members WHERE budget_item_id = ?').all(id) as { user_id: number }[]).map(r => r.user_id)
  );
  const unknownPayers = payments.filter(p => Number(p.amount_paid) > 0.001 && !existingMemberIds.has(p.user_id));
  if (unknownPayers.length > 0) {
    return { error: 'Payer is not in the owed-amounts list for this expense' };
  }

  const upsert = db.prepare(`
    INSERT INTO budget_item_members (budget_item_id, user_id, amount_owed, amount_owed_ref, amount_paid, amount_paid_ref)
    VALUES (?, ?, 0, 0, ?, ?)
    ON CONFLICT(budget_item_id, user_id) DO UPDATE SET amount_paid = excluded.amount_paid, amount_paid_ref = excluded.amount_paid_ref
  `);
  for (const p of payments) {
    const amount_paid_ref = Math.round((p.amount_paid || 0) * rate * 100) / 100;
    upsert.run(id, p.user_id, p.amount_paid || 0, amount_paid_ref);
  }

  const members = loadItemMembers(id).map(m => ({ ...m, avatar_url: avatarUrl(m) }));
  return { members };
}

// ---------------------------------------------------------------------------
// Settlement calculation (greedy debt matching — fully data-driven)
// ---------------------------------------------------------------------------

export function calculateSettlement(tripId: string | number) {
  const trip = db.prepare('SELECT currency FROM trips WHERE id = ?').get(tripId) as { currency: string } | undefined;
  const settlementCurrency = trip?.currency || 'EUR';

  const items = db.prepare('SELECT * FROM budget_items WHERE trip_id = ? AND is_draft = 0').all(tripId) as BudgetItem[];
  const allMembers = db.prepare(`
    SELECT bm.budget_item_id, bm.user_id, bm.amount_owed, bm.amount_paid, bm.amount_owed_ref, bm.amount_paid_ref, u.username, u.avatar
    FROM budget_item_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id IN (SELECT id FROM budget_items WHERE trip_id = ? AND is_draft = 0)
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

  const incomplete: { id: number; name: string; reason: 'no_members' | 'no_owed' | 'no_paid' }[] = [];

  for (const item of items) {
    const members = allMembers.filter(m => m.budget_item_id === item.id);
    if (members.length === 0) {
      incomplete.push({ id: item.id, name: item.name, reason: 'no_members' });
      continue;
    }

    const totalOwed = members.reduce((s, m) => s + m.amount_owed_ref, 0);
    const totalPaid = members.reduce((s, m) => s + m.amount_paid_ref, 0);

    if (totalOwed < 0.01) {
      incomplete.push({ id: item.id, name: item.name, reason: 'no_owed' });
      continue;
    }
    if (totalPaid < 0.01) {
      incomplete.push({ id: item.id, name: item.name, reason: 'no_paid' });
      continue;
    }

    const tipRef = item.tip_ref ?? 0;
    const tipPerMember = Math.round((tipRef / members.length) * 100) / 100;
    const tipRemainder = Math.round((tipRef - tipPerMember * (members.length - 1)) * 100) / 100;

    for (let mi = 0; mi < members.length; mi++) {
      const m = members[mi];
      const memberTip = mi === members.length - 1 ? tipRemainder : tipPerMember;
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
      const charged = m.amount_owed_ref + memberTip;
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
    const transfer = Math.round(Math.min(debtors[di].amount, creditors[ci].amount) * 100) / 100;
    if (transfer > 0.01) {
      flows.push({
        from: { user_id: debtors[di].user_id, username: debtors[di].username, avatar_url: debtors[di].avatar_url },
        to: { user_id: creditors[ci].user_id, username: creditors[ci].username, avatar_url: creditors[ci].avatar_url },
        amount: transfer,
      });
    }
    debtors[di].amount = Math.round((debtors[di].amount - transfer) * 100) / 100;
    creditors[ci].amount = Math.round((creditors[ci].amount - transfer) * 100) / 100;
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
    incomplete,
  };
}

// ---------------------------------------------------------------------------
// Draft budget entries — linked to day_assignments
// ---------------------------------------------------------------------------

function getTripMemberIds(tripId: string | number): number[] {
  const rows = db.prepare(`
    SELECT user_id FROM trip_members WHERE trip_id = ?
    UNION SELECT user_id FROM trips WHERE id = ?
  `).all(tripId, tripId) as { user_id: number }[];
  return rows.map(r => r.user_id);
}

export function createDraftFromAssignment(
  tripId: string | number,
  assignmentId: number | bigint,
  placeName: string,
  price: number,
  currency: string | null,
  expenseDate: string | null,
  assignmentNotes: string | null,
  participantUserIds: number[],
): number | null {
  if (!price || price <= 0) return null;

  const trip = db.prepare('SELECT currency FROM trips WHERE id = ?').get(tripId) as { currency: string } | undefined;
  const itemCurrency = currency || trip?.currency || 'EUR';
  const name = assignmentNotes ? `${placeName} — ${assignmentNotes}` : placeName;

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM budget_items WHERE trip_id = ?').get(tripId) as { max: number | null };
  const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const result = db.prepare(`
    INSERT INTO budget_items (trip_id, category, name, total_price, currency, tip_ref, sort_order, expense_date, is_draft, linked_assignment_id)
    VALUES (?, 'Activities', ?, ?, ?, 0, ?, ?, 1, ?)
  `).run(tripId, name, price, itemCurrency, sortOrder, expenseDate || null, assignmentId);

  const draftId = Number(result.lastInsertRowid);
  const memberIds = participantUserIds.length > 0 ? participantUserIds : getTripMemberIds(tripId);

  if (memberIds.length > 0) {
    const n = memberIds.length;
    const share = Math.round(price / n * 100) / 100;
    const lastShare = Math.round((price - share * (n - 1)) * 100) / 100;
    const insert = db.prepare(`
      INSERT INTO budget_item_members (budget_item_id, user_id, amount_owed, amount_owed_ref, amount_paid, amount_paid_ref, synced_amount_owed_ref)
      VALUES (?, ?, ?, ?, 0, 0, ?)
    `);
    memberIds.forEach((uid, i) => {
      const amount = i === n - 1 ? lastShare : share;
      insert.run(draftId, uid, amount, amount, amount);
    });
  }

  db.prepare('UPDATE day_assignments SET draft_budget_entry_id = ? WHERE id = ?').run(draftId, assignmentId);
  return draftId;
}

export function syncDraftMembers(
  draftId: number,
  newParticipantIds: number[],
  tripId: string | number,
): void {
  const draft = db.prepare('SELECT total_price FROM budget_items WHERE id = ? AND is_draft = 1').get(draftId) as { total_price: number } | undefined;
  if (!draft) return;

  const totalPrice = draft.total_price;
  const memberIds = newParticipantIds.length > 0 ? newParticipantIds : getTripMemberIds(tripId);

  const existing = db.prepare(`
    SELECT user_id, amount_owed_ref, synced_amount_owed_ref FROM budget_item_members WHERE budget_item_id = ?
  `).all(draftId) as { user_id: number; amount_owed_ref: number; synced_amount_owed_ref: number | null }[];

  const existingByUser = new Map(existing.map(r => [r.user_id, r]));
  const userEditedIds = new Set(
    existing
      .filter(r => r.synced_amount_owed_ref !== null && Math.abs(r.amount_owed_ref - r.synced_amount_owed_ref) > 0.005)
      .map(r => r.user_id)
  );

  const newIdSet = new Set(memberIds);
  for (const [removedId] of existingByUser) {
    if (!newIdSet.has(removedId)) {
      if (userEditedIds.has(removedId)) {
        db.prepare('UPDATE budget_item_members SET amount_owed_ref = 0, synced_amount_owed_ref = 0 WHERE budget_item_id = ? AND user_id = ?').run(draftId, removedId);
      } else {
        db.prepare('DELETE FROM budget_item_members WHERE budget_item_id = ? AND user_id = ?').run(draftId, removedId);
      }
    }
  }

  const editedAllocated = memberIds.filter(id => userEditedIds.has(id)).reduce((sum, id) => sum + (existingByUser.get(id)?.amount_owed_ref || 0), 0);
  const nonEditedIds = memberIds.filter(id => !userEditedIds.has(id));
  const remaining = Math.max(0, totalPrice - editedAllocated);
  const n = nonEditedIds.length;

  const upsert = db.prepare(`
    INSERT INTO budget_item_members (budget_item_id, user_id, amount_owed, amount_owed_ref, amount_paid, amount_paid_ref, synced_amount_owed_ref)
    VALUES (?, ?, ?, ?, 0, 0, ?)
    ON CONFLICT(budget_item_id, user_id) DO UPDATE SET amount_owed = excluded.amount_owed, amount_owed_ref = excluded.amount_owed_ref, synced_amount_owed_ref = excluded.synced_amount_owed_ref
  `);
  nonEditedIds.forEach((uid, i) => {
    const share = n > 0 ? Math.round(remaining / n * 100) / 100 : 0;
    const amount = n > 0 && i === n - 1 ? Math.round((remaining - share * (n - 1)) * 100) / 100 : share;
    upsert.run(draftId, uid, amount, amount, amount);
  });
}

export function syncDraftDate(draftId: number, date: string | null): void {
  db.prepare('UPDATE budget_items SET expense_date = ? WHERE id = ? AND is_draft = 1').run(date || null, draftId);
}

export function convertDraftToReal(id: string | number, tripId: string | number) {
  const item = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ? AND is_draft = 1').get(id, tripId) as BudgetItem | undefined;
  if (!item) return null;
  db.prepare('UPDATE budget_items SET is_draft = 0, linked_assignment_id = NULL WHERE id = ?').run(id);
  // Keep draft_budget_entry_id on assignment so the badge can still navigate to the real entry.
  const updated = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(id) as BudgetItem & { members?: BudgetItemMember[] };
  updated.members = loadItemMembers(id);
  return updated;
}

export function deleteDraftForAssignment(assignmentId: number): void {
  const draft = db.prepare('SELECT id FROM budget_items WHERE linked_assignment_id = ? AND is_draft = 1').get(assignmentId) as { id: number } | undefined;
  if (draft) db.prepare('DELETE FROM budget_items WHERE id = ?').run(draft.id);
}

export function listDraftBudgetItems(tripId: string | number) {
  const items = db.prepare(
    'SELECT * FROM budget_items WHERE trip_id = ? AND is_draft = 1 ORDER BY created_at ASC'
  ).all(tripId) as BudgetItem[];
  const itemIds = items.map(i => i.id);
  if (itemIds.length === 0) return items.map(i => ({ ...i, members: [] }));
  const allMembers = db.prepare(`
    SELECT bm.budget_item_id, bm.user_id, bm.amount_owed_ref, bm.amount_paid_ref, u.username, u.avatar
    FROM budget_item_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id IN (${itemIds.map(() => '?').join(',')})
  `).all(...itemIds) as (BudgetItemMember & { budget_item_id: number })[];
  const membersByItem: Record<number, (BudgetItemMember & { avatar_url: string | null })[]> = {};
  for (const m of allMembers) {
    if (!membersByItem[m.budget_item_id]) membersByItem[m.budget_item_id] = [];
    membersByItem[m.budget_item_id].push({ ...m, avatar_url: avatarUrl(m) });
  }
  items.forEach(item => { (item as any).members = membersByItem[item.id] || []; });
  return items;
}

// Set (or create) the draft price for a specific assignment.
// When price is null/0 and a draft exists, the draft is deleted.
export function setAssignmentDraftPrice(
  tripId: string | number,
  assignmentId: number,
  price: number | null,
  currency: string | null,
): { draft_budget_entry_id: number | null; budget_entry_is_draft: number | null; budget_entry_price: number | null; budget_entry_currency: string | null } {
  const assignment = db.prepare(`
    SELECT da.id, da.draft_budget_entry_id, da.notes, da.day_id,
      p.name as place_name, p.currency as place_currency
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    WHERE da.id = ?
  `).get(assignmentId) as { id: number; draft_budget_entry_id: number | null; notes: string | null; day_id: number; place_name: string; place_currency: string | null } | undefined;

  if (!assignment) return { draft_budget_entry_id: null, budget_entry_is_draft: null, budget_entry_price: null, budget_entry_currency: null };

  const effectiveCurrency = currency || assignment.place_currency;
  const existingDraftId = assignment.draft_budget_entry_id;

  // Price cleared: delete draft if it's still a draft
  if (!price || price <= 0) {
    if (existingDraftId) {
      const draft = db.prepare('SELECT is_draft FROM budget_items WHERE id = ?').get(existingDraftId) as { is_draft: number } | undefined;
      if (draft?.is_draft) {
        db.prepare('DELETE FROM budget_items WHERE id = ?').run(existingDraftId);
        db.prepare('UPDATE day_assignments SET draft_budget_entry_id = NULL WHERE id = ?').run(assignmentId);
      }
    }
    return { draft_budget_entry_id: null, budget_entry_is_draft: null, budget_entry_price: null, budget_entry_currency: null };
  }

  // Draft exists and is still a draft: update price and recalculate equal split
  if (existingDraftId) {
    const draft = db.prepare('SELECT is_draft, total_price FROM budget_items WHERE id = ?').get(existingDraftId) as { is_draft: number; total_price: number } | undefined;
    if (draft?.is_draft) {
      db.prepare('UPDATE budget_items SET total_price = ?, currency = ? WHERE id = ?').run(price, effectiveCurrency, existingDraftId);
      // Recalculate equal split for all members
      const members = db.prepare('SELECT user_id FROM budget_item_members WHERE budget_item_id = ?').all(existingDraftId) as { user_id: number }[];
      const n = members.length;
      if (n > 0) {
        const share = Math.round(price / n * 100) / 100;
        const upsert = db.prepare('UPDATE budget_item_members SET amount_owed_ref = ?, synced_amount_owed_ref = ? WHERE budget_item_id = ? AND user_id = ?');
        members.forEach((m, i) => {
          const amount = i === n - 1 ? Math.round((price - share * (n - 1)) * 100) / 100 : share;
          upsert.run(amount, amount, existingDraftId, m.user_id);
        });
      }
      return { draft_budget_entry_id: existingDraftId, budget_entry_is_draft: 1, budget_entry_price: price, budget_entry_currency: effectiveCurrency };
    }
    // Already converted: don't touch the real entry, just return current state
    return { draft_budget_entry_id: existingDraftId, budget_entry_is_draft: 0, budget_entry_price: draft?.total_price ?? price, budget_entry_currency: effectiveCurrency };
  }

  // No draft yet: create one
  const day = db.prepare('SELECT date FROM days WHERE id = ?').get(assignment.day_id) as { date: string | null } | undefined;
  const draftId = createDraftFromAssignment(tripId, assignmentId, assignment.place_name, price, effectiveCurrency, day?.date || null, assignment.notes, []);
  return { draft_budget_entry_id: draftId, budget_entry_is_draft: 1, budget_entry_price: price, budget_entry_currency: effectiveCurrency };
}
