import { randomUUID, createHash, timingSafeEqual, randomBytes } from 'crypto';
import { db } from '../db/database';
import { getAppUrl } from './oidcService';
import { revokeUserSessionsForClient } from '../mcp/sessionManager';
import type {
  OAuthClient,
  OAuthClientResult,
  OAuthTokenInfo,
  OAuthTokens,
  OAuthSessionInfo,
  AuthorizeParams,
  ValidateAuthorizeResult,
} from '../types';
import { SCOPE_DEFINITIONS, ALL_SCOPES } from '../mcp/scopes';

// ── Constants ─────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_S = 60 * 60;          // 1 hour
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60; // 30 days
const AUTH_CODE_TTL_MS = 2 * 60 * 1000;      // 2 minutes
const AUTH_CODE_MAX = 500;
const MAX_CLIENTS_PER_USER = 10;
const MAX_DCR_CLIENTS = 500;

// ── Auth code store ───────────────────────────────────────────────────────────

interface AuthCode {
  clientId: string;
  userId: number;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  resource: string;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCode>();

const codeSweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(code);
  }
}, 60_000);
codeSweepInterval.unref();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Still run timingSafeEqual on equal-length buffers to prevent timing leak
    timingSafeEqual(Buffer.alloc(aBuf.length), Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function generateRawToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('hex')}`;
}

function nowPlusSecs(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// SQLite CURRENT_TIMESTAMP format is "YYYY-MM-DD HH:MM:SS" (always UTC internally).
// new Date('YYYY-MM-DD HH:MM:SS') is parsed as *local* time in V8, so we must
// append 'Z' to force UTC interpretation before comparing with Date.now().
function parseSqliteUtc(dt: string): number {
  return new Date(dt.includes('T') ? dt : dt.replace(' ', 'T') + 'Z').getTime();
}

function parseClientRow(row: any): OAuthClient {
  return {
    ...row,
    redirect_uris: JSON.parse(row.redirect_uris),
    allowed_scopes: JSON.parse(row.allowed_scopes),
    is_public: row.is_public === 1,
  };
}

function getAudience(): string {
  const base = (getAppUrl() ?? '').replace(/\/+$/, '');
  return `${base}/mcp`;
}

// ── Client management ─────────────────────────────────────────────────────────

export function createOAuthClient(
  userId: number | null,
  name: string,
  redirectUris: string[],
  allowedScopes: string[],
  isPublic: boolean,
  createdVia: 'settings_ui' | 'dcr',
): OAuthClientResult {
  if (userId !== null) {
    const count = (db.prepare('SELECT COUNT(*) as c FROM oauth_clients WHERE user_id = ?').get(userId) as { c: number }).c;
    if (count >= MAX_CLIENTS_PER_USER) throw Object.assign(new Error('Client limit reached'), { code: 'CLIENT_LIMIT' });
  } else {
    const count = (db.prepare("SELECT COUNT(*) as c FROM oauth_clients WHERE created_via = 'dcr'").get() as { c: number }).c;
    if (count >= MAX_DCR_CLIENTS) throw Object.assign(new Error('Global DCR client limit reached'), { code: 'DCR_LIMIT' });
  }

  const id = randomUUID();
  const clientId = randomUUID();
  let clientSecret: string | null = null;
  let secretHash: string | null = null;

  if (!isPublic) {
    clientSecret = generateRawToken('treks_');
    secretHash = sha256hex(clientSecret);
  }

  const validScopes = allowedScopes.filter(s => ALL_SCOPES.includes(s));

  db.prepare(`
    INSERT INTO oauth_clients (id, user_id, name, client_id, client_secret_hash, redirect_uris, allowed_scopes, is_public, created_via)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, name, clientId, secretHash, JSON.stringify(redirectUris), JSON.stringify(validScopes), isPublic ? 1 : 0, createdVia);

  const row = db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id) as any;
  return { client: parseClientRow(row), clientSecret };
}

