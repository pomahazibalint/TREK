/**
 * Unit tests for MCP member tools: list_trip_members.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

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

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock('../../../src/websocket', () => ({ broadcast: broadcastMock }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createTrip, addTripMember } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  broadcastMock.mockClear();
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  testDb.close();
});

async function withHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: false });
  try { await fn(h); } finally { await h.cleanup(); }
}

// ---------------------------------------------------------------------------
// list_trip_members
// ---------------------------------------------------------------------------

describe('Tool: list_trip_members', () => {
  it('returns the owner and no members for a solo trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_trip_members', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.owner.id).toBe(user.id);
      expect(data.owner.role).toBe('owner');
      expect(data.members).toHaveLength(0);
    });
  });

  it('includes all members with their usernames and roles', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member1 } = createUser(testDb);
    const { user: member2 } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member1.id);
    addTripMember(testDb, trip.id, member2.id);

    await withHarness(owner.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_trip_members', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.owner.id).toBe(owner.id);
      expect(data.members).toHaveLength(2);
      const memberIds = data.members.map((m: any) => m.id);
      expect(memberIds).toContain(member1.id);
      expect(memberIds).toContain(member2.id);
    });
  });

  it('is accessible to a trip member (not just owner)', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);

    await withHarness(member.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_trip_members', arguments: { tripId: trip.id } });
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result) as any;
      expect(data.owner.id).toBe(owner.id);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_trip_members', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});
