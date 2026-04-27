/**
 * OAuth 2.1 Settings UI integration tests — Session 5 checkpoint.
 *
 * Covers the server-side flows exercised by the new UI:
 * - Creating OAuth apps via the settings panel (settings_ui path)
 * - Consent flow: consentRequired / auto-approve / deny
 * - scopeSelectable flag (DCR vs settings_ui clients)
 * - Client secret reveal + rotation
 * - Active sessions listing and per-session revocation
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { createHash, randomBytes } from 'crypto'
import type { Application } from 'express'

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  const mock = {
    db, closeDb: () => {}, reinitialize: () => {},
    getPlaceWithTags: () => null, canAccessTrip: () => null, isOwner: () => false,
  }
  return { testDb: db, dbMock: mock }
})

vi.mock('../../src/db/database', () => dbMock)
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}))
vi.mock('../../src/services/oidcService', () => ({
  getAppUrl: () => 'https://trek.example.com',
  verifyIdToken: () => null,
  findOrCreateUser: () => null,
}))

import { createApp } from '../../src/app'
import { createTables } from '../../src/db/schema'
import { runMigrations } from '../../src/db/migrations'
import { resetTestDb } from '../helpers/test-db'
import { createUser } from '../helpers/factories'
import { authCookie } from '../helpers/auth'
import { tokenAttempts, registerAttempts, revokeAttempts, validateAttempts } from '../../src/routes/oauth'

const app: Application = createApp()

const TEST_REDIRECT = 'https://claude.ai/oauth/callback'

beforeAll(() => { createTables(testDb); runMigrations(testDb) })
beforeEach(() => {
  resetTestDb(testDb)
  tokenAttempts.clear(); registerAttempts.clear(); revokeAttempts.clear(); validateAttempts.clear()
})
afterAll(() => testDb.close())

function makePkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// ── Settings UI client management ─────────────────────────────────────────────

describe('Settings UI — OAuth app management', () => {
  it('UI-001 — creates a confidential app via /api/oauth/clients', async () => {
    const { user } = createUser(testDb)

    const res = await request(app)
      .post('/api/oauth/clients')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'My Claude App', redirect_uris: [TEST_REDIRECT], allowed_scopes: ['trips:read', 'trips:write'] })

    expect(res.status).toBe(201)
    expect(res.body.client.name).toBe('My Claude App')
    expect(res.body.client.created_via).toBe('settings_ui')
    expect(res.body.client.is_public).toBe(false)
    expect(res.body.clientSecret).toMatch(/^treks_/)
  })

  it('UI-002 — creates a public app (no secret returned)', async () => {
    const { user } = createUser(testDb)

    const res = await request(app)
      .post('/api/oauth/clients')
      .set('Cookie', authCookie(user.id))
      .send({ name: 'Public App', redirect_uris: [TEST_REDIRECT], is_public: true })

    expect(res.status).toBe(201)
    expect(res.body.client.is_public).toBe(true)
    expect(res.body.clientSecret).toBeNull()
  })

  it('UI-003 — lists own apps', async () => {
    const { user } = createUser(testDb)

    await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App A', redirect_uris: [TEST_REDIRECT] })
    await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App B', redirect_uris: [TEST_REDIRECT] })

    const res = await request(app).get('/api/oauth/clients').set('Cookie', authCookie(user.id))
    expect(res.status).toBe(200)
    expect(res.body.clients).toHaveLength(2)
  })

  it('UI-004 — rotates client secret', async () => {
    const { user } = createUser(testDb)
    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT] })

    const clientId = createRes.body.client.client_id
    const oldSecret = createRes.body.clientSecret

    const rotateRes = await request(app).post(`/api/oauth/clients/${clientId}/rotate`).set('Cookie', authCookie(user.id))
    expect(rotateRes.status).toBe(200)
    expect(rotateRes.body.clientSecret).toMatch(/^treks_/)
    expect(rotateRes.body.clientSecret).not.toBe(oldSecret)
  })

  it('UI-005 — deletes own app', async () => {
    const { user } = createUser(testDb)
    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT] })

    const clientId = createRes.body.client.client_id
    const delRes = await request(app).delete(`/api/oauth/clients/${clientId}`).set('Cookie', authCookie(user.id))
    expect(delRes.status).toBe(204)

    const listRes = await request(app).get('/api/oauth/clients').set('Cookie', authCookie(user.id))
    expect(listRes.body.clients).toHaveLength(0)
  })
})

// ── scopeSelectable flag ─────────────────────────────────────────────────────

describe('scopeSelectable flag', () => {
  it('UI-006 — settings_ui client: scopeSelectable=false (no scope picker in consent)', async () => {
    const { user } = createUser(testDb)
    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT], allowed_scopes: ['trips:read'] })

    const clientId = createRes.body.client.client_id

    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .set('Cookie', authCookie(user.id))
      .query({ client_id: clientId, redirect_uri: TEST_REDIRECT, response_type: 'code', scope: 'trips:read' })

    expect(res.body.scopeSelectable).toBe(false)
  })

  it('UI-007 — DCR client: scopeSelectable=true (scope picker shown)', async () => {
    const dcrRes = await request(app).post('/oauth/register')
      .send({ client_name: 'Claude.ai', redirect_uris: [TEST_REDIRECT], token_endpoint_auth_method: 'none', scope: 'trips:read' })

    const { user } = createUser(testDb)
    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .set('Cookie', authCookie(user.id))
      .query({ client_id: dcrRes.body.client_id, redirect_uri: TEST_REDIRECT, response_type: 'code', scope: 'trips:read' })

    expect(res.body.scopeSelectable).toBe(true)
  })
})

// ── Consent flow ──────────────────────────────────────────────────────────────

describe('Consent flow', () => {
  it('UI-008 — first-time consent: consentRequired=true', async () => {
    const { user } = createUser(testDb)
    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT], allowed_scopes: ['trips:read'] })
    const clientId = createRes.body.client.client_id

    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .set('Cookie', authCookie(user.id))
      .query({ client_id: clientId, redirect_uri: TEST_REDIRECT, response_type: 'code', scope: 'trips:read' })

    expect(res.body.consentRequired).toBe(true)
    expect(res.body.scopes).toHaveLength(1)
    expect(res.body.scopes[0].scope).toBe('trips:read')
    expect(res.body.scopes[0].label).toBeTruthy()
    expect(res.body.scopes[0].group).toBe('Trips')
  })

  it('UI-009 — after consent recorded: consentRequired=false (auto-approve path)', async () => {
    const { user } = createUser(testDb)
    const { challenge, verifier } = makePkce()

    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT], allowed_scopes: ['trips:read'] })
    const clientId = createRes.body.client.client_id
    const clientSecret = createRes.body.clientSecret

    // Approve once → consent recorded
    await request(app).post('/api/oauth/authorize').set('Cookie', authCookie(user.id))
      .send({ client_id: clientId, redirect_uri: TEST_REDIRECT, scope: 'trips:read', code_challenge: challenge, code_challenge_method: 'S256', approved_scopes: ['trips:read'] })

    // Now validate again — should auto-approve
    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .set('Cookie', authCookie(user.id))
      .query({ client_id: clientId, redirect_uri: TEST_REDIRECT, response_type: 'code', scope: 'trips:read' })

    expect(res.body.consentRequired).toBe(false)

    // Complete the token exchange to confirm the full auto-approve flow works
    const authRes = await request(app).post('/api/oauth/authorize').set('Cookie', authCookie(user.id))
      .send({ client_id: clientId, redirect_uri: TEST_REDIRECT, scope: 'trips:read', code_challenge: challenge, code_challenge_method: 'S256', approved_scopes: ['trips:read'] })
    const code2 = new URL(authRes.body.redirect).searchParams.get('code')

    const tokenRes = await request(app).post('/oauth/token')
      .send({ grant_type: 'authorization_code', code: code2, redirect_uri: TEST_REDIRECT, client_id: clientId, client_secret: clientSecret, code_verifier: verifier })
    expect(tokenRes.status).toBe(200)
    expect(tokenRes.body.access_token).toMatch(/^trekoa_/)
  })

  it('UI-010 — deny redirects with access_denied error', async () => {
    const { user } = createUser(testDb)
    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT], allowed_scopes: ['trips:read'] })
    const clientId = createRes.body.client.client_id

    const res = await request(app).post('/api/oauth/authorize').set('Cookie', authCookie(user.id))
      .send({ client_id: clientId, redirect_uri: TEST_REDIRECT, state: 'csrf123', approved: false })

    expect(res.status).toBe(200)
    const redirectUrl = new URL(res.body.redirect)
    expect(redirectUrl.searchParams.get('error')).toBe('access_denied')
    expect(redirectUrl.searchParams.get('state')).toBe('csrf123')
  })

  it('UI-011 — loginRequired when not authenticated', async () => {
    const { user } = createUser(testDb)
    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT], allowed_scopes: ['trips:read'] })
    const clientId = createRes.body.client.client_id

    // No cookie → optionalAuth → loginRequired
    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .query({ client_id: clientId, redirect_uri: TEST_REDIRECT, response_type: 'code' })

    expect(res.body.valid).toBe(true)
    expect(res.body.loginRequired).toBe(true)
  })
})

// ── Active sessions management ────────────────────────────────────────────────

describe('Active sessions', () => {
  it('UI-012 — lists sessions and revokes via settings API', async () => {
    const { user } = createUser(testDb)
    const { challenge, verifier } = makePkce()

    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT], allowed_scopes: ['trips:read'], is_public: true })
    const clientId = createRes.body.client.client_id

    // Complete authorization flow to create a token
    const authRes = await request(app).post('/api/oauth/authorize').set('Cookie', authCookie(user.id))
      .send({ client_id: clientId, redirect_uri: TEST_REDIRECT, scope: 'trips:read', code_challenge: challenge, code_challenge_method: 'S256', approved_scopes: ['trips:read'] })
    const code = new URL(authRes.body.redirect).searchParams.get('code')

    await request(app).post('/oauth/token')
      .send({ grant_type: 'authorization_code', code, redirect_uri: TEST_REDIRECT, client_id: clientId, code_verifier: verifier })

    // List sessions
    const listRes = await request(app).get('/api/oauth/sessions').set('Cookie', authCookie(user.id))
    expect(listRes.status).toBe(200)
    expect(listRes.body.sessions).toHaveLength(1)
    expect(listRes.body.sessions[0].client_name).toBe('App')
    expect(listRes.body.sessions[0].scopes).toContain('trips:read')

    // Revoke it
    const tokenId = listRes.body.sessions[0].id
    const revokeRes = await request(app).delete(`/api/oauth/sessions/${tokenId}`).set('Cookie', authCookie(user.id))
    expect(revokeRes.status).toBe(204)

    // Confirm gone
    const listRes2 = await request(app).get('/api/oauth/sessions').set('Cookie', authCookie(user.id))
    expect(listRes2.body.sessions).toHaveLength(0)
  })

  it('UI-013 — sessions show scope details for UI display', async () => {
    const { user } = createUser(testDb)
    const { challenge, verifier } = makePkce()
    const scopes = ['trips:read', 'budget:write', 'packing:write']

    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'Rich App', redirect_uris: [TEST_REDIRECT], allowed_scopes: scopes, is_public: true })
    const clientId = createRes.body.client.client_id

    const authRes = await request(app).post('/api/oauth/authorize').set('Cookie', authCookie(user.id))
      .send({ client_id: clientId, redirect_uri: TEST_REDIRECT, scope: scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256', approved_scopes: scopes })
    const code = new URL(authRes.body.redirect).searchParams.get('code')

    await request(app).post('/oauth/token')
      .send({ grant_type: 'authorization_code', code, redirect_uri: TEST_REDIRECT, client_id: clientId, code_verifier: verifier })

    const listRes = await request(app).get('/api/oauth/sessions').set('Cookie', authCookie(user.id))
    const session = listRes.body.sessions[0]
    expect(session.scopes).toEqual(expect.arrayContaining(scopes))
    expect(session.access_token_expires_at).toBeTruthy()
    expect(session.refresh_token_expires_at).toBeTruthy()
  })
})

// ── OAuthAuthorizePage API contract ──────────────────────────────────────────

describe('OAuthAuthorizePage API contract', () => {
  it('UI-014 — validate returns scope metadata objects (label + group)', async () => {
    const { user } = createUser(testDb)
    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT], allowed_scopes: ['trips:read', 'budget:write'] })
    const clientId = createRes.body.client.client_id

    const res = await request(app)
      .get('/api/oauth/authorize/validate')
      .set('Cookie', authCookie(user.id))
      .query({ client_id: clientId, redirect_uri: TEST_REDIRECT, response_type: 'code', scope: 'trips:read budget:write' })

    expect(res.body.valid).toBe(true)
    expect(Array.isArray(res.body.scopes)).toBe(true)
    for (const s of res.body.scopes) {
      expect(s.scope).toBeTruthy()
      expect(s.label).toBeTruthy()
      expect(s.group).toBeTruthy()
    }
    expect(res.body.client.name).toBe('App')
  })

  it('UI-015 — authorize returns { redirect } URL the page can follow', async () => {
    const { user } = createUser(testDb)
    const { challenge } = makePkce()

    const createRes = await request(app).post('/api/oauth/clients').set('Cookie', authCookie(user.id))
      .send({ name: 'App', redirect_uris: [TEST_REDIRECT], allowed_scopes: ['trips:read'], is_public: true })
    const clientId = createRes.body.client.client_id

    const res = await request(app).post('/api/oauth/authorize').set('Cookie', authCookie(user.id))
      .send({ client_id: clientId, redirect_uri: TEST_REDIRECT, scope: 'trips:read', state: 'state123', code_challenge: challenge, code_challenge_method: 'S256', approved_scopes: ['trips:read'] })

    expect(res.status).toBe(200)
    expect(res.body.redirect).toMatch(/^https:\/\/claude\.ai\/oauth\/callback\?code=trekac_/)
    expect(res.body.redirect).toContain('state=state123')
  })
})