export function listClientsForUser(userId: number): OAuthClient[] {
  const rows = db.prepare('SELECT * FROM oauth_clients WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[];
  return rows.map(parseClientRow);
}

export function deleteClient(clientId: string, userId: number): void {
  const client = db.prepare('SELECT id FROM oauth_clients WHERE client_id = ? AND user_id = ?').get(clientId, userId);
  if (!client) throw Object.assign(new Error('Client not found'), { code: 'NOT_FOUND' });
  db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId);
}

export function rotateClientSecret(clientId: string, userId: number): string {
  const client = db.prepare('SELECT id, is_public FROM oauth_clients WHERE client_id = ? AND user_id = ?').get(clientId, userId) as any;
  if (!client) throw Object.assign(new Error('Client not found'), { code: 'NOT_FOUND' });
  if (client.is_public) throw Object.assign(new Error('Public clients have no secret'), { code: 'PUBLIC_CLIENT' });

  const newSecret = generateRawToken('treks_');
  db.prepare('UPDATE oauth_clients SET client_secret_hash = ? WHERE client_id = ?').run(sha256hex(newSecret), clientId);
  return newSecret;
}

// ── Authorization flow ────────────────────────────────────────────────────────

export function validateAuthorizeRequest(params: AuthorizeParams, userId: number | null): ValidateAuthorizeResult {
  if (!params.client_id || !params.redirect_uri || params.response_type !== 'code') {
    return { valid: false, error: 'invalid_request' };
  }

  const clientRow = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(params.client_id) as any;
  if (!clientRow) return { valid: false, error: 'invalid_client' };

  const client = parseClientRow(clientRow);
  const redirectUris: string[] = client.redirect_uris;
  if (!redirectUris.includes(params.redirect_uri)) return { valid: false, error: 'invalid_redirect_uri' };

  if (!userId) return { valid: true, loginRequired: true, client: { name: client.name, clientId: client.client_id } };

  const requestedScopes = params.scope ? params.scope.split(' ').filter(s => ALL_SCOPES.includes(s)) : client.allowed_scopes;
  const allowedScopes = requestedScopes.filter(s => client.allowed_scopes.includes(s));

  const consentRow = db.prepare('SELECT scopes FROM oauth_consents WHERE client_id = ? AND user_id = ?').get(params.client_id, userId) as { scopes: string } | undefined;
  const consentedScopes: string[] = consentRow ? JSON.parse(consentRow.scopes) : [];
  const consentRequired = allowedScopes.some(s => !consentedScopes.includes(s));

  const scopeDetails = allowedScopes.map(s => ({
    scope: s,
    label: SCOPE_DEFINITIONS[s]?.label ?? s,
    group: SCOPE_DEFINITIONS[s]?.group ?? 'Other',
  }));

  const scopeSelectable = !clientRow.user_id; // DCR clients (no registered user) get scope picker

  return {
    valid: true,
    loginRequired: false,
    consentRequired,
    client: { name: client.name, clientId: client.client_id },
    scopes: scopeDetails,
    scopeSelectable,
  };
}

