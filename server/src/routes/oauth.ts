import express, { Request, Response } from 'express';
import cors from 'cors';
import { authenticate, optionalAuth } from '../middleware/auth';
import { isAddonEnabled } from '../services/adminService';
import { getAppUrl } from '../services/oidcService';
import { IMPLEMENTED_SCOPES } from '../mcp/implementedScopes';
import type { AuthRequest, OptionalAuthRequest } from '../types';
import {
  createOAuthClient,
  listClientsForUser,
  deleteClient,
  rotateClientSecret,
  exchangeAuthCode,
  refreshTokens,
  revokeToken,
  listActiveSessions,
  revokeSession,
  validateAuthorizeRequest,
  createAuthCode,
  recordConsent,
  getAudience,
} from '../services/oauthService';

// ── Rate limiters ─────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60 * 1000;
const RATE_CLEANUP_MS = 5 * 60 * 1000;

export const tokenAttempts = new Map<string, { count: number; first: number }>();
export const registerAttempts = new Map<string, { count: number; first: number }>();
export const revokeAttempts = new Map<string, { count: number; first: number }>();
export const validateAttempts = new Map<string, { count: number; first: number }>();

function sweepStore(store: Map<string, { count: number; first: number }>): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.first >= RATE_WINDOW_MS) store.delete(k);
  }
}

setInterval(() => {
  sweepStore(tokenAttempts);
  sweepStore(registerAttempts);
  sweepStore(revokeAttempts);
  sweepStore(validateAttempts);
}, RATE_CLEANUP_MS).unref();

function rateLimiter(max: number, store: Map<string, { count: number; first: number }>, keyFn: (req: Request) => string = (r) => r.ip ?? 'unknown') {
  return (req: Request, res: Response, next: () => void): void => {
    const key = keyFn(req);
    const now = Date.now();
    const record = store.get(key);
    if (record && record.count >= max && now - record.first < RATE_WINDOW_MS) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    if (!record || now - record.first >= RATE_WINDOW_MS) {
      store.set(key, { count: 1, first: now });
    } else {
      record.count++;
    }
    next();
  };
}

const tokenLimiter = rateLimiter(30, tokenAttempts, (req) => `${req.ip ?? 'unknown'}:${(req.body?.client_id ?? '')}`);
const registerLimiter = rateLimiter(10, registerAttempts);
const revokeLimiter = rateLimiter(10, revokeAttempts);
const validateLimiter = rateLimiter(30, validateAttempts);

// ── DCR redirect URI validation ───────────────────────────────────────────────

const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'blob', 'chrome', 'about']);

function isValidRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1); // strip trailing ':'
  if (BLOCKED_SCHEMES.has(scheme)) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    const host = url.hostname;
    return host === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  }
  // RFC 8252 private-use: any non-blocked, non-http(s) custom scheme (e.g. com.example.app)
  if (/^[a-z][a-z0-9+\-.]*$/i.test(scheme)) return true;
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  return (getAppUrl() ?? '').replace(/\/+$/, '');
}

function oauthError(res: Response, statusOrCode: number | string, message?: string): void {
  const isStatus = typeof statusOrCode === 'number';
  const status = isStatus ? statusOrCode : 400;
  const error = isStatus ? (message ?? 'server_error') : statusOrCode;
  res.status(status).json({ error });
}

// ── Public router ─────────────────────────────────────────────────────────────
//    Mounted at / in app.ts — handles /.well-known/* and /oauth/*
//    .well-known and token/revoke endpoints use open CORS (origin: '*')

export const publicRouter = express.Router();
const openCors = cors({ origin: '*' });

// RFC 8414 — Authorization Server Metadata
publicRouter.get('/.well-known/oauth-authorization-server', openCors, (_req: Request, res: Response) => {
  const base = getBaseUrl();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: IMPLEMENTED_SCOPES,
    resource_parameter_supported: true,
  });
});

// RFC 9728 — Protected Resource Metadata
publicRouter.get('/.well-known/oauth-protected-resource', openCors, (_req: Request, res: Response) => {
  if (!isAddonEnabled('mcp')) {
    res.status(403).json({ error: 'MCP addon is disabled' });
    return;
  }
  const base = getBaseUrl();
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: IMPLEMENTED_SCOPES,
    resource_name: 'TREK MCP',
  });
});

