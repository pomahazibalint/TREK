/**
 * Unit tests for oidcService — verifyIdToken and findOrCreateUser.
 *
 * verifyIdToken is tested against a self-signed RSA key pair generated in
 * beforeAll so no live IdP is needed. fetch is stubbed to return the test JWKS.
 *
 * findOrCreateUser is tested against the in-memory DB to verify user creation,
 * sub-linking, and invite exhaustion behaviour.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// ── in-memory DB ──────────────────────────────────────────────────────────────

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
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

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
vi.mock('../../../src/services/apiKeyCrypto', () => ({
  decrypt_api_key: (v: string | null) => v,
  maybe_encrypt_api_key: (v: string) => v,
  encrypt_api_key: (v: string) => v,
}));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { verifyIdToken, findOrCreateUser } from '../../../src/services/oidcService';
import type { OidcConfig, OidcDiscoveryDoc, OidcUserInfo } from '../../../src/services/oidcService';

createTables(testDb);
runMigrations(testDb);

// ── RSA key pair + JWKS (generated once for the whole suite) ──────────────────

const TEST_KID = 'trek-test-key-1';
const JWKS_URI = 'https://idp.test.example/.well-known/jwks';
const FAILING_JWKS_URI = 'https://failing.test.example/.well-known/jwks';
const ISSUER = 'https://idp.test.example';
const CLIENT_ID = 'trek-test-client';

let privateKey: crypto.KeyObject;
let publicKeyJwk: Record<string, unknown>;

beforeAll(() => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKeyJwk = { ...pair.publicKey.export({ format: 'jwk' }) as object, kid: TEST_KID, use: 'sig', alg: 'RS256' };

  // Stub global fetch: main JWKS URI returns the test key, failing URI throws
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === FAILING_JWKS_URI) throw new Error('Network error');
    if (url === JWKS_URI) {
      return { ok: true, json: async () => ({ keys: [publicKeyJwk] }) };
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
  testDb.close();
});

beforeEach(() => {
  testDb.exec('DELETE FROM users');
  testDb.exec('DELETE FROM invite_tokens');
  testDb.exec('DELETE FROM app_settings');
});

// ── helpers ───────────────────────────────────────────────────────────────────

const testDoc: OidcDiscoveryDoc = {
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
  jwks_uri: JWKS_URI,
  issuer: ISSUER,
};

function signToken(payload: Record<string, unknown>, opts: jwt.SignOptions = {}): string {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    keyid: TEST_KID,
    ...opts,
  });
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-sub-001',
    email: 'user@example.com',
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

const testConfig: OidcConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'secret',
  displayName: 'Test IdP',
  discoveryUrl: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// verifyIdToken — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyIdToken — valid token', () => {
  it('returns ok:true with claims for a correctly signed token', async () => {
    const token = signToken(basePayload());
    const result = await verifyIdToken(token, testDoc, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims['sub']).toBe('user-sub-001');
      expect(result.claims['email']).toBe('user@example.com');
    }
  });

  it('includes all original claims in the returned claims object', async () => {
    const token = signToken(basePayload({ name: 'Alice Test' }));
    const result = await verifyIdToken(token, testDoc, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims['name']).toBe('Alice Test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyIdToken — rejection cases
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyIdToken — rejection cases', () => {
  it('rejects a token with the wrong issuer', async () => {
    const token = signToken(basePayload({ iss: 'https://evil.example' }));
    const result = await verifyIdToken(token, testDoc, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/issuer/);
  });

  it('rejects an expired token', async () => {
    const token = signToken(basePayload({
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    }));
    const result = await verifyIdToken(token, testDoc, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expired|claim/i);
  });

  it('rejects a token signed with an unknown kid', async () => {
    const token = jwt.sign(basePayload() as object, privateKey, {
      algorithm: 'RS256',
      keyid: 'unknown-kid-xyz',
    });
    const result = await verifyIdToken(token, testDoc, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('no_matching_key');
  });

  it('rejects a token with an unsupported algorithm (HS256)', async () => {
    // jwt.sign with a string secret produces an HS256 token
    const token = jwt.sign(basePayload() as object, 'hmac-secret', {
      algorithm: 'HS256',
      header: { alg: 'HS256', kid: TEST_KID } as any,
    });
    const result = await verifyIdToken(token, testDoc, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unsupported_alg');
  });

  it('rejects when doc has no jwks_uri', async () => {
    const docWithoutJwks: OidcDiscoveryDoc = { ...testDoc, jwks_uri: undefined };
    const token = signToken(basePayload());
    const result = await verifyIdToken(token, docWithoutJwks, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('no_jwks_uri');
  });

  it('rejects a malformed token (not three dot-separated parts)', async () => {
    const result = await verifyIdToken('not.a.valid.jwt.at.all', testDoc, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('malformed_token');
  });

  it('rejects when the JWKS endpoint is unreachable', async () => {
    const failingDoc: OidcDiscoveryDoc = { ...testDoc, jwks_uri: FAILING_JWKS_URI };
    const token = signToken(basePayload());
    const result = await verifyIdToken(token, failingDoc, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('jwks_fetch_failed');
  });

  it('rejects a token with the wrong audience', async () => {
    const token = signToken(basePayload({ aud: 'wrong-client-id' }));
    const result = await verifyIdToken(token, testDoc, CLIENT_ID, ISSUER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/claim|audience/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findOrCreateUser
// ─────────────────────────────────────────────────────────────────────────────

function makeUserInfo(overrides: Partial<OidcUserInfo> = {}): OidcUserInfo {
  return {
    sub: 'oidc-sub-001',
    email: 'oidcuser@example.com',
    name: 'OIDC User',
    ...overrides,
  };
}

describe('findOrCreateUser — first login', () => {
  it('creates a new user on the first OIDC login', () => {
    const result = findOrCreateUser(makeUserInfo(), testConfig);
    expect('user' in result).toBe(true);
    if ('user' in result) {
      expect(result.user.email).toBe('oidcuser@example.com');
      expect(result.user.role).toBe('admin'); // first user is always admin
    }
  });

  it('stores oidc_sub and oidc_issuer on the new user', () => {
    findOrCreateUser(makeUserInfo(), testConfig);
    const row = testDb.prepare('SELECT oidc_sub, oidc_issuer FROM users WHERE email = ?').get('oidcuser@example.com') as any;
    expect(row.oidc_sub).toBe('oidc-sub-001');
    expect(row.oidc_issuer).toBe(ISSUER);
  });

  it('second user gets role:user (not first user)', () => {
    findOrCreateUser(makeUserInfo(), testConfig); // first → admin
    const result = findOrCreateUser(makeUserInfo({ sub: 'sub-002', email: 'second@example.com' }), testConfig);
    expect('user' in result).toBe(true);
    if ('user' in result) expect(result.user.role).toBe('user');
  });
});

describe('findOrCreateUser — returning user', () => {
  it('returns the existing user on second login with the same sub', () => {
    findOrCreateUser(makeUserInfo(), testConfig);
    const result = findOrCreateUser(makeUserInfo(), testConfig);
    expect('user' in result).toBe(true);
    const count = (testDb.prepare('SELECT COUNT(*) as n FROM users').get() as any).n;
    expect(count).toBe(1);
  });

  it('links OIDC identity to an existing email-based user', () => {
    // Pre-create a user without OIDC fields
    testDb.prepare(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('localuser', 'oidcuser@example.com', 'hash', 'user')"
    ).run();

    const result = findOrCreateUser(makeUserInfo(), testConfig);
    expect('user' in result).toBe(true);

    const row = testDb.prepare('SELECT oidc_sub FROM users WHERE email = ?').get('oidcuser@example.com') as any;
    expect(row.oidc_sub).toBe('oidc-sub-001');
    // Still only one user row
    const count = (testDb.prepare('SELECT COUNT(*) as n FROM users').get() as any).n;
    expect(count).toBe(1);
  });
});

describe('findOrCreateUser — invite exhaustion (race condition guard)', () => {
  it('rejects a second user when the single-use invite is already consumed', () => {
    // Disable open registration so invite is the only path
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('allow_registration', 'false')").run();

    // Create the invite token (needs a created_by user — insert admin first directly)
    testDb.prepare(
      "INSERT INTO users (id, username, email, password_hash, role) VALUES (999, 'admin', 'admin@example.com', 'x', 'admin')"
    ).run();
    testDb.prepare(
      'INSERT INTO invite_tokens (token, max_uses, used_count, created_by) VALUES (?, 1, 0, 999)'
    ).run('single-use-invite');

    // First user uses the invite → succeeds, used_count → 1
    const r1 = findOrCreateUser(
      makeUserInfo({ sub: 'sub-a', email: 'usera@example.com' }),
      testConfig,
      'single-use-invite',
    );
    expect('user' in r1).toBe(true);

    // Second user presents the same (now exhausted) invite → rejected
    const r2 = findOrCreateUser(
      makeUserInfo({ sub: 'sub-b', email: 'userb@example.com' }),
      testConfig,
      'single-use-invite',
    );
    expect('error' in r2).toBe(true);
    if ('error' in r2) expect(r2.error).toBe('registration_disabled');

    // Exactly two users: the pre-inserted admin + the first OIDC user
    const count = (testDb.prepare('SELECT COUNT(*) as n FROM users').get() as any).n;
    expect(count).toBe(2);
  });

  it('returns registration_disabled when registration is closed and no valid invite', () => {
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('allow_registration', 'false')").run();
    // First user (admin) to make isFirstUser=false
    testDb.prepare(
      "INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'admin', 'admin@example.com', 'x', 'admin')"
    ).run();

    const result = findOrCreateUser(makeUserInfo(), testConfig);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe('registration_disabled');
  });
});
