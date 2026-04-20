import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db, canAccessTrip } from '../db/database';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { AuthRequest } from '../types';
import { extractExif } from '../services/exifService';
import { reverseGeocode } from '../services/geocodeService';

const router = express.Router({ mergeParams: true });

const photosDir = path.join(__dirname, '../../uploads/photos');

const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });
    cb(null, photosDir);
  },
  filename: (_req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const uploadPhotos = multer({
  storage: photoStorage,
  limits: { fileSize: 50 * 1024 * 1024, files: 30 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('image/') && ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  },
});

// ── GET /api/trips/:tripId/photos ──────────────────────────────────────────

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const access = canAccessTrip(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  const photos = db.prepare(`
    SELECT id, trip_id, day_id, place_id, filename, original_name, file_size, mime_type,
           caption, taken_at, latitude, longitude, city, country,
           camera_make, camera_model, width, height, created_at,
           '/uploads/photos/' || filename AS url
    FROM photos
    WHERE trip_id = ?
    ORDER BY COALESCE(taken_at, created_at) ASC
  `).all(tripId);

  res.json({ photos });
});

// ── POST /api/trips/:tripId/photos ─────────────────────────────────────────

router.post('/', authenticate, demoUploadBlock, uploadPhotos.array('photos', 30), async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const access = canAccessTrip(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  const files = (req.files as Express.Multer.File[]) || [];
  if (files.length === 0) return res.status(400).json({ error: 'No photos uploaded' });

  const dayId = req.body.day_id ? Number(req.body.day_id) : null;
  const placeId = req.body.place_id ? Number(req.body.place_id) : null;
  const caption = req.body.caption?.trim() || null;

  const inserted: any[] = [];

  for (const file of files) {
    const exif = await extractExif(file.path);
    const result = db.prepare(`
      INSERT INTO photos (trip_id, day_id, place_id, filename, original_name, file_size, mime_type,
                          caption, taken_at, latitude, longitude, camera_make, camera_model, width, height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tripId, dayId, placeId,
      file.filename, file.originalname, file.size, file.mimetype,
      caption, exif.takenAt,
      exif.latitude, exif.longitude,
      exif.cameraMake, exif.cameraModel,
      exif.width, exif.height,
    );
    inserted.push({ id: result.lastInsertRowid, filename: file.filename, lat: exif.latitude, lng: exif.longitude });
  }

  // Return immediately — geocoding happens async
  res.json({
    photos: inserted.map(p => ({
      ...db.prepare(`
        SELECT id, trip_id, day_id, place_id, filename, original_name, file_size, mime_type,
               caption, taken_at, latitude, longitude, city, country,
               camera_make, camera_model, width, height, created_at,
               '/uploads/photos/' || filename AS url
        FROM photos WHERE id = ?
      `).get(p.id),
    })),
  });

  // Geocode in background, sequentially to respect rate limit
  setImmediate(async () => {
    for (const p of inserted) {
      if (p.lat == null || p.lng == null) continue;
      const geo = await reverseGeocode(p.lat, p.lng);
      if (geo.city || geo.country) {
        db.prepare('UPDATE photos SET city = ?, country = ? WHERE id = ?').run(geo.city, geo.country, p.id);
      }
    }
  });
});

// ── PUT /api/trips/:tripId/photos/:photoId ─────────────────────────────────

router.put('/:photoId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, photoId } = req.params;
  const access = canAccessTrip(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  const photo = db.prepare('SELECT id FROM photos WHERE id = ? AND trip_id = ?').get(photoId, tripId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  const allowed = ['caption', 'day_id', 'place_id'];
  const updates: string[] = [];
  const values: any[] = [];
  for (const key of allowed) {
    if (key in req.body) {
      updates.push(`${key} = ?`);
      values.push(req.body[key] ?? null);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  values.push(photoId);

  db.prepare(`UPDATE photos SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare(`
    SELECT id, trip_id, day_id, place_id, filename, original_name, file_size, mime_type,
           caption, taken_at, latitude, longitude, city, country,
           camera_make, camera_model, width, height, created_at,
           '/uploads/photos/' || filename AS url
    FROM photos WHERE id = ?
  `).get(photoId);

  res.json({ photo: updated });
});

// ── DELETE /api/trips/:tripId/photos/:photoId ──────────────────────────────

router.delete('/:photoId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, photoId } = req.params;
  const access = canAccessTrip(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  const photo = db.prepare('SELECT filename FROM photos WHERE id = ? AND trip_id = ?').get(photoId, tripId) as { filename: string } | undefined;
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  db.prepare('DELETE FROM photos WHERE id = ?').run(photoId);

  const filePath = path.join(photosDir, photo.filename);
  if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});

  res.json({ success: true });
});

export default router;
