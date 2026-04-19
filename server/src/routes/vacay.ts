import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import * as svc from '../services/vacayService';

const router = express.Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Plan list and creation
// ---------------------------------------------------------------------------

router.get('/plans', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json({ plans: svc.getAllPlansData(authReq.user.id) });
});

router.post('/plans', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const plan = svc.createPlan(authReq.user.id, name);
  res.json({ plan });
});

// ---------------------------------------------------------------------------
// Per-plan middleware — resolves planId and checks access
// ---------------------------------------------------------------------------

function requirePlanAccess(req: Request, res: Response, next: () => void) {
  const authReq = req as AuthRequest;
  const planId = parseInt(req.params.planId);
  if (isNaN(planId)) return res.status(400).json({ error: 'Invalid plan id' });

  const data = svc.getPlanData(authReq.user.id, planId);
  if (!data) return res.status(404).json({ error: 'Not found' });

  (req as AuthRequest & { planId: number; planData: ReturnType<typeof svc.getPlanData> }).planId = planId;
  (req as AuthRequest & { planId: number; planData: ReturnType<typeof svc.getPlanData> }).planData = data;
  next();
}

function requireOwner(req: Request, res: Response, next: () => void) {
  const authReq = req as AuthRequest & { planData: ReturnType<typeof svc.getPlanData> };
  if (!authReq.planData?.isOwner) return res.status(403).json({ error: 'Owner only' });
  next();
}

// ---------------------------------------------------------------------------
// Plan data
// ---------------------------------------------------------------------------

router.get('/plans/:planId', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planData: ReturnType<typeof svc.getPlanData> };
  res.json(r.planData);
});

router.put('/plans/:planId', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, async (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const result = await svc.updatePlan(r.planId, req.body, req.headers['x-socket-id'] as string);
  res.json(result);
});

// ---------------------------------------------------------------------------
// Holiday calendars
// ---------------------------------------------------------------------------

router.post('/plans/:planId/holiday-calendars', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const { region, label, color, sort_order } = req.body;
  if (!region) return res.status(400).json({ error: 'region required' });
  const calendar = svc.addHolidayCalendar(r.planId, region, label, color, sort_order, req.headers['x-socket-id'] as string);
  res.json({ calendar });
});

router.put('/plans/:planId/holiday-calendars/:id', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const id = parseInt(req.params.id);
  const calendar = svc.updateHolidayCalendar(id, r.planId, req.body, req.headers['x-socket-id'] as string);
  if (!calendar) return res.status(404).json({ error: 'Calendar not found' });
  res.json({ calendar });
});

