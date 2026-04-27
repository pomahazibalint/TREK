/**
 * OAuth 2.1 endpoint integration tests — Session 2 checkpoint.
 *
 * Covers AS metadata, PRM, DCR, token exchange, revocation,
 * authorize flow, and client/session management APIs.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
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
    canAccessTrip: () => null,
    isOwner: () => false,
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
vi.mock('../../src/services/oidcService', () => ({
  getAppUrl: () => 'https://trek.example.com',
  verifyIdToken: () => null,
  findOrCreateUser: () => null,
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import {
  tokenAttempts,
  registerAttempts,
  revokeAttempts,
  validateAttempts,
} from '../../src/routes/oauth';

const app: Application = createApp();

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  tokenAttempts.clear();
  registerAttempts.clear();
  revokeAttempts.clear();
  validateAttempts.clear();
});

afterAll(() => {
  testDb.close();
});

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const TEST_REDIRECT = 'https://claude.ai/oauth/callback';
const TEST_SCOPES = ['trips:read', 'places:read'];

// ── Discovery endpoints ───────────────────────────────────────────────────────

describe('GET /.well-known/oauth-authorization-server', () => {
  it('OAUTH-001 — returns AS metadata with correct fields', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe('https://trek.example.com');
    expect(res.body.token_endpoint).toBe('https://trek.example.com/oauth/token');
    expect(res.body.registration_endpoint).toBe('https://trek.example.com/oauth/register');
    expect(res.body.code_challenge_methods_supported).toContain('S256');
    expect(Array.isArray(res.body.scopes_supported)).toBe(true);
    expect(res.body.scopes_supported.length).toBeGreaterThan(0);
    // CORS header present for open discovery
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('GET /.well-known/oauth-protected-resource', () => {
  it('OAUTH-002 — returns 403 when MCP addon is disabled', async () => {
    // MCP addon is disabled by default in test DB
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(403);
  });

  it('OAUTH-003 — returns PRM when MCP addon is enabled', async () => {
    testDb.prepare("UPDATE addons SET enabled = 1 WHERE id = 'mcp'").run();
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://trek.example.com/mcp');
    expect(res.body.authorization_servers).toContain('https://trek.example.com');
    expect(res.body.resource_name).toBe('TREK MCP');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

// ── DCR (Dynamic Client Registration) ────────────────────────────────────────

describe('POST /oauth/register', () => {
  it('OAUTH-004 — registers a public client', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'Claude.ai',
        redirect_uris: [TEST_REDIRECT],
        token_endpoint_auth_method: 'none',
        scope: TEST_SCOPES.join(' '),
      });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeTruthy();
    expect(res.body.client_secret).toBeUndefined();
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.body.redirect_uris).toEqual([TEST_REDIRECT]);
  });

  it('OAUTH-005 — registers a confidential client and returns a secret', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'My Server App',
        redirect_uris: ['https://myapp.example.com/callback'],
        scope: 'trips:read',
      });

    expect(res.status).toBe(201);
    expect(res.body.client_secret).toMatch(/^treks_/);
    expect(res.body.client_secret_expires_at).toBe(0);
  });

  it('OAUTH-006 — rejects missing client_name', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ redirect_uris: [TEST_REDIRECT] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('OAUTH-007 — rejects dangerous redirect URI schemes', async () => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
      const res = await request(app)
        .post('/oauth/register')
        .send({ client_name: 'Bad App', redirect_uris: [uri] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_redirect_uri');
    }
  });

  it('OAUTH-008 — allows http://localhost redirect URIs (RFC 8252)', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'Desktop App',
        redirect_uris: ['http://localhost:8080/callback'],
        token_endpoint_auth_method: 'none',
      });
    expect(res.status).toBe(201);
  });

  it('OAUTH-009 — allows private-use custom URI schemes (RFC 8252)', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'Mobile App',
        redirect_uris: ['com.example.myapp:/oauth/callback'],
        token_endpoint_auth_method: 'none',
      });
    expect(res.status).toBe(201);
  });
});

// ── Full authorization code flow ──────────────────────────────────────────────

describe('Full PKCE authorization code flow', () => {
  it('OAUTH-010 — DCR → validate → authorize → token exchange → refresh → revoke', async () => {
    const { user } = createUser(testDb);
    const { verifier, challenge } = makePkce();

    // Step 1: DCR — register a public client
    const regRes = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'Claude.ai Test',
        redirect_uris: [TEST_REDIRECT],
        token_endpoint_auth_method: 'none',
        scope: TEST_SCOPES.join(' '),
      });
    expect(regRes.status).toBe(201);
    const clientId = regRes.body.client_id;

    // Step 2: validate authorize request (authenticated)
    const validateRes = await request(app)
      .get('/api/oauth/authorize/validate')
      .set('Cookie', authCookie(user.id))
      .query({
        client_id: clientId,
        redirect_uri: TEST_REDIRECT,
        response_type: 'code',
        scope: TEST_SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    expect(validateRes.status).toBe(200);
    expect(validateRes.body.valid).toBe(true);
    expect(validateRes.body.consentRequired).toBe(true);

    // Step 3: submit consent and get auth code
    const authRes = await request(app)
      .post('/api/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .send({
        client_id: clientId,
        redirect_uri: TEST_REDIRECT,
        scope: TEST_SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        approved_scopes: TEST_SCOPES,
      });
    expect(authRes.status).toBe(200);
    expect(authRes.body.redirect).toBeTruthy();

    const redirectUrl = new URL(authRes.body.redirect);
    const code = redirectUrl.searchParams.get('code');
    expect(code).toMatch(/^trekac_/);

    // Step 4: exchange auth code for tokens
    const tokenRes = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEST_REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: 'https://trek.example.com/mcp',
      });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.access_token).toMatch(/^trekoa_/);
    expect(tokenRes.body.refresh_token).toMatch(/^trekrf_/);
    expect(tokenRes.body.token_type).toBe('Bearer');
    expect(tokenRes.body.expires_in).toBe(3600);

    const { access_token: at1, refresh_token: rt1 } = tokenRes.body;

    // Step 5: refresh tokens
    const refreshRes = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: rt1,
        client_id: clientId,
      });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.access_token).toMatch(/^trekoa_/);
    expect(refreshRes.body.access_token).not.toBe(at1);

    // Step 6: revoke the original access token
    const revokeRes = await request(app)
      .post('/oauth/revoke')
      .send({ token: at1, client_id: clientId });
    expect(revokeRes.status).toBe(200);
  });

  it('OAUTH-011 — authorize with state param echoes it back in redirect', async () => {
    const { user } = createUser(testDb);
    const { challenge, verifier: _v } = makePkce();

    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    const authRes = await request(app)
      .post('/api/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .send({
        client_id: clientId,
        redirect_uri: TEST_REDIRECT,
        scope: 'trips:read',
        state: 'xyz-csrf-token',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        approved_scopes: ['trips:read'],
      });
    expect(authRes.status).toBe(200);
    const redirectUrl = new URL(authRes.body.redirect);
    expect(redirectUrl.searchParams.get('state')).toBe('xyz-csrf-token');
  });

  it('OAUTH-012 — denial returns access_denied redirect', async () => {
    const { user } = createUser(testDb);

    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    const authRes = await request(app)
      .post('/api/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .send({
        client_id: clientId,
        redirect_uri: TEST_REDIRECT,
        state: 'abc',
        approved: false,
      });
    expect(authRes.status).toBe(200);
    const redirectUrl = new URL(authRes.body.redirect);
    expect(redirectUrl.searchParams.get('error')).toBe('access_denied');
    expect(redirectUrl.searchParams.get('state')).toBe('abc');
  });
});

// ── Token endpoint error cases ────────────────────────────────────────────────

describe('POST /oauth/token error cases', () => {
  it('OAUTH-013 — rejects unknown grant_type', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'password', client_id: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('OAUTH-014 — rejects missing client_id', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'authorization_code', code: 'x', redirect_uri: TEST_REDIRECT, code_verifier: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('OAUTH-015 — returns 401 for invalid_client', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code: 'trekac_fake',
        redirect_uri: TEST_REDIRECT,
        client_id: 'nonexistent-client-uuid',
        code_verifier: 'verifier',
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('OAUTH-016 — rejects wrong PKCE verifier', async () => {
    const { user } = createUser(testDb);
    const { challenge } = makePkce();

    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    const authRes = await request(app)
      .post('/api/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .send({ client_id: clientId, redirect_uri: TEST_REDIRECT, scope: 'trips:read', code_challenge: challenge, code_challenge_method: 'S256', approved_scopes: ['trips:read'] });
    const code = new URL(authRes.body.redirect).searchParams.get('code');

    const tokenRes = await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'authorization_code', code, redirect_uri: TEST_REDIRECT, client_id: clientId, code_verifier: 'wrong-verifier' });
    expect(tokenRes.status).toBe(400);
    expect(tokenRes.body.error).toBe('invalid_grant');
  });
});

// ── Revoke endpoint ───────────────────────────────────────────────────────────

describe('POST /oauth/revoke', () => {
  it('OAUTH-017 — returns 200 for unknown token (RFC 7009)', async () => {
    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none' });
    const clientId = regRes.body.client_id;

    const res = await request(app)
      .post('/oauth/revoke')
      .send({ token: 'trekoa_nonexistent', client_id: clientId });
    expect(res.status).toBe(200);
  });

  it('OAUTH-018 — returns 400 for missing token', async () => {
    const res = await request(app)
      .post('/oauth/revoke')
      .send({ client_id: 'some-client' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

// ── Authorize validate endpoint ───────────────────────────────────────────────

describe('GET /api/oauth/authorize/validate', () => {
  it('OAUTH-019 — returns loginRequired for unauthenticated request', async () => {
    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .query({ client_id: clientId, redirect_uri: TEST_REDIRECT, response_type: 'code', scope: 'trips:read' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.loginRequired).toBe(true);
  });

  it('OAUTH-020 — returns valid=false for unknown client', async () => {
    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .query({ client_id: 'no-such-client', redirect_uri: TEST_REDIRECT, response_type: 'code' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('invalid_client');
  });

  it('OAUTH-021 — returns consentRequired=false after full consent recorded', async () => {
    const { user } = createUser(testDb);
    const { challenge: _c } = makePkce();

    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    // Record consent directly in DB
    testDb.prepare('INSERT INTO oauth_consents (client_id, user_id, scopes) VALUES (?, ?, ?)').run(clientId, user.id, JSON.stringify(['trips:read']));

    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .set('Cookie', authCookie(user.id))
      .query({ client_id: clientId, redirect_uri: TEST_REDIRECT, response_type: 'code', scope: 'trips:read' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.consentRequired).toBe(false);
  });

  it('OAUTH-022 — returns scope metadata with label and group', async () => {
    const { user } = createUser(testDb);

    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .set('Cookie', authCookie(user.id))
      .query({ client_id: clientId, redirect_uri: TEST_REDIRECT, response_type: 'code', scope: 'trips:read' });

    expect(res.body.valid).toBe(true);
    expect(Array.isArray(res.body.scopes)).toBe(true);
    const scope = res.body.scopes.find((s: any) => s.scope === 'trips:read');
    expect(scope).toBeTruthy();
    expect(scope.label).toBeTruthy();
    expect(scope.group).toBe('Trips');
  });
});

// ── POST /api/oauth/authorize error cases ─────────────────────────────────────

describe('POST /api/oauth/authorize error cases', () => {
  it('OAUTH-023 — requires authentication', async () => {
    const res = await request(app)
      .post('/api/oauth/authorize')
      .send({ client_id: 'x', redirect_uri: TEST_REDIRECT });
    expect(res.status).toBe(401);
  });

  it('OAUTH-024 — rejects open redirect (unregistered redirect_uri)', async () => {
    const { user } = createUser(testDb);
    const { challenge } = makePkce();

    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    const res = await request(app)
      .post('/api/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .send({
        client_id: clientId,
        redirect_uri: 'https://evil.example.com/steal',
        scope: 'trips:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('OAUTH-025 — rejects code_challenge_method != S256', async () => {
    const { user } = createUser(testDb);

    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    const res = await request(app)
      .post('/api/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .send({
        client_id: clientId,
        redirect_uri: TEST_REDIRECT,
        scope: 'trips:read',
        code_challenge: 'somechallenge',
        code_challenge_method: 'plain',
      });
    expect(res.status).toBe(400);
  });
});

// ── Client management API ─────────────────────────────────────────────────────

describe('OAuth client management API', () => {
  it('OAUTH-026 — lists own clients', async () => {
    const { user } = createUser(testDb);

    await request(app)
      .post('/api/oauth/clients')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'My App', redirect_uris: [TEST_REDIRECT], allowed_scopes: TEST_SCOPES });

    const res = await request(app)
      .get('/api/oauth/clients')
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(200);
    expect(res.body.clients).toHaveLength(1);
    expect(res.body.clients[0].name).toBe('My App');
  });

  it('OAUTH-027 — creates a confidential client with secret', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/oauth/clients')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Server App', redirect_uris: ['https://myserver.example.com/callback'] });

    expect(res.status).toBe(201);
    expect(res.body.client.client_id).toBeTruthy();
    expect(res.body.clientSecret).toMatch(/^treks_/);
  });

  it('OAUTH-028 — rotates client secret', async () => {
    const { user } = createUser(testDb);

    const createRes = await request(app)
      .post('/api/oauth/clients')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT] });

    const clientId = createRes.body.client.client_id;
    const oldSecret = createRes.body.clientSecret;

    const rotateRes = await request(app)
      .post(`/api/oauth/clients/${clientId}/rotate`)
      .set('Cookie', authCookie(user.id));

    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.clientSecret).toMatch(/^treks_/);
    expect(rotateRes.body.clientSecret).not.toBe(oldSecret);
  });

  it('OAUTH-029 — deletes own client', async () => {
    const { user } = createUser(testDb);

    const createRes = await request(app)
      .post('/api/oauth/clients')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT] });

    const clientId = createRes.body.client.client_id;

    const delRes = await request(app)
      .delete(`/api/oauth/clients/${clientId}`)
      .set('Cookie', authCookie(user.id));
    expect(delRes.status).toBe(204);

    const listRes = await request(app)
      .get('/api/oauth/clients')
      .set('Cookie', authCookie(user.id));
    expect(listRes.body.clients).toHaveLength(0);
  });

  it('OAUTH-030 — cannot delete another user\'s client', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);

    const createRes = await request(app)
      .post('/api/oauth/clients')
      .set('Cookie', authCookie(alice.id))
      .send({ name: 'Alice App', redirect_uris: [TEST_REDIRECT] });

    const clientId = createRes.body.client.client_id;

    const res = await request(app)
      .delete(`/api/oauth/clients/${clientId}`)
      .set('Cookie', authCookie(bob.id));
    expect(res.status).toBe(404);
  });

  it('OAUTH-031 — rejects invalid redirect URI on client create', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .post('/api/oauth/clients')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Bad App', redirect_uris: ['javascript:alert(1)'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('OAUTH-032 — requires authentication for client endpoints', async () => {
    const get = await request(app).get('/api/oauth/clients');
    expect(get.status).toBe(401);

    const post = await request(app).post('/api/oauth/clients').send({ name: 'x', redirect_uris: [TEST_REDIRECT] });
    expect(post.status).toBe(401);
  });
});

// ── Session management API ────────────────────────────────────────────────────

describe('OAuth session management API', () => {
  it('OAUTH-033 — lists and revokes active sessions', async () => {
    const { user } = createUser(testDb);
    const { verifier, challenge } = makePkce();

    // Register + authorize + exchange to create a real session
    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    const authRes = await request(app)
      .post('/api/oauth/authorize')
      .set('Cookie', authCookie(user.id))
      .send({ client_id: clientId, redirect_uri: TEST_REDIRECT, scope: 'trips:read', code_challenge: challenge, code_challenge_method: 'S256', approved_scopes: ['trips:read'] });
    const code = new URL(authRes.body.redirect).searchParams.get('code');

    await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'authorization_code', code, redirect_uri: TEST_REDIRECT, client_id: clientId, code_verifier: verifier });

    // List sessions
    const listRes = await request(app)
      .get('/api/oauth/sessions')
      .set('Cookie', authCookie(user.id));
    expect(listRes.status).toBe(200);
    expect(listRes.body.sessions).toHaveLength(1);
    expect(listRes.body.sessions[0].client_name).toBe('App');

    const tokenId = listRes.body.sessions[0].id;

    // Revoke session
    const revokeRes = await request(app)
      .delete(`/api/oauth/sessions/${tokenId}`)
      .set('Cookie', authCookie(user.id));
    expect(revokeRes.status).toBe(204);

    // Confirm it's gone
    const listRes2 = await request(app)
      .get('/api/oauth/sessions')
      .set('Cookie', authCookie(user.id));
    expect(listRes2.body.sessions).toHaveLength(0);
  });

  it('OAUTH-034 — cannot revoke another user\'s session', async () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { verifier, challenge } = makePkce();

    const regRes = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'App', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' });
    const clientId = regRes.body.client_id;

    const authRes = await request(app)
      .post('/api/oauth/authorize')
      .set('Cookie', authCookie(alice.id))
      .send({ client_id: clientId, redirect_uri: TEST_REDIRECT, scope: 'trips:read', code_challenge: challenge, code_challenge_method: 'S256', approved_scopes: ['trips:read'] });
    const code = new URL(authRes.body.redirect).searchParams.get('code');

    await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'authorization_code', code, redirect_uri: TEST_REDIRECT, client_id: clientId, code_verifier: verifier });

    const listRes = await request(app)
      .get('/api/oauth/sessions')
      .set('Cookie', authCookie(alice.id));
    const tokenId = listRes.body.sessions[0].id;

    const revokeRes = await request(app)
      .delete(`/api/oauth/sessions/${tokenId}`)
      .set('Cookie', authCookie(bob.id));
    expect(revokeRes.status).toBe(404);
  });

  it('OAUTH-035 — requires authentication for session endpoints', async () => {
    const get = await request(app).get('/api/oauth/sessions');
    expect(get.status).toBe(401);
  });
});
