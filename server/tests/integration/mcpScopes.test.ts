/**
 * MCP scope enforcement integration tests — Session 4 checkpoint.
 *
 * Verifies that OAuth clients with restricted scopes see only the tools and
 * resources they are entitled to, and that out-of-scope tools are absent from
 * the tools/list response.
 *
 * Strategy A (conditional registration) is tested by calling tools/list and
 * checking which tool names appear or are absent.
 *
 * JWT / static-token sessions (scopes = null) get full access — confirmed here too.
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
  getAppUrl: () => 'http://localhost:3001',
  verifyIdToken: () => null,
  findOrCreateUser: () => null,
}));

import { createApp } from '../../src/app';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb } from '../helpers/test-db';
import { createUser } from '../helpers/factories';
import { generateToken } from '../helpers/auth';
import { closeMcpSessions } from '../../src/mcp/index';
import { createOAuthClient, issueTokens } from '../../src/services/oauthService';

const app: Application = createApp();

const TEST_REDIRECT = 'https://claude.ai/oauth/callback';
const TEST_AUDIENCE = 'http://localhost:3001/mcp';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
});

afterAll(() => {
  closeMcpSessions();
  testDb.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function initSession(token: string): Promise<{ sessionId: string; status: number }> {
  testDb.prepare("UPDATE addons SET enabled = 1 WHERE id = 'mcp'").run();
  const res = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  return { sessionId: res.headers['mcp-session-id'] ?? '', status: res.status };
}

async function listTools(token: string, sessionId: string): Promise<string[]> {
  const res = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('mcp-session-id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', method: 'tools/list', id: 2, params: {} });

  if (res.status !== 200) return [];

  // Response may be SSE — extract the JSON data line
  const body = res.text ?? '';
  const dataLine = body.split('\n').find((l: string) => l.startsWith('data:'));
  if (!dataLine) return [];
  try {
    const parsed = JSON.parse(dataLine.slice(5).trim());
    return (parsed?.result?.tools ?? []).map((t: any) => t.name as string);
  } catch {
    return [];
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Scope enforcement — JWT (scopes = null) gets full tool list', () => {
  it('SCOPE-001 — JWT session sees all write tools', async () => {
    const { user } = createUser(testDb);
    const token = generateToken(user.id);

    const { sessionId, status } = await initSession(token);
    expect(status).toBe(200);

    const tools = await listTools(token, sessionId);
    // list_trips and get_trip_summary always present
    expect(tools).toContain('list_trips');
    expect(tools).toContain('get_trip_summary');
    // Write tools present for JWT (null scopes = full access)
    expect(tools).toContain('create_trip');
    expect(tools).toContain('create_place');
    expect(tools).toContain('create_packing_item');
    expect(tools).toContain('create_reservation');
    expect(tools).toContain('mark_country_visited');
    expect(tools).toContain('create_collab_note');
    // Read-only tools always present
    expect(tools).toContain('list_places');
    expect(tools).toContain('list_reservations');
    expect(tools).toContain('list_budget_items');
    expect(tools).toContain('get_budget_settlement');
    expect(tools).toContain('list_trip_members');
    // Removed tools absent
    expect(tools).not.toContain('delete_trip');
    expect(tools).not.toContain('delete_place');
    expect(tools).not.toContain('delete_reservation');
    expect(tools).not.toContain('create_budget_item');
    expect(tools).not.toContain('delete_collab_note');
    expect(tools).not.toContain('delete_day_note');
  });
});

describe('Scope enforcement — trips:read only', () => {
  it('SCOPE-002 — trips:read token sees list_trips and get_trip_summary but NOT write tools', async () => {
    const { user } = createUser(testDb);
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['trips:read'], true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, ['trips:read'], TEST_AUDIENCE);

    const { sessionId, status } = await initSession(accessToken);
    expect(status).toBe(200);

    const tools = await listTools(accessToken, sessionId);
    expect(tools).toContain('list_trips');
    expect(tools).toContain('get_trip_summary');
    expect(tools).toContain('list_categories');

    // Write tools absent
    expect(tools).not.toContain('create_trip');
    expect(tools).not.toContain('update_trip');
    expect(tools).not.toContain('create_place');
    expect(tools).not.toContain('search_place');
  });
});

describe('Scope enforcement — trips:write', () => {
  it('SCOPE-003 — trips:write token has trip/day/assignment mutation tools', async () => {
    const { user } = createUser(testDb);
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['trips:write'], true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, ['trips:write'], TEST_AUDIENCE);

    const { sessionId, status } = await initSession(accessToken);
    expect(status).toBe(200);

    const tools = await listTools(accessToken, sessionId);
    expect(tools).toContain('create_trip');
    expect(tools).toContain('update_trip');
    expect(tools).toContain('assign_place_to_day');
    expect(tools).toContain('unassign_place');
    expect(tools).toContain('reorder_day_assignments');
    expect(tools).toContain('update_assignment_time');
    expect(tools).toContain('update_day');

    // budget/packing/reservations not in scope
    expect(tools).not.toContain('create_packing_item');
  });
});

describe('Scope enforcement — places:write', () => {
  it('SCOPE-005 — places:write token has place CRUD tools', async () => {
    const { user } = createUser(testDb);
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['places:write'], true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, ['places:write'], TEST_AUDIENCE);

    const { sessionId } = await initSession(accessToken);
    const tools = await listTools(accessToken, sessionId);
    expect(tools).toContain('create_place');
    expect(tools).toContain('update_place');
    expect(tools).not.toContain('create_trip');
    expect(tools).not.toContain('search_place');
  });
});

describe('Scope enforcement — geo:read', () => {
  it('SCOPE-006 — geo:read token has search_place', async () => {
    const { user } = createUser(testDb);
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['geo:read'], true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, ['geo:read'], TEST_AUDIENCE);

    const { sessionId } = await initSession(accessToken);
    const tools = await listTools(accessToken, sessionId);
    expect(tools).toContain('search_place');
    expect(tools).not.toContain('create_place');
  });
});

describe('Scope enforcement — budget read tools always visible', () => {
  it('SCOPE-007 — budget read tools are present even with no budget scope', async () => {
    const { user } = createUser(testDb);
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['trips:read'], true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, ['trips:read'], TEST_AUDIENCE);

    const { sessionId } = await initSession(accessToken);
    const tools = await listTools(accessToken, sessionId);
    expect(tools).toContain('list_budget_items');
    expect(tools).toContain('get_budget_settlement');
    expect(tools).not.toContain('create_budget_item');
  });
});

describe('Scope enforcement — packing:write', () => {
  it('SCOPE-008 — packing:write token has packing CRUD tools', async () => {
    const { user } = createUser(testDb);
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['packing:write'], true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, ['packing:write'], TEST_AUDIENCE);

    const { sessionId } = await initSession(accessToken);
    const tools = await listTools(accessToken, sessionId);
    expect(tools).toContain('create_packing_item');
    expect(tools).toContain('update_packing_item');
    expect(tools).toContain('toggle_packing_item');
    expect(tools).toContain('delete_packing_item');
    expect(tools).not.toContain('create_budget_item');
  });
});

describe('Scope enforcement — reservations:write', () => {
  it('SCOPE-009 — reservations:write token has reservation CRUD tools', async () => {
    const { user } = createUser(testDb);
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['reservations:write'], true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, ['reservations:write'], TEST_AUDIENCE);

    const { sessionId } = await initSession(accessToken);
    const tools = await listTools(accessToken, sessionId);
    expect(tools).toContain('create_reservation');
    expect(tools).toContain('update_reservation');
    expect(tools).toContain('link_hotel_accommodation');
    expect(tools).not.toContain('create_packing_item');
  });
});

describe('Scope enforcement — collab:write', () => {
  it('SCOPE-010 — collab:write token has collab and day note tools', async () => {
    const { user } = createUser(testDb);
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['collab:write'], true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, ['collab:write'], TEST_AUDIENCE);

    const { sessionId } = await initSession(accessToken);
    const tools = await listTools(accessToken, sessionId);
    expect(tools).toContain('create_collab_note');
    expect(tools).toContain('update_collab_note');
    expect(tools).toContain('create_day_note');
    expect(tools).toContain('update_day_note');
    expect(tools).not.toContain('create_packing_item');
  });
});

describe('Scope enforcement — atlas:write', () => {
  it('SCOPE-011 — atlas:write token has country and bucket list tools', async () => {
    const { user } = createUser(testDb);
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['atlas:write'], true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, ['atlas:write'], TEST_AUDIENCE);

    const { sessionId } = await initSession(accessToken);
    const tools = await listTools(accessToken, sessionId);
    expect(tools).toContain('mark_country_visited');
    expect(tools).toContain('unmark_country_visited');
    expect(tools).toContain('create_bucket_list_item');
    expect(tools).toContain('delete_bucket_list_item');
    expect(tools).not.toContain('create_trip');
  });
});

describe('Scope enforcement — always-registered tools', () => {
  it('SCOPE-012 — empty scopes still get list_trips, get_trip_summary, list_categories', async () => {
    const { user } = createUser(testDb);
    // Issue a token with no scopes at all (intersection with empty allowed_scopes)
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], ['trips:read'], true, 'settings_ui');
    // Override the stored scopes to empty via direct token issuance with empty array
    const { accessToken } = issueTokens(client.client_id, user.id, [], TEST_AUDIENCE);

    const { sessionId, status } = await initSession(accessToken);
    expect(status).toBe(200);

    const tools = await listTools(accessToken, sessionId);
    // Discovery tools always registered regardless of scopes
    expect(tools).toContain('list_trips');
    expect(tools).toContain('get_trip_summary');
    expect(tools).toContain('list_categories');

    // All scope-gated tools absent
    expect(tools).not.toContain('create_trip');
    expect(tools).not.toContain('create_place');
    expect(tools).not.toContain('search_place');
  });

  it('SCOPE-013 — multi-scope token sees union of allowed tools', async () => {
    const { user } = createUser(testDb);
    const scopes = ['trips:write', 'budget:write', 'packing:write'];
    const { client } = createOAuthClient(user.id, 'App', [TEST_REDIRECT], scopes, true, 'settings_ui');
    const { accessToken } = issueTokens(client.client_id, user.id, scopes, TEST_AUDIENCE);

    const { sessionId } = await initSession(accessToken);
    const tools = await listTools(accessToken, sessionId);

    expect(tools).toContain('create_trip');      // trips:write
    expect(tools).toContain('create_packing_item'); // packing:write
    // Not granted
    expect(tools).not.toContain('search_place');  // geo:read not in scopes
    expect(tools).not.toContain('create_reservation'); // reservations:write not in scopes
  });
});
