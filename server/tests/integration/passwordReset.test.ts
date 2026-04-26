/**
 * Password reset integration tests.
 * Covers the full forgot→reset flow, session invalidation via password_version,
 * MCP token revocation, and rate limiting on the forgot-password endpoint.
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
// Prevent actual email delivery during tests
vi.mock('../../src/services/emailService', () => ({ sendEmail: vi.fn().mockResolvedValue(false) }));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser, createMcpToken } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { loginAttempts, mfaAttempts, forgotAttempts, resetAttempts } from '../../src/routes/auth';
import { requestPasswordReset } from '../../src/services/authService';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
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
});

// ─────────────────────────────────────────────────────────────────────────────
// Forgot-password endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/forgot-password', () => {
  it('returns 200 for a valid email', async () => {
    const { user } = createUser(testDb);
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: user.email });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 200 even for an unknown email (no user enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 when email field is missing', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({});
    expect(res.status).toBe(400);
  });

  it('inserts a password_reset_tokens row for a known email', async () => {
    const { user } = createUser(testDb);
    await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    const row = testDb.prepare(
      'SELECT * FROM password_reset_tokens WHERE user_id = ? AND consumed_at IS NULL'
    ).get(user.id);
    expect(row).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reset-password endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/reset-password', () => {
  it('returns 200 and marks token consumed on success', async () => {
    const { user } = createUser(testDb);
    const { tokenForDelivery } = requestPasswordReset(user.email, '127.0.0.1');

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: tokenForDelivery, password: 'NewPassword99!' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = testDb.prepare(
      'SELECT consumed_at FROM password_reset_tokens WHERE user_id = ?'
    ).get(user.id) as { consumed_at: string | null };
    expect(row?.consumed_at).not.toBeNull();
  });

  it('returns 400 for an invalid token', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'completely-wrong-token', password: 'NewPassword99!' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the same token is used a second time (single-use)', async () => {
    const { user } = createUser(testDb);
    const { tokenForDelivery } = requestPasswordReset(user.email, '127.0.0.1');

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: tokenForDelivery, password: 'NewPassword99!' });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: tokenForDelivery, password: 'AnotherPass99!' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when token field is missing', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ password: 'NewPassword99!' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when password field is missing', async () => {
    const { user } = createUser(testDb);
    const { tokenForDelivery } = requestPasswordReset(user.email, '127.0.0.1');
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: tokenForDelivery });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session invalidation via password_version
// ─────────────────────────────────────────────────────────────────────────────

describe('password reset — session invalidation', () => {
  it('old JWT cookie is rejected after password reset', async () => {
    const { user } = createUser(testDb);

    // authCookie signs a JWT with the current password_version
    const oldCookie = authCookie(user.id);

    // Confirm it works before reset
    const beforeRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', oldCookie);
    expect(beforeRes.status).toBe(200);

    // Reset password → bumps password_version
    const { tokenForDelivery } = requestPasswordReset(user.email, '127.0.0.1');
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: tokenForDelivery, password: 'BrandNew99!' });

    // Old cookie should now be rejected
    const afterRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', oldCookie);
    expect(afterRes.status).toBe(401);
  });

  it('password_version is incremented in the DB after reset', async () => {
    const { user } = createUser(testDb);
    const before = (testDb.prepare('SELECT password_version FROM users WHERE id = ?').get(user.id) as any)?.password_version ?? 0;

    const { tokenForDelivery } = requestPasswordReset(user.email, '127.0.0.1');
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: tokenForDelivery, password: 'BrandNew99!' });

    const after = (testDb.prepare('SELECT password_version FROM users WHERE id = ?').get(user.id) as any)?.password_version ?? 0;
    expect(after).toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP token revocation
// ─────────────────────────────────────────────────────────────────────────────

describe('password reset — MCP token revocation', () => {
  it('deletes MCP tokens for the user after reset', async () => {
    const { user } = createUser(testDb);
    createMcpToken(testDb, user.id, { name: 'My API token' });

    const before = testDb.prepare('SELECT COUNT(*) as n FROM mcp_tokens WHERE user_id = ?').get(user.id) as { n: number };
    expect(before.n).toBe(1);

    const { tokenForDelivery } = requestPasswordReset(user.email, '127.0.0.1');
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: tokenForDelivery, password: 'BrandNew99!' });

    const after = testDb.prepare('SELECT COUNT(*) as n FROM mcp_tokens WHERE user_id = ?').get(user.id) as { n: number };
    expect(after.n).toBe(0);
  });

  it('leaves MCP tokens for other users untouched', async () => {
    const { user: victim } = createUser(testDb);
    const { user: bystander } = createUser(testDb);
    createMcpToken(testDb, bystander.id, { name: 'Bystander token' });

    const { tokenForDelivery } = requestPasswordReset(victim.email, '127.0.0.1');
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: tokenForDelivery, password: 'BrandNew99!' });

    const count = testDb.prepare('SELECT COUNT(*) as n FROM mcp_tokens WHERE user_id = ?').get(bystander.id) as { n: number };
    expect(count.n).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting on forgot-password
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/forgot-password — rate limiting', () => {
  it('returns 429 after exceeding the per-IP limit (3 requests)', async () => {
    // The forgotLimiter allows 3 requests per IP per window.
    // supertest uses 127.0.0.1 as the client IP.
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: `user${i}@example.com` });
      expect(res.status).toBe(200);
    }
    const blocked = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'overflow@example.com' });
    expect(blocked.status).toBe(429);
  });
});
