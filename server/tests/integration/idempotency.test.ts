/**
 * Unit tests for the idempotency middleware (applyIdempotency).
 *
 * Tests are run through the full Express app so the middleware fires naturally
 * via the authenticate() call. POST /api/trips is used as the test endpoint
 * because it is simple, authenticated, and idempotent-by-design.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';

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
import { createUser } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts } from '../../src/routes/auth';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  loginAttempts.clear();
  mfaAttempts.clear();
});

afterAll(() => {
  testDb.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Core idempotency behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('Idempotency middleware', () => {
  it('first request with a key executes the handler and returns 201', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/trips')
      .set('Cookie', authCookie(user.id))
      .set('X-Idempotency-Key', 'key-001')
      .send({ title: 'Trip A' });
    expect(res.status).toBe(201);
    expect(res.body.trip).toBeDefined();
  });

  it('second request with the same key replays the cached response', async () => {
    const { user } = createUser(testDb);
    const cookie = authCookie(user.id);

    const first = await request(app)
      .post('/api/trips')
      .set('Cookie', cookie)
      .set('X-Idempotency-Key', 'key-replay')
      .send({ title: 'Idempotent Trip' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/trips')
      .set('Cookie', cookie)
      .set('X-Idempotency-Key', 'key-replay')
      .send({ title: 'Idempotent Trip' });
    expect(second.status).toBe(201);
    // Same trip id — handler did not run again
    expect(second.body.trip.id).toBe(first.body.trip.id);
  });

  it('second request with the same key does not create a second DB row', async () => {
    const { user } = createUser(testDb);
    const cookie = authCookie(user.id);

    await request(app)
      .post('/api/trips')
      .set('Cookie', cookie)
      .set('X-Idempotency-Key', 'key-dedup')
      .send({ title: 'Dedup Trip' });
    await request(app)
      .post('/api/trips')
      .set('Cookie', cookie)
      .set('X-Idempotency-Key', 'key-dedup')
      .send({ title: 'Dedup Trip' });

    const count = (testDb.prepare('SELECT COUNT(*) as n FROM trips WHERE user_id = ?').get(user.id) as any).n;
    expect(count).toBe(1);
  });

  it('a different key executes the handler again and creates a new resource', async () => {
    const { user } = createUser(testDb);
    const cookie = authCookie(user.id);

    const r1 = await request(app)
      .post('/api/trips')
      .set('Cookie', cookie)
      .set('X-Idempotency-Key', 'key-A')
      .send({ title: 'Trip A' });
    const r2 = await request(app)
      .post('/api/trips')
      .set('Cookie', cookie)
      .set('X-Idempotency-Key', 'key-B')
      .send({ title: 'Trip B' });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.trip.id).not.toBe(r2.body.trip.id);

    const count = (testDb.prepare('SELECT COUNT(*) as n FROM trips WHERE user_id = ?').get(user.id) as any).n;
    expect(count).toBe(2);
  });

  it('the same key used by two different users executes independently (key is user-scoped)', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);

    const r1 = await request(app)
      .post('/api/trips')
      .set('Cookie', authCookie(alice.id))
      .set('X-Idempotency-Key', 'shared-key')
      .send({ title: 'Alice Trip' });
    const r2 = await request(app)
      .post('/api/trips')
      .set('Cookie', authCookie(bob.id))
      .set('X-Idempotency-Key', 'shared-key')
      .send({ title: 'Bob Trip' });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // Different users → different cache entries → different trips created
    expect(r1.body.trip.id).not.toBe(r2.body.trip.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET requests are not cached
// ─────────────────────────────────────────────────────────────────────────────

describe('Idempotency — non-mutating methods', () => {
  it('GET request with a key is not cached (no idempotency_keys row created)', async () => {
    const { user } = createUser(testDb);

    await request(app)
      .get('/api/trips')
      .set('Cookie', authCookie(user.id))
      .set('X-Idempotency-Key', 'get-key');

    const row = testDb.prepare(
      "SELECT key FROM idempotency_keys WHERE key = 'get-key' AND user_id = ?"
    ).get(user.id);
    expect(row).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Key validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Idempotency — key validation', () => {
  it('returns 400 when X-Idempotency-Key exceeds 128 characters', async () => {
    const { user } = createUser(testDb);
    const longKey = 'x'.repeat(129);

    const res = await request(app)
      .post('/api/trips')
      .set('Cookie', authCookie(user.id))
      .set('X-Idempotency-Key', longKey)
      .send({ title: 'Trip' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/128/);
  });

  it('a key of exactly 128 characters is accepted', async () => {
    const { user } = createUser(testDb);
    const exactKey = 'x'.repeat(128);

    const res = await request(app)
      .post('/api/trips')
      .set('Cookie', authCookie(user.id))
      .set('X-Idempotency-Key', exactKey)
      .send({ title: 'Trip' });
    expect(res.status).toBe(201);
  });

  it('request without a key is not cached and executes normally', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/trips')
      .set('Cookie', authCookie(user.id))
      .send({ title: 'No-key Trip' });
    expect(res.status).toBe(201);

    const rows = testDb.prepare('SELECT key FROM idempotency_keys WHERE user_id = ?').all(user.id);
    expect(rows.length).toBe(0);
  });
});
