/**
 * Share token expiry and photo scope tests.
 * Covers:
 *  - New share tokens include an expires_at ~90 days out
 *  - Expired tokens are rejected by GET /api/shared/:token
 *  - NULL expires_at (legacy tokens) are still accepted
 *  - A valid share token for trip A cannot serve photos belonging to trip B
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import path from 'path';
import fs from 'fs';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser, createTrip } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts, forgotAttempts, resetAttempts } from '../../src/routes/auth';

const app: Application = createApp();

// Path where app.ts resolves photo files at runtime (src/__dirname/../uploads/photos)
const PHOTOS_DIR = path.resolve(__dirname, '../../uploads/photos');
const TEST_PHOTO = 'test-share-scope-fixture.jpg';
const TEST_PHOTO_PATH = path.join(PHOTOS_DIR, TEST_PHOTO);

// Minimal valid JPEG header (3 magic bytes + enough padding)
const JPEG_STUB = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
  // Create a real stub photo file so the route doesn't 404 before auth
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  fs.writeFileSync(TEST_PHOTO_PATH, JPEG_STUB);
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
  forgotAttempts.clear();
  resetAttempts.clear();
});

afterAll(() => {
  testDb.close();
  // Clean up the stub file
  try { fs.unlinkSync(TEST_PHOTO_PATH); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// Share token expiry — API endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('Share token expiry', () => {
  it('new share link includes expires_at approximately 90 days from now', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});

    const row = testDb.prepare(
      'SELECT expires_at FROM share_tokens WHERE trip_id = ?'
    ).get(trip.id) as { expires_at: string | null };

    expect(row).toBeDefined();
    expect(row.expires_at).not.toBeNull();

    const expiresAt = new Date(row.expires_at!);
    const now = new Date();
    const daysUntilExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    // Should be between 89 and 91 days from now
    expect(daysUntilExpiry).toBeGreaterThan(89);
    expect(daysUntilExpiry).toBeLessThan(91);
  });

  it('GET /api/shared/:token returns trip data for a valid non-expired token', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const createRes = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});
    const { token } = createRes.body;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.trip).toBeDefined();
  });

  it('GET /api/shared/:token returns 404 for an expired token', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const token = 'expired-test-token-abc';

    // Insert a token that expired in the past
    testDb.prepare(
      "INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab, expires_at) VALUES (?, ?, ?, 1, 1, 0, 0, 0, datetime('now', '-1 day'))"
    ).run(trip.id, token, user.id);

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/shared/:token accepts a NULL expires_at (legacy token with no expiry)', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const token = 'legacy-no-expiry-token';

    testDb.prepare(
      'INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab, expires_at) VALUES (?, ?, ?, 1, 1, 0, 0, 0, NULL)'
    ).run(trip.id, token, user.id);

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.trip).toBeDefined();
  });

  it('GET /api/shared/:token returns 404 for an unknown token', async () => {
    const res = await request(app).get('/api/shared/does-not-exist');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Photo share-token scope
// ─────────────────────────────────────────────────────────────────────────────

describe('Photo share-token scope', () => {
  it('returns 401 when no token is provided', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    testDb.prepare(
      'INSERT INTO photos (trip_id, filename, original_name) VALUES (?, ?, ?)'
    ).run(trip.id, TEST_PHOTO, 'original.jpg');

    const res = await request(app).get(`/uploads/photos/${TEST_PHOTO}`);
    expect(res.status).toBe(401);
  });

  it('accepts a valid JWT cookie for any trip member', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    testDb.prepare(
      'INSERT INTO photos (trip_id, filename, original_name) VALUES (?, ?, ?)'
    ).run(trip.id, TEST_PHOTO, 'original.jpg');

    const res = await request(app)
      .get(`/uploads/photos/${TEST_PHOTO}`)
      .set('Cookie', authCookie(user.id));
    // JWT path succeeds — file exists so sendFile returns 200
    expect(res.status).toBe(200);
  });

  it('accepts a share token that belongs to the photo\'s own trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const shareToken = 'valid-token-for-trip-a';

    testDb.prepare(
      'INSERT INTO photos (trip_id, filename, original_name) VALUES (?, ?, ?)'
    ).run(trip.id, TEST_PHOTO, 'original.jpg');
    testDb.prepare(
      "INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab, expires_at) VALUES (?, ?, ?, 1, 1, 0, 0, 0, datetime('now', '+90 days'))"
    ).run(trip.id, shareToken, user.id);

    const res = await request(app)
      .get(`/uploads/photos/${TEST_PHOTO}?token=${shareToken}`);
    expect(res.status).toBe(200);
  });

  it('rejects a share token that belongs to a different trip', async () => {
    const { user } = createUser(testDb);
    const tripA = createTrip(testDb, user.id);
    const tripB = createTrip(testDb, user.id);
    const tokenForB = 'token-for-trip-b-only';

    // Photo belongs to trip A
    testDb.prepare(
      'INSERT INTO photos (trip_id, filename, original_name) VALUES (?, ?, ?)'
    ).run(tripA.id, TEST_PHOTO, 'original.jpg');

    // Share token is scoped to trip B
    testDb.prepare(
      "INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab, expires_at) VALUES (?, ?, ?, 1, 1, 0, 0, 0, datetime('now', '+90 days'))"
    ).run(tripB.id, tokenForB, user.id);

    const res = await request(app)
      .get(`/uploads/photos/${TEST_PHOTO}?token=${tokenForB}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired share token even if it covers the correct trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const expiredToken = 'expired-token-for-trip';

    testDb.prepare(
      'INSERT INTO photos (trip_id, filename, original_name) VALUES (?, ?, ?)'
    ).run(trip.id, TEST_PHOTO, 'original.jpg');
    testDb.prepare(
      "INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab, expires_at) VALUES (?, ?, ?, 1, 1, 0, 0, 0, datetime('now', '-1 day'))"
    ).run(trip.id, expiredToken, user.id);

    const res = await request(app)
      .get(`/uploads/photos/${TEST_PHOTO}?token=${expiredToken}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 (not 404) when the token is present but the photo row is missing', async () => {
    // A share token exists for a trip, but the filename has no photos row
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const token = 'orphan-photo-token';

    testDb.prepare(
      "INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab, expires_at) VALUES (?, ?, ?, 1, 1, 0, 0, 0, datetime('now', '+90 days'))"
    ).run(trip.id, token, user.id);

    // No photos row inserted — the auth path returns 401, not 404
    const res = await request(app)
      .get(`/uploads/photos/${TEST_PHOTO}?token=${token}`);
    expect(res.status).toBe(401);
  });
});
