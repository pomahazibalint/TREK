import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';

export interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  userId: number;
  lastActivity: number;
  scopes: string[] | null;
  clientId: string | null;
  isStaticToken: boolean;
}

export const sessions = new Map<string, McpSession>();

export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

const sessionSweepInterval = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sid, session] of sessions) {
    if (session.lastActivity < cutoff) {
      try { session.server.close(); } catch { /* ignore */ }
      try { session.transport.close(); } catch { /* ignore */ }
      sessions.delete(sid);
    }
  }
}, 10 * 60 * 1000);

sessionSweepInterval.unref();

export function countSessionsForUser(userId: number): number {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let count = 0;
  for (const session of sessions.values()) {
    if (session.userId === userId && session.lastActivity >= cutoff) count++;
  }
  return count;
}

/** Terminate all active MCP sessions for a user (e.g. on password change / account deletion). */
export function revokeUserSessions(userId: number): void {
  for (const [sid, session] of sessions) {
    if (session.userId === userId) {
      try { session.server.close(); } catch { /* ignore */ }
      try { session.transport.close(); } catch { /* ignore */ }
      sessions.delete(sid);
    }
  }
}

/** Terminate all active MCP sessions for a specific user+client pair (replay detection, token revocation). */
export function revokeUserSessionsForClient(userId: number, clientId: string): void {
  for (const [sid, session] of sessions) {
    if (session.userId === userId && session.clientId === clientId) {
      try { session.server.close(); } catch { /* ignore */ }
      try { session.transport.close(); } catch { /* ignore */ }
      sessions.delete(sid);
    }
  }
}

/** Close all active MCP sessions (call during graceful shutdown). */
export function closeMcpSessions(): void {
  clearInterval(sessionSweepInterval);
  for (const [, session] of sessions) {
    try { session.server.close(); } catch { /* ignore */ }
    try { session.transport.close(); } catch { /* ignore */ }
  }
  sessions.clear();
}