// POST /oauth/token — authorization_code and refresh_token grants
publicRouter.post('/oauth/token', openCors, tokenLimiter, (req: Request, res: Response) => {
  const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token, resource } = req.body ?? {};

  if (!grant_type || !client_id) {
    oauthError(res, 'invalid_request');
    return;
  }

  try {
    if (grant_type === 'authorization_code') {
      if (!code || !redirect_uri || !code_verifier) {
        oauthError(res, 'invalid_request');
        return;
      }
      const tokens = exchangeAuthCode(code, code_verifier, client_id, client_secret, redirect_uri, resource ?? '');
      res.json(tokens);
      return;
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        oauthError(res, 'invalid_request');
        return;
      }
      const tokens = refreshTokens(refresh_token, client_id, client_secret);
      res.json(tokens);
      return;
    }

    oauthError(res, 'unsupported_grant_type');
  } catch (err: any) {
    const errCode: string = err?.oauthError ?? 'server_error';
    const status = errCode === 'invalid_client' ? 401 : 400;
    res.status(status).json({ error: errCode });
  }
});

// POST /oauth/revoke — RFC 7009 token revocation
publicRouter.post('/oauth/revoke', openCors, revokeLimiter, (req: Request, res: Response) => {
  const { token, client_id, client_secret } = req.body ?? {};
  if (!token || !client_id) {
    oauthError(res, 'invalid_request');
    return;
  }
  try {
    revokeToken(token, client_id, client_secret);
    res.json({});
  } catch (err: any) {
    const errCode: string = err?.oauthError ?? 'server_error';
    const status = errCode === 'invalid_client' ? 401 : 400;
    res.status(status).json({ error: errCode });
  }
});

