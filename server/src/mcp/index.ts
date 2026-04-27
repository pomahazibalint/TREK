import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import { User } from '../types';
import { verifyMcpToken, verifyJwtToken } from '../services/authService';
import { isAddonEnabled } from '../services/adminService';
import { getAppUrl } from '../services/oidcService';
import { getUserByAccessToken } from '../services/oauthService';
import { registerResources } from './resources';
import { registerTools } from './tools';
import {
  McpSession,
  sessions,
  SESSION_TTL_MS,
  countSessionsForUser,
  revokeUserSessions,
  revokeUserSessionsForClient,
  closeMcpSessions,
} from './sessionManager';

// Re-export for backwards compatibility
export { revokeUserSessions, revokeUserSessionsForClient, closeMcpSessions };

// ── Constants ─────────────────────────────────────────────────────────────────

const sessionParsed = Number.parseInt(process.env.MCP_MAX_SESSION_PER_USER ?? '');
const MAX_SESSIONS_PER_USER = Number.isFinite(sessionParsed) && sessionParsed > 0 ? sessionParsed : 20;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateParsed = Number.parseInt(process.env.MCP_RATE_LIMIT ?? '');
const RATE_LIMIT_MAX = Number.isFinite(rateParsed) && rateParsed > 0 ? rateParsed : 60;

const STATIC_TOKEN_DEPRECATION_NOTICE =
  'Note: You are connected via a legacy TREK API token. These tokens are deprecated. ' +
  'Ask the user to reconnect via OAuth 2.1 in Settings → Integrations for scoped access.';

// ── Token verification ────────────────────────────────────────────────────────

interface VerifyTokenResult {
  user: User;
  scopes: string[] | null;
  clientId: string | null;
  isStaticToken: boolean;
}

function verifyToken(authHeader: string | undefined): VerifyTokenResult | null {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  if (token.startsWith('trekoa_')) {
    const result = getUserByAccessToken(token);
    if (!result) return null;
    return { user: result.user as User, scopes: result.scopes, clientId: result.clientId, isStaticToken: false };
  }

  if (token.startsWith('trek_')) {
    const user = verifyMcpToken(token);
    if (!user) return null;
    return { user, scopes: null, clientId: null, isStaticToken: true };
  }

  // JWT (browser / short-lived session token)
  const user = verifyJwtToken(token);
  if (!user) return null;
  return { user, scopes: null, clientId: null, isStaticToken: false };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function isRateLimited(userId: number, clientId: string | null): boolean {
  const key = `${userId}:${clientId ?? 'static'}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Sweep stale rate-limit buckets alongside session sweep (piggyback on sessionManager interval)
setInterval(() => {
  const rateCutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, entry] of rateLimitMap) {
    if (entry.windowStart < rateCutoff) rateLimitMap.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ── WWW-Authenticate helper ───────────────────────────────────────────────────

function setAuthChallenge(res: Response, error = 'invalid_token'): void {
  const base = (getAppUrl() ?? '').replace(/\/+$/, '');
  res.set(
    'WWW-Authenticate',
    `Bearer realm="TREK MCP", resource_metadata="${base}/.well-known/oauth-protected-resource", error="${error}"`,
  );
}

// ── MCP handler ───────────────────────────────────────────────────────────────

export async function mcpHandler(req: Request, res: Response): Promise<void> {
  if (!isAddonEnabled('mcp')) {
    res.status(403).json({ error: 'MCP is not enabled' });
    return;
  }

  const tokenResult = verifyToken(req.headers['authorization']);
  if (!tokenResult) {
    setAuthChallenge(res, 'invalid_token');
    res.status(401).json({ error: 'Access token required' });
    return;
  }

  const { user, scopes, clientId, isStaticToken } = tokenResult;

  if (isRateLimited(user.id, clientId)) {
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
    return;
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // Resume an existing session
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.userId !== user.id) {
      setAuthChallenge(res, 'insufficient_scope');
      res.status(403).json({ error: 'Session belongs to a different user' });
      return;
    }
    // Reject if the OAuth client changed mid-session (e.g. token was revoked and re-issued for a different client)
    if (session.clientId !== clientId) {
      setAuthChallenge(res, 'invalid_token');
      res.status(403).json({ error: 'Token client does not match session' });
      return;
    }
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // Only POST can initialize a new session
  if (req.method !== 'POST') {
    res.status(400).json({ error: 'Missing mcp-session-id header' });
    return;
  }

  if (countSessionsForUser(user.id) >= MAX_SESSIONS_PER_USER) {
    res.status(429).json({ error: 'Session limit reached. Close an existing session before opening a new one.' });
    return;
  }

  const serverOptions: ConstructorParameters<typeof McpServer>[0] = {
    name: 'trek',
    version: '1.0.0',
  };

  if (isStaticToken) {
    (serverOptions as any).instructions = STATIC_TOKEN_DEPRECATION_NOTICE;
  }

  const server = new McpServer(serverOptions);
  registerResources(server, user.id, scopes);
  registerTools(server, user.id, scopes);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      const session: McpSession = {
        server,
        transport,
        userId: user.id,
        lastActivity: Date.now(),
        scopes,
        clientId,
        isStaticToken,
      };
      sessions.set(sid, session);
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
    },
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
