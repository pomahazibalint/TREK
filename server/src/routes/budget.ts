import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import { db } from '../db/database';
import {
  verifyTripAccess,
  listBudgetItems,
  listDraftBudgetItems,
  createBudgetItem,
  updateBudgetItem,
  deleteBudgetItem,
  updateMemberOwed,
  updateMemberPayments,
  calculateSettlement,
  convertDraftToReal,
  settleBudget,
  discardDraft,
} from '../services/budgetService';
import { send } from '../services/notificationService';
import { resolveRecipients } from '../services/inAppNotifications';
import { listFilesForBudgetItem } from '../services/fileService';

const router = express.Router({ mergeParams: true });

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  res.json({ items: listBudgetItems(tripId) });
});

router.post('/', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  try {
    const item = await createBudgetItem(tripId, req.body);
    res.status(201).json({ item });
    broadcast(tripId, 'budget:created', { item }, req.headers['x-socket-id'] as string);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create expense' });
  }
});

router.put('/:id', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  try {
    const updated = await updateBudgetItem(id, tripId, req.body);
    if (!updated) return res.status(404).json({ error: 'Budget item not found' });

    // Sync price back to linked reservation
    if (updated.reservation_id && req.body.total_price !== undefined) {
      try {
        const reservation = db.prepare('SELECT id, metadata FROM reservations WHERE id = ? AND trip_id = ?').get(updated.reservation_id, tripId) as { id: number; metadata: string | null } | undefined;
        if (reservation) {
          const meta = reservation.metadata ? JSON.parse(reservation.metadata) : {};
          meta.price = String(updated.total_price);
          db.prepare('UPDATE reservations SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), reservation.id);
          const updatedRes = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservation.id);
          broadcast(tripId, 'reservation:updated', { reservation: updatedRes }, req.headers['x-socket-id'] as string);
        }
      } catch (err) {
        console.error('[budget] Failed to sync price to reservation:', err);
      }
    }

    res.json({ item: updated });
    broadcast(tripId, 'budget:updated', { item: updated }, req.headers['x-socket-id'] as string);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to update expense' });
  }
});

// Set who owes how much (beneficiary side) + tip
router.put('/:id/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { members, tip = 0 } = req.body;
  if (!Array.isArray(members)) return res.status(400).json({ error: 'members must be an array' });

  const result = updateMemberOwed(id, tripId, members, tip);
  if (!result) return res.status(404).json({ error: 'Budget item not found' });
  if ('error' in result) return res.status(400).json({ error: result.error });

  res.json({ members: result.members, item: result.item });
  broadcast(Number(tripId), 'budget:members-updated', { itemId: Number(id), members: result.members, tip_ref: result.item.tip_ref }, req.headers['x-socket-id'] as string);
});

// Set who paid how much
router.put('/:id/members/payments', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { payments } = req.body;
  if (!Array.isArray(payments)) return res.status(400).json({ error: 'payments must be an array' });

  const result = updateMemberPayments(id, tripId, payments);
  if (!result) return res.status(404).json({ error: 'Budget item not found' });
  if ('error' in result) return res.status(400).json({ error: result.error });

  res.json({ members: result.members });
  broadcast(Number(tripId), 'budget:members-payments-updated', { itemId: Number(id), members: result.members }, req.headers['x-socket-id'] as string);
});

router.post('/settle', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_settle', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const result = settleBudget(tripId, authReq.user.id);
  if ('error' in result) {
    if (result.error === 'has_drafts') return res.status(409).json({ error: 'has_drafts', count: (result as any).count });
    return res.status(409).json({ error: result.error });
  }

  const settlement = calculateSettlement(tripId);
  const participants = resolveRecipients('trip', Number(tripId), null);
  const actorUsername = (db.prepare('SELECT username FROM users WHERE id = ?').get(authReq.user.id) as { username: string } | undefined)?.username || '';
  const tripTitle = (db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined)?.title || '';

  broadcast(tripId, 'trip:settled', { settled_at: result.settled_at, settled_by: result.settled_by, settled_by_username: result.settled_by_username }, req.headers['x-socket-id'] as string);

  setImmediate(async () => {
    for (const participantId of participants) {
      const owing = settlement.flows.filter(f => f.from.user_id === participantId);
      const owed = settlement.flows.filter(f => f.to.user_id === participantId);
      let balanceText = '';
      if (owing.length === 0 && owed.length === 0) {
        balanceText = "You're all settled!";
      } else {
        const parts: string[] = [];
        for (const f of owing) parts.push(`You owe ${f.to.username} ${f.amount.toFixed(2)} ${settlement.settlement_currency}`);
        for (const f of owed) parts.push(`${f.from.username} owes you ${f.amount.toFixed(2)} ${settlement.settlement_currency}`);
        balanceText = parts.join('; ');
      }

      await send({
        event: 'budget_settlement',
        actorId: authReq.user.id,
        params: { actor: actorUsername, trip: tripTitle, tripId: String(tripId), balance_text: balanceText },
        scope: 'user',
        targetId: participantId,
        inApp: {
          type: 'boolean',
          positiveTextKey: 'notif.action.ive_paid',
          negativeTextKey: 'notif.action.dismiss',
          positiveCallback: { action: 'budget_settlement_ack', payload: { tripId: Number(tripId), userId: participantId } },
          negativeCallback: { action: 'noop', payload: {} },
          navigateTarget: `/trips/${tripId}?tab=budget`,
        },
      });
    }
  });

  const updatedTrip = db.prepare(`
    SELECT t.*, (SELECT username FROM users WHERE id = t.settled_by) as settled_by_username
    FROM trips t WHERE t.id = ?
  `).get(tripId);
  res.json({ trip: updatedTrip });
});

router.get('/settlement', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  if (!verifyTripAccess(Number(tripId), authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  res.json(calculateSettlement(tripId));
});

router.get('/:id/files', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  res.json({ files: listFilesForBudgetItem(id) });
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!deleteBudgetItem(id, tripId))
    return res.status(404).json({ error: 'Budget item not found' });

  res.json({ success: true });
  broadcast(tripId, 'budget:deleted', { itemId: Number(id) }, req.headers['x-socket-id'] as string);
});

router.get('/drafts', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  res.json({ items: listDraftBudgetItems(tripId) });
});

router.delete('/:id/draft', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const result = discardDraft(id, tripId);
  if ('error' in result) return res.status(result.error === 'not_found' ? 404 : 400).json({ error: result.error });

  res.json({ success: true });
  broadcast(tripId, 'budget:deleted', { itemId: Number(id) }, req.headers['x-socket-id'] as string);
  if ('assignmentUpdate' in result && result.assignmentUpdate) {
    broadcast(tripId, 'assignment:draft-price', result.assignmentUpdate, req.headers['x-socket-id'] as string);
  }
});

router.post('/:id/convert', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const trip = verifyTripAccess(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  const item = convertDraftToReal(id, tripId);
  if (!item) return res.status(404).json({ error: 'Draft not found' });
  res.json({ item });
  broadcast(tripId, 'budget:converted', { item }, req.headers['x-socket-id'] as string);
});

export default router;
