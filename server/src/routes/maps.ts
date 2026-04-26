import crypto from 'crypto';
import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { isAddonEnabled } from '../services/adminService';
import { AuthRequest } from '../types';
import { db } from '../db/database';
import {
  searchPlaces,
  autocompletePlaces,
  getPlaceDetails,
  getPlacePhoto,
  reverseGeocode,
  resolveGoogleMapsUrl,
} from '../services/mapsService';

const router = express.Router();

// POST /autocomplete
router.post('/autocomplete', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { input } = req.body;

  if (!input || typeof input !== 'string') return res.status(400).json({ error: 'input is required' });
  if (input.length > 200) return res.status(400).json({ error: 'input too long' });

  try {
    const result = await autocompletePlaces(authReq.user.id, input, req.query.lang as string);
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 500;
    const message = err instanceof Error ? err.message : 'Autocomplete error';
    res.status(status).json({ error: message });
  }
});

// POST /search
router.post('/search', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { query } = req.body;

  if (!query) return res.status(400).json({ error: 'Search query is required' });

  try {
    const result = await searchPlaces(authReq.user.id, query, req.query.lang as string);
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 500;
    const message = err instanceof Error ? err.message : 'Search error';
    console.error('Maps search error:', err);
    res.status(status).json({ error: message });
  }
});

// GET /details/:placeId
router.get('/details/:placeId', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { placeId } = req.params;

  try {
    const result = await getPlaceDetails(authReq.user.id, placeId, req.query.lang as string);
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 500;
    const message = err instanceof Error ? err.message : 'Error fetching place details';
    console.error('Maps details error:', err);
    res.status(status).json({ error: message });
  }
});

// GET /place-photo/:placeId
router.get('/place-photo/:placeId', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { placeId } = req.params;
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  try {
    const result = await getPlacePhoto(authReq.user.id, placeId, lat, lng, req.query.name as string);
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 500;
    const message = err instanceof Error ? err.message : 'Error fetching photo';
    if (status >= 500) console.error('Place photo error:', err);
    res.status(status).json({ error: message });
  }
});

// GET /reverse
router.get('/reverse', authenticate, async (req: Request, res: Response) => {
  const { lat, lng, lang } = req.query as { lat: string; lng: string; lang?: string };
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  try {
    const result = await reverseGeocode(lat, lng, lang);
    res.json(result);
  } catch {
    res.json({ name: null, address: null });
  }
});

// POST /resolve-url
router.post('/elevation', authenticate, async (req: Request, res: Response) => {
  if (!isAddonEnabled('elevation')) {
    return res.status(403).json({ error: 'Elevation addon is disabled' });
  }
  const { locations } = req.body;
  if (!Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: 'locations array is required' });
  }
  const locationStr = locations.map((l: { latitude: number; longitude: number }) => `${l.latitude},${l.longitude}`).join('|');
  const locationHash = crypto.createHash('sha256').update(locationStr).digest('hex').slice(0, 32);

  const cached = db.prepare('SELECT results FROM elevation_cache WHERE location_hash = ?').get(locationHash) as { results: string } | undefined;
  if (cached) {
    try { return res.json({ results: JSON.parse(cached.results) }); } catch { /* corrupt — fall through */ }
  }

  try {
    const response = await fetch(`https://api.opentopodata.org/v1/srtm90m?locations=${locationStr}`);
    if (!response.ok) throw new Error(`Open-Topo-Data error: ${response.status}`);
    const data = await response.json() as { results?: { elevation: number | null }[] };
    const results = (data.results || []).map(r => ({ elevation: r.elevation ?? 0 }));
    try { db.prepare('INSERT OR REPLACE INTO elevation_cache (location_hash, results) VALUES (?, ?)').run(locationHash, JSON.stringify(results)); } catch { /* non-fatal */ }
    res.json({ results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Elevation fetch failed';
    res.status(502).json({ error: message });
  }
});

router.post('/resolve-url', authenticate, async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL is required' });

  try {
    const result = await resolveGoogleMapsUrl(url);
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 400;
    const message = err instanceof Error ? err.message : 'Failed to resolve URL';
    console.error('[Maps] URL resolve error:', message);
    res.status(status).json({ error: message });
  }
});

export default router;
