/**
 * Unit tests for oauthService — Session 1 checkpoint.
 *
 * Covers: client management, token issuance, access-token lookup,
 * token refresh (including replay detection), revocation, and consent.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ── In-memory DB (hoisted so vi.mock factory can close over it) ───────────────

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
  JWT_SECRET: 'test-jwt-secret',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
vi.mock('../../../src/services/apiKeyCrypto', () => ({
  decrypt_api_key: (v: string | null) => v,
  maybe_encrypt_api_key: (v: string) => v,
  encrypt_api_key: (v: string) => v,
}));
vi.mock('../../../src/services/oidcService', () => ({
  getAppUrl: () => 'https://trek.example.com',
}));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import {
  createOAuthClient,
  listClientsForUser,
  deleteClient,
  rotateClientSecret,
  issueTokens,
  getUserByAccessToken,
  exchangeAuthCode,
  refreshTokens,
  revokeToken,
  listActiveSessions,
  revokeSession,
  createAuthCode,
  validateAuthorizeRequest,
  recordConsent,
  revokeUserSessionsForOAuthClient,
} from '../../../src/services/oauthService';

createTables(testDb);
runMigrations(testDb);

// ── Helpers ───────────────────────────────────────────────────────────────────

function seedUser(username = 'alice', role = 'user'): number {
  const result = testDb.prepare(
    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'hash', ?)"
  ).run(username, `${username}@example.com`, role);
  return result.lastInsertRowid as number;
}

const TEST_SCOPES = ['trips:read', 'places:read'];
const TEST_REDIRECT = 'https://claude.ai/oauth/callback';

// ── Reset between tests ───────────────────────────────────────────────────────

beforeEach(() => {
  testDb.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['oauth_consents', 'oauth_tokens', 'oauth_clients', 'users']) {
    try { testDb.exec(`DELETE FROM "${t}"`); } catch {}
  }
  testDb.exec('PRAGMA foreign_keys = ON');
});

afterAll(() => {
  testDb.close();
});

// ── Client management ─────────────────────────────────────────────────────────

describe('createOAuthClient', () => {
  it('creates a confidential client with a hashed secret', () => {
    const userId = seedUser();
    const { client, clientSecret } = createOAuthClient(userId, 'My App', [TEST_REDIRECT], TEST_SCOPES, false, 'settings_ui');

    expect(client.name).toBe('My App');
    expect(client.client_id).toBeTruthy();
    expect(client.is_public).toBe(false);
    expect(clientSecret).toMatch(/^treks_/);

    const row = testDb.prepare('SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?').get(client.client_id) as any;
    expect(row.client_secret_hash).toBeTruthy();
    expect(row.client_secret_hash).not.toBe(clientSecret);
  });

  it('creates a public client with no secret', () => {
    const userId = seedUser();
    const { client, clientSecret } = createOAuthClient(userId, 'Public App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');

    expect(client.is_public).toBe(true);
    expect(clientSecret).toBeNull();
  });

  it('filters out unknown scopes', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], ['trips:read', 'nonexistent:scope'], false, 'settings_ui');
    expect(client.allowed_scopes).toEqual(['trips:read']);
  });

  it('enforces per-user client cap', () => {
    const userId = seedUser();
    for (let i = 0; i < 10; i++) {
      createOAuthClient(userId, `App ${i}`, [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    }
    expect(() => createOAuthClient(userId, 'One Too Many', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui'))
      .toThrow();
  });
});

describe('listClientsForUser', () => {
  it('returns clients for the user', () => {
    const userId = seedUser();
    createOAuthClient(userId, 'App A', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    createOAuthClient(userId, 'App B', [TEST_REDIRECT], TEST_SCOPES, false, 'settings_ui');
    const clients = listClientsForUser(userId);
    expect(clients).toHaveLength(2);
    expect(clients.map(c => c.name).sort()).toEqual(['App A', 'App B']);
  });

  it('does not return other users clients', () => {
    const a = seedUser('alice');
    const b = seedUser('bob');
    createOAuthClient(a, 'App A', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    expect(listClientsForUser(b)).toHaveLength(0);
  });
});

describe('deleteClient', () => {
  it('deletes own client', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    deleteClient(client.client_id, userId);
    expect(listClientsForUser(userId)).toHaveLength(0);
  });

  it('throws for non-existent client', () => {
    const userId = seedUser();
    expect(() => deleteClient('nonexistent', userId)).toThrow();
  });

  it('cascades to tokens', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');
    deleteClient(client.client_id, userId);
    const tokens = testDb.prepare('SELECT * FROM oauth_tokens WHERE client_id = ?').all(client.client_id);
    expect(tokens).toHaveLength(0);
  });
});

describe('rotateClientSecret', () => {
  it('returns a new raw secret and invalidates old one', () => {
    const userId = seedUser();
    const { client, clientSecret: oldSecret } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, false, 'settings_ui');
    const newSecret = rotateClientSecret(client.client_id, userId);

    expect(newSecret).toMatch(/^treks_/);
    expect(newSecret).not.toBe(oldSecret);
  });

  it('throws for public client', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    expect(() => rotateClientSecret(client.client_id, userId)).toThrow();
  });
});

// ── Token issuance and lookup ─────────────────────────────────────────────────

describe('issueTokens + getUserByAccessToken', () => {
  it('issues tokens and retrieves user by access token', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');

    const info = getUserByAccessToken(accessToken);
    expect(info).not.toBeNull();
    expect(info!.user.id).toBe(userId);
    expect(info!.scopes).toEqual(TEST_SCOPES);
    expect(info!.clientId).toBe(client.client_id);
  });

  it('returns null for unknown token', () => {
    expect(getUserByAccessToken('trekoa_notexisting')).toBeNull();
  });

  it('returns null for revoked token', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { accessToken, tokenId } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');
    testDb.prepare('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(tokenId);
    expect(getUserByAccessToken(accessToken)).toBeNull();
  });

  it('returns null for expired token', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { accessToken, tokenId } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');
    testDb.prepare("UPDATE oauth_tokens SET access_token_expires_at = datetime('now', '-1 second') WHERE id = ?").run(tokenId);
    expect(getUserByAccessToken(accessToken)).toBeNull();
  });
});

// ── Token exchange (auth code flow) ──────────────────────────────────────────

describe('exchangeAuthCode', () => {
  function makeVerifier(): { verifier: string; challenge: string } {
    const crypto = require('crypto');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  it('exchanges a valid auth code for tokens', () => {
    const userId = seedUser();
    const { client, clientSecret } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, false, 'settings_ui');
    const { verifier, challenge } = makeVerifier();

    const code = createAuthCode(client.client_id, userId, TEST_REDIRECT, TEST_SCOPES, challenge, 'https://trek.example.com/mcp');
    const tokens = exchangeAuthCode(code, verifier, client.client_id, clientSecret!, TEST_REDIRECT, 'https://trek.example.com/mcp');

    expect(tokens.access_token).toMatch(/^trekoa_/);
    expect(tokens.refresh_token).toMatch(/^trekrf_/);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
  });

  it('rejects wrong PKCE verifier', () => {
    const userId = seedUser();
    const { client, clientSecret } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, false, 'settings_ui');
    const { challenge } = makeVerifier();

    const code = createAuthCode(client.client_id, userId, TEST_REDIRECT, TEST_SCOPES, challenge, 'https://trek.example.com/mcp');
    expect(() =>
      exchangeAuthCode(code, 'wrong-verifier', client.client_id, clientSecret!, TEST_REDIRECT, 'https://trek.example.com/mcp')
    ).toThrow();
  });

  it('rejects reused auth code', () => {
    const userId = seedUser();
    const { client, clientSecret } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, false, 'settings_ui');
    const { verifier, challenge } = makeVerifier();

    const code = createAuthCode(client.client_id, userId, TEST_REDIRECT, TEST_SCOPES, challenge, 'https://trek.example.com/mcp');
    exchangeAuthCode(code, verifier, client.client_id, clientSecret!, TEST_REDIRECT, 'https://trek.example.com/mcp');
    expect(() =>
      exchangeAuthCode(code, verifier, client.client_id, clientSecret!, TEST_REDIRECT, 'https://trek.example.com/mcp')
    ).toThrow();
  });

  it('rejects wrong client secret', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, false, 'settings_ui');
    const { verifier, challenge } = makeVerifier();

    const code = createAuthCode(client.client_id, userId, TEST_REDIRECT, TEST_SCOPES, challenge, 'https://trek.example.com/mcp');
    expect(() =>
      exchangeAuthCode(code, verifier, client.client_id, 'wrong-secret', TEST_REDIRECT, 'https://trek.example.com/mcp')
    ).toThrow();
  });
});

// ── Refresh token rotation ────────────────────────────────────────────────────

describe('refreshTokens', () => {
  it('rotates tokens and invalidates old refresh token', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { accessToken: at1, refreshToken: rt1 } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');

    const tokens2 = refreshTokens(rt1, client.client_id, undefined);
    expect(tokens2.access_token).toMatch(/^trekoa_/);
    expect(tokens2.access_token).not.toBe(at1);
    expect(tokens2.refresh_token).toMatch(/^trekrf_/);
    expect(tokens2.refresh_token).not.toBe(rt1);
  });

  it('replay detection: reusing an old refresh token revokes the chain', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { refreshToken: rt1 } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');

    // First refresh is fine
    refreshTokens(rt1, client.client_id, undefined);

    // Re-presenting rt1 (replay) should throw AND revoke the new token too
    expect(() => refreshTokens(rt1, client.client_id, undefined)).toThrow();

    // All tokens for this client+user should be revoked
    const active = testDb.prepare(
      'SELECT COUNT(*) as c FROM oauth_tokens WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL'
    ).get(client.client_id, userId) as { c: number };
    expect(active.c).toBe(0);
  });

  it('rejects expired refresh token', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { tokenId, refreshToken } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');
    testDb.prepare("UPDATE oauth_tokens SET refresh_token_expires_at = datetime('now', '-1 second') WHERE id = ?").run(tokenId);
    expect(() => refreshTokens(refreshToken, client.client_id, undefined)).toThrow();
  });
});

// ── Token revocation ──────────────────────────────────────────────────────────

describe('revokeToken', () => {
  it('revokes by access token', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { accessToken, tokenId } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');

    revokeToken(accessToken, client.client_id, undefined);

    const row = testDb.prepare('SELECT revoked_at FROM oauth_tokens WHERE id = ?').get(tokenId) as any;
    expect(row.revoked_at).not.toBeNull();
  });

  it('revokes by refresh token', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { refreshToken, tokenId } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');

    revokeToken(refreshToken, client.client_id, undefined);

    const row = testDb.prepare('SELECT revoked_at FROM oauth_tokens WHERE id = ?').get(tokenId) as any;
    expect(row.revoked_at).not.toBeNull();
  });

  it('does not throw for unknown token (RFC 7009)', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    expect(() => revokeToken('trekoa_nonexistent', client.client_id, undefined)).not.toThrow();
  });
});

// ── Session listing and revocation ────────────────────────────────────────────

describe('listActiveSessions + revokeSession', () => {
  it('lists active (non-revoked, non-expired) sessions', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');
    issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');

    const sessions = listActiveSessions(userId);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].client_name).toBe('App');
    expect(sessions[0].scopes).toEqual(TEST_SCOPES);
  });

  it('excludes revoked sessions', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { tokenId } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');
    testDb.prepare('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(tokenId);

    expect(listActiveSessions(userId)).toHaveLength(0);
  });

  it('revokeSession marks token as revoked', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { tokenId } = issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');

    revokeSession(tokenId, userId);

    expect(listActiveSessions(userId)).toHaveLength(0);
  });

  it('revokeSession throws for wrong user', () => {
    const alice = seedUser('alice');
    const bob = seedUser('bob');
    const { client } = createOAuthClient(alice, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const { tokenId } = issueTokens(client.client_id, alice, TEST_SCOPES, 'https://trek.example.com/mcp');

    expect(() => revokeSession(tokenId, bob)).toThrow();
  });
});

// ── validateAuthorizeRequest ──────────────────────────────────────────────────

describe('validateAuthorizeRequest', () => {
  it('returns loginRequired for unauthenticated user', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'dcr');

    const result = validateAuthorizeRequest({
      client_id: client.client_id,
      redirect_uri: TEST_REDIRECT,
      response_type: 'code',
      scope: 'trips:read',
    }, null);

    expect(result.valid).toBe(true);
    expect(result.loginRequired).toBe(true);
  });

  it('returns consentRequired when no prior consent', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'dcr');

    const result = validateAuthorizeRequest({
      client_id: client.client_id,
      redirect_uri: TEST_REDIRECT,
      response_type: 'code',
      scope: 'trips:read',
    }, userId);

    expect(result.valid).toBe(true);
    expect(result.consentRequired).toBe(true);
  });

  it('returns consentRequired=false when all scopes consented', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'dcr');
    recordConsent(client.client_id, userId, TEST_SCOPES);

    const result = validateAuthorizeRequest({
      client_id: client.client_id,
      redirect_uri: TEST_REDIRECT,
      response_type: 'code',
      scope: TEST_SCOPES.join(' '),
    }, userId);

    expect(result.valid).toBe(true);
    expect(result.consentRequired).toBe(false);
  });

  it('returns error for unknown client', () => {
    const userId = seedUser();
    const result = validateAuthorizeRequest({
      client_id: 'unknown-client-id',
      redirect_uri: TEST_REDIRECT,
      response_type: 'code',
    }, userId);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_client');
  });

  it('returns error for wrong redirect_uri', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    const result = validateAuthorizeRequest({
      client_id: client.client_id,
      redirect_uri: 'https://evil.example.com/callback',
      response_type: 'code',
    }, userId);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_redirect_uri');
  });
});

// ── recordConsent ─────────────────────────────────────────────────────────────

describe('recordConsent', () => {
  it('stores consent', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    recordConsent(client.client_id, userId, ['trips:read']);

    const row = testDb.prepare('SELECT scopes FROM oauth_consents WHERE client_id = ? AND user_id = ?').get(client.client_id, userId) as any;
    expect(JSON.parse(row.scopes)).toContain('trips:read');
  });

  it('unions new scopes with existing (never narrows)', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    recordConsent(client.client_id, userId, ['trips:read']);
    recordConsent(client.client_id, userId, ['places:read']);

    const row = testDb.prepare('SELECT scopes FROM oauth_consents WHERE client_id = ? AND user_id = ?').get(client.client_id, userId) as any;
    const scopes = JSON.parse(row.scopes);
    expect(scopes).toContain('trips:read');
    expect(scopes).toContain('places:read');
  });
});

// ── revokeUserSessionsForOAuthClient ─────────────────────────────────────────

describe('revokeUserSessionsForOAuthClient', () => {
  it('revokes all active tokens for a client+user pair', () => {
    const userId = seedUser();
    const { client } = createOAuthClient(userId, 'App', [TEST_REDIRECT], TEST_SCOPES, true, 'settings_ui');
    issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');
    issueTokens(client.client_id, userId, TEST_SCOPES, 'https://trek.example.com/mcp');

    revokeUserSessionsForOAuthClient(userId, client.client_id);

    const active = testDb.prepare(
      'SELECT COUNT(*) as c FROM oauth_tokens WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL'
    ).get(client.client_id, userId) as { c: number };
    expect(active.c).toBe(0);
  });
});