export function createAuthCode(
  clientId: string,
  userId: number,
  redirectUri: string,
  scopes: string[],
  codeChallenge: string,
  resource: string,
): string {
  if (authCodes.size >= AUTH_CODE_MAX) {
    // Evict oldest
    const oldest = [...authCodes.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) authCodes.delete(oldest[0]);
  }

  const code = generateRawToken('trekac_');
  authCodes.set(code, {
    clientId,
    userId,
    redirectUri,
    scopes,
    codeChallenge,
    resource,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  return code;
}

// ── Consent management ────────────────────────────────────────────────────────

export function recordConsent(clientId: string, userId: number, scopes: string[]): void {
  const existing = db.prepare('SELECT scopes FROM oauth_consents WHERE client_id = ? AND user_id = ?').get(clientId, userId) as { scopes: string } | undefined;
  const existing_scopes: string[] = existing ? JSON.parse(existing.scopes) : [];
  const union = Array.from(new Set([...existing_scopes, ...scopes]));

  db.prepare(`
    INSERT INTO oauth_consents (client_id, user_id, scopes, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(client_id, user_id) DO UPDATE SET scopes = excluded.scopes, updated_at = CURRENT_TIMESTAMP
  `).run(clientId, userId, JSON.stringify(union));
}

// ── Token operations ──────────────────────────────────────────────────────────

export function issueTokens(
  clientId: string,
  userId: number,
  scopes: string[],
  audience: string,
  parentTokenId?: number,
): { accessToken: string; refreshToken: string; tokenId: number } {
  const accessToken = generateRawToken('trekoa_');
  const refreshToken = generateRawToken('trekrf_');

  const result = db.prepare(`
    INSERT INTO oauth_tokens (client_id, user_id, access_token_hash, refresh_token_hash, scopes, audience, access_token_expires_at, refresh_token_expires_at, parent_token_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clientId,
    userId,
    sha256hex(accessToken),
    sha256hex(refreshToken),
    JSON.stringify(scopes),
    audience,
    nowPlusSecs(ACCESS_TOKEN_TTL_S),
    nowPlusSecs(REFRESH_TOKEN_TTL_S),
    parentTokenId ?? null,
  );

  return { accessToken, refreshToken, tokenId: result.lastInsertRowid as number };
}

export function getUserByAccessToken(rawToken: string): OAuthTokenInfo | null {
  const hash = sha256hex(rawToken);
  const row = db.prepare(`
    SELECT t.id, t.client_id, t.user_id, t.scopes, t.access_token_expires_at, t.revoked_at,
           u.username, u.email, u.role
    FROM oauth_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.access_token_hash = ?
  `).get(hash) as any;

  if (!row) return null;
  if (row.revoked_at) return null;
  if (parseSqliteUtc(row.access_token_expires_at) < Date.now()) return null;

  return {
    user: { id: row.user_id, username: row.username, email: row.email, role: row.role },
    scopes: JSON.parse(row.scopes),
    clientId: row.client_id,
    tokenId: row.id,
  };
}

function validateClientCredentials(clientId: string, clientSecret: string | undefined): OAuthClient {
  const row = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as any;
  if (!row) throw Object.assign(new Error('invalid_client'), { oauthError: 'invalid_client' });

  const client = parseClientRow(row);

  if (!client.is_public) {
    if (!clientSecret) throw Object.assign(new Error('client_secret required'), { oauthError: 'invalid_client' });
    if (!row.client_secret_hash) throw Object.assign(new Error('invalid_client'), { oauthError: 'invalid_client' });
    if (!timingSafeCompare(sha256hex(clientSecret), row.client_secret_hash)) {
      throw Object.assign(new Error('invalid_client'), { oauthError: 'invalid_client' });
    }
  }

  return client;
}

export function exchangeAuthCode(
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string,
  resource: string,
): OAuthTokens {
  const client = validateClientCredentials(clientId, clientSecret);

  const entry = authCodes.get(code);
  if (!entry) throw Object.assign(new Error('invalid_grant'), { oauthError: 'invalid_grant' });
  authCodes.delete(code);

  if (entry.expiresAt < Date.now()) throw Object.assign(new Error('invalid_grant'), { oauthError: 'invalid_grant' });
  if (entry.clientId !== clientId) throw Object.assign(new Error('invalid_grant'), { oauthError: 'invalid_grant' });
  if (entry.redirectUri !== redirectUri) throw Object.assign(new Error('invalid_grant'), { oauthError: 'invalid_grant' });

  // PKCE S256 verification
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  if (!timingSafeCompare(challenge, entry.codeChallenge)) {
    throw Object.assign(new Error('invalid_grant'), { oauthError: 'invalid_grant' });
  }

  const audience = resource || entry.resource || getAudience();
  const scopes = entry.scopes.filter(s => client.allowed_scopes.includes(s));

  const { accessToken, refreshToken } = issueTokens(clientId, entry.userId, scopes, audience);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    scope: scopes.join(' '),
  };
}

export function refreshTokens(
  rawRefreshToken: string,
  clientId: string,
  clientSecret: string | undefined,
): OAuthTokens {
  const client = validateClientCredentials(clientId, clientSecret);

  const hash = sha256hex(rawRefreshToken);
  const row = db.prepare(`
    SELECT * FROM oauth_tokens WHERE refresh_token_hash = ?
  `).get(hash) as any;

  if (!row) throw Object.assign(new Error('invalid_grant'), { oauthError: 'invalid_grant' });

  if (row.client_id !== clientId) throw Object.assign(new Error('invalid_grant'), { oauthError: 'invalid_grant' });

  if (row.revoked_at) {
    // Replay detected — cascade-revoke entire chain
    _revokeTokenChain(row.id, row.client_id, row.user_id);
    throw Object.assign(new Error('invalid_grant'), { oauthError: 'invalid_grant' });
  }

  if (parseSqliteUtc(row.refresh_token_expires_at) < Date.now()) {
    throw Object.assign(new Error('invalid_grant'), { oauthError: 'invalid_grant' });
  }

  // Revoke old token
  db.prepare('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);

  const scopes: string[] = JSON.parse(row.scopes);
  const { accessToken, refreshToken } = issueTokens(clientId, row.user_id, scopes, row.audience, row.id);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    scope: scopes.join(' '),
  };
}

export function revokeToken(rawToken: string, clientId: string, clientSecret: string | undefined): void {
  validateClientCredentials(clientId, clientSecret);

  const hash = sha256hex(rawToken);
  // Try as access token first, then refresh token
  const byAccess = db.prepare('SELECT id FROM oauth_tokens WHERE access_token_hash = ? AND client_id = ?').get(hash, clientId) as any;
  if (byAccess) {
    db.prepare('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(byAccess.id);
    return;
  }
  const byRefresh = db.prepare('SELECT id FROM oauth_tokens WHERE refresh_token_hash = ? AND client_id = ?').get(hash, clientId) as any;
  if (byRefresh) {
    db.prepare('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(byRefresh.id);
  }
  // RFC 7009: no error if token not found or already revoked
}

// ── Session listing ───────────────────────────────────────────────────────────

export function listActiveSessions(userId: number): OAuthSessionInfo[] {
  const rows = db.prepare(`
    SELECT t.id, t.client_id, c.name as client_name, t.scopes, t.audience,
           t.created_at, t.access_token_expires_at, t.refresh_token_expires_at
    FROM oauth_tokens t
    JOIN oauth_clients c ON c.client_id = t.client_id
    WHERE t.user_id = ?
      AND t.revoked_at IS NULL
      AND t.refresh_token_expires_at > CURRENT_TIMESTAMP
    ORDER BY t.created_at DESC
  `).all(userId) as any[];

  return rows.map(r => ({
    id: r.id,
    client_id: r.client_id,
    client_name: r.client_name,
    scopes: JSON.parse(r.scopes),
    audience: r.audience,
    created_at: r.created_at,
    access_token_expires_at: r.access_token_expires_at,
    refresh_token_expires_at: r.refresh_token_expires_at,
  }));
}

export function revokeSession(tokenId: number, userId: number): void {
  const row = db.prepare('SELECT id FROM oauth_tokens WHERE id = ? AND user_id = ?').get(tokenId, userId);
  if (!row) throw Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' });
  db.prepare('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(tokenId);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _revokeTokenChain(tokenId: number, clientId: string, userId: number): void {
  // Revoke this token and all descendants, then kill live MCP sessions
  db.prepare(`
    UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE (id = ? OR parent_token_id = ?) AND client_id = ? AND user_id = ?
  `).run(tokenId, tokenId, clientId, userId);

  revokeUserSessionsForClient(userId, clientId);
}

export function revokeUserSessionsForOAuthClient(userId: number, clientId: string): void {
  db.prepare(`
    UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL
  `).run(userId, clientId);
}

export { getAudience };