router.delete('/plans/:planId/holiday-calendars/:id', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const id = parseInt(req.params.id);
  const deleted = svc.deleteHolidayCalendar(id, r.planId, req.headers['x-socket-id'] as string);
  if (!deleted) return res.status(404).json({ error: 'Calendar not found' });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

router.put('/plans/:planId/color', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const { color, target_user_id } = req.body;
  const userId = target_user_id ? parseInt(target_user_id) : r.user.id;
  const planUsers = svc.getPlanUsers(r.planId);
  if (!planUsers.find(u => u.id === userId)) {
    return res.status(403).json({ error: 'User not in plan' });
  }
  svc.setUserColor(userId, r.planId, color, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

router.post('/plans/:planId/invite', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const result = svc.sendInvite(r.planId, r.user.id, r.user.username, r.user.email, user_id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

router.post('/invite/accept', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { plan_id } = req.body;
  const result = svc.acceptInvite(authReq.user.id, plan_id, req.headers['x-socket-id'] as string);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

router.post('/invite/decline', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { plan_id } = req.body;
  svc.declineInvite(authReq.user.id, plan_id, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

router.post('/plans/:planId/invite/cancel', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const { user_id } = req.body;
  svc.cancelInvite(r.planId, user_id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Leave / delete calendar
// ---------------------------------------------------------------------------

router.post('/plans/:planId/leave', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const result = svc.leaveCalendar(r.user.id, r.planId, req.headers['x-socket-id'] as string);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Available users
// ---------------------------------------------------------------------------

router.get('/plans/:planId/available-users', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const users = svc.getAvailableUsers(r.user.id, r.planId);
  res.json({ users });
});

// ---------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------

router.get('/plans/:planId/years', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  res.json({ years: svc.listYears(r.planId) });
});

router.post('/plans/:planId/years', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const { year } = req.body;
  if (!year) return res.status(400).json({ error: 'Year required' });
  const years = svc.addYear(r.planId, year, req.headers['x-socket-id'] as string);
  res.json({ years });
});

router.delete('/plans/:planId/years/:year', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const year = parseInt(req.params.year);
  const years = svc.deleteYear(r.planId, year, req.headers['x-socket-id'] as string);
  res.json({ years });
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

router.get('/plans/:planId/entries/:year', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  res.json(svc.getEntries(r.planId, req.params.year, r.user.id));
});

router.post('/plans/:planId/entries/toggle', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const { date, target_user_id } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  let userId = r.user.id;
  if (target_user_id && parseInt(target_user_id) !== r.user.id) {
    const planUsers = svc.getPlanUsers(r.planId);
    const tid = parseInt(target_user_id);
    if (!planUsers.find(u => u.id === tid)) {
      return res.status(403).json({ error: 'User not in plan' });
    }
    userId = tid;
  }
  res.json(svc.toggleEntry(userId, r.planId, date, req.headers['x-socket-id'] as string));
});

router.post('/plans/:planId/entries/batch', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const body = req.body;
  if (!Array.isArray(body.dates) || body.dates.length === 0) return res.status(400).json({ error: 'dates required' });
  const note        = 'note'        in body ? (body.note        ?? '') : null;
  const event_name  = 'event_name'  in body ? (body.event_name  ?? '') : null;
  const location    = 'location'    in body ? (body.location    ?? '') : null;
  const show_details = 'show_details' in body ? (body.show_details ? 1 : 0) : null;
  svc.batchEntries(r.user.id, r.planId, body.dates, note, event_name, location, show_details, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

router.delete('/plans/:planId/entries/batch', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const { dates } = req.body;
  if (!Array.isArray(dates) || dates.length === 0) return res.status(400).json({ error: 'dates required' });
  svc.removeEntries(r.user.id, r.planId, dates, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

router.post('/plans/:planId/entries/company-holiday', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const { date, note } = req.body;
  res.json(svc.toggleCompanyHoliday(r.planId, date, note, req.headers['x-socket-id'] as string));
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

router.get('/plans/:planId/stats/:year', requirePlanAccess as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const year = parseInt(req.params.year);
  res.json({ stats: svc.getStats(r.planId, year) });
});

router.put('/plans/:planId/stats/:year', requirePlanAccess as express.RequestHandler, requireOwner as express.RequestHandler, (req: Request, res: Response) => {
  const r = req as AuthRequest & { planId: number };
  const year = parseInt(req.params.year);
  const { vacation_days, target_user_id } = req.body;
  const userId = target_user_id ? parseInt(target_user_id) : r.user.id;
  const planUsers = svc.getPlanUsers(r.planId);
  if (!planUsers.find(u => u.id === userId)) {
    return res.status(403).json({ error: 'User not in plan' });
  }
  svc.updateStats(userId, r.planId, year, vacation_days, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.put('/settings/share-details-default', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { value } = req.body;
  svc.setShareDetailsDefault(authReq.user.id, !!value);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Holidays proxy
// ---------------------------------------------------------------------------

router.get('/holidays/countries', async (_req: Request, res: Response) => {
  const result = await svc.getCountries();
  if (result.error) return res.status(502).json({ error: result.error });
  res.json(result.data);
});

router.get('/holidays/:year/:country', async (req: Request, res: Response) => {
  const { year, country } = req.params;
  const result = await svc.getHolidays(year, country);
  if (result.error) return res.status(502).json({ error: result.error });
  res.json(result.data);
});

export default router;