// POST /oauth/register — RFC 7591 Dynamic Client Registration
publicRouter.post('/oauth/register', registerLimiter, (req: Request, res: Response) => {
  const body = req.body ?? {};
  const { client_name, redirect_uris, scope, token_endpoint_auth_method } = body;

  if (!client_name || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: 'invalid_client_metadata' });
    return;
  }

  for (const uri of redirect_uris) {
    if (typeof uri !== 'string' || !isValidRedirectUri(uri)) {
      res.status(400).json({ error: 'invalid_redirect_uri' });
      return;
    }
  }

  const isPublic = token_endpoint_auth_method === 'none';
  const requestedScopes: string[] = scope ? (scope as string).split(' ') : IMPLEMENTED_SCOPES;

  try {
    const { client, clientSecret } = createOAuthClient(null, client_name, redirect_uris, requestedScopes, isPublic, 'dcr');

    const base = getBaseUrl();
    const response: Record<string, unknown> = {
      client_id: client.client_id,
      client_name: client.name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: client.allowed_scopes.join(' '),
      registration_client_uri: `${base}/oauth/register/${client.client_id}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };

    if (clientSecret) {
      response.client_secret = clientSecret;
      response.client_secret_expires_at = 0;
    }

    res.status(201).json(response);
  } catch (err: any) {
    if (err?.code === 'DCR_LIMIT') {
      res.status(429).json({ error: 'too_many_registrations' });
      return;
    }
    res.status(500).json({ error: 'server_error' });
  }
});

// ── API router ────────────────────────────────────────────────────────────────
//    Mounted at /api/oauth in app.ts — standard cookie auth

export const apiRouter = express.Router();

// GET /api/oauth/authorize/validate
apiRouter.get('/authorize/validate', validateLimiter, optionalAuth, (req: Request, res: Response) => {
  const optReq = req as OptionalAuthRequest;
  const q = req.query as Record<string, string | undefined>;

  const result = validateAuthorizeRequest({
    client_id: q.client_id ?? '',
    redirect_uri: q.redirect_uri ?? '',
    response_type: q.response_type ?? 'code',
    scope: q.scope,
    state: q.state,
    code_challenge: q.code_challenge,
    code_challenge_method: q.code_challenge_method,
    resource: q.resource,
  }, optReq.user?.id ?? null);

  res.json(result);
});

// POST /api/oauth/authorize — user submits consent
apiRouter.post('/authorize', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource, approved_scopes, approved } = req.body ?? {};

  if (!client_id || !redirect_uri) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  // Re-validate client + redirect_uri to prevent open redirects
  const validation = validateAuthorizeRequest({
    client_id,
    redirect_uri,
    response_type: 'code',
    scope,
    state,
    code_challenge: code_challenge || '_',
    code_challenge_method,
    resource,
  }, authReq.user.id);

  if (!validation.valid) {
    res.status(400).json({ error: validation.error ?? 'invalid_request' });
    return;
  }

  // Build safe redirect URL from validated redirect_uri
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect_uri);
  } catch {
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  if (approved === false) {
    redirectUrl.searchParams.set('error', 'access_denied');
    if (state) redirectUrl.searchParams.set('state', state);
    res.json({ redirect: redirectUrl.toString() });
    return;
  }

  if (!code_challenge || code_challenge_method !== 'S256') {
    res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256' });
    return;
  }

  const requestedScopes: string[] = approved_scopes ?? (scope ? (scope as string).split(' ') : (validation.scopes?.map(s => s.scope) ?? []));

  recordConsent(client_id, authReq.user.id, requestedScopes);

  const code = createAuthCode(
    client_id,
    authReq.user.id,
    redirect_uri,
    requestedScopes,
    code_challenge,
    resource ?? getAudience(),
  );

  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  res.json({ redirect: redirectUrl.toString() });
});

// GET /api/oauth/clients
apiRouter.get('/clients', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json({ clients: listClientsForUser(authReq.user.id) });
});

// POST /api/oauth/clients
apiRouter.post('/clients', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { name, redirect_uris, allowed_scopes, is_public } = req.body ?? {};

  if (!name || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: 'name and redirect_uris required' });
    return;
  }

  for (const uri of redirect_uris) {
    if (typeof uri !== 'string' || !isValidRedirectUri(uri)) {
      res.status(400).json({ error: 'invalid_redirect_uri' });
      return;
    }
  }

  try {
    const { client, clientSecret } = createOAuthClient(
      authReq.user.id,
      name,
      redirect_uris,
      Array.isArray(allowed_scopes) ? allowed_scopes : IMPLEMENTED_SCOPES,
      !!is_public,
      'settings_ui',
    );
    res.status(201).json({ client, clientSecret });
  } catch (err: any) {
    if (err?.code === 'CLIENT_LIMIT') {
      res.status(422).json({ error: 'Client limit reached' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/oauth/clients/:id/rotate
apiRouter.post('/clients/:id/rotate', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  try {
    const clientSecret = rotateClientSecret(req.params.id, authReq.user.id);
    res.json({ clientSecret });
  } catch (err: any) {
    if (err?.code === 'NOT_FOUND') { res.status(404).json({ error: 'Client not found' }); return; }
    if (err?.code === 'PUBLIC_CLIENT') { res.status(400).json({ error: 'Public clients have no secret' }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/oauth/clients/:id
apiRouter.delete('/clients/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  try {
    deleteClient(req.params.id, authReq.user.id);
    res.status(204).send();
  } catch (err: any) {
    if (err?.code === 'NOT_FOUND') { res.status(404).json({ error: 'Client not found' }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/oauth/sessions
apiRouter.get('/sessions', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json({ sessions: listActiveSessions(authReq.user.id) });
});

// DELETE /api/oauth/sessions/:tokenId
apiRouter.delete('/sessions/:tokenId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const tokenId = parseInt(req.params.tokenId, 10);
  if (isNaN(tokenId)) {
    res.status(400).json({ error: 'Invalid token id' });
    return;
  }
  try {
    revokeSession(tokenId, authReq.user.id);
    res.status(204).send();
  } catch (err: any) {
    if (err?.code === 'NOT_FOUND') { res.status(404).json({ error: 'Session not found' }); return; }
    res.status(500).json({ error: 'Internal server error' });
  }
});
