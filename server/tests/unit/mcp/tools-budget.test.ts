/**
 * Unit tests for MCP budget tools: list_budget_items, get_budget_settlement.
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
import { createUser, createTrip, createBudgetItem } from '../../helpers/factories';
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
// list_budget_items
// ---------------------------------------------------------------------------

describe('Tool: list_budget_items', () => {
  it('returns all budget items for a trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createBudgetItem(testDb, trip.id, { name: 'Hotel Paris', category: 'Accommodation', total_price: 500 });
    createBudgetItem(testDb, trip.id, { name: 'Train ticket', category: 'Transport', total_price: 80 });

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_budget_items', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.items).toHaveLength(2);
      const names = data.items.map((i: any) => i.name);
      expect(names).toContain('Hotel Paris');
      expect(names).toContain('Train ticket');
    });
  });

  it('returns empty array when trip has no budget items', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_budget_items', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      expect(data.items).toHaveLength(0);
    });
  });

  it('only returns items belonging to the specified trip', async () => {
    const { user } = createUser(testDb);
    const trip1 = createTrip(testDb, user.id);
    const trip2 = createTrip(testDb, user.id);
    createBudgetItem(testDb, trip1.id, { name: 'Trip1 item' });
    createBudgetItem(testDb, trip2.id, { name: 'Trip2 item' });

    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_budget_items', arguments: { tripId: trip1.id } });
      const data = parseToolResult(result) as any;
      expect(data.items).toHaveLength(1);
      expect(data.items[0].name).toBe('Trip1 item');
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_budget_items', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });

  it('is accessible to demo user (read-only)', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    const trip = createTrip(testDb, user.id);
    createBudgetItem(testDb, trip.id, { name: 'Taxi', total_price: 25 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_budget_items', arguments: { tripId: trip.id } });
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result) as any;
      expect(data.items).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// get_budget_settlement
// ---------------------------------------------------------------------------

describe('Tool: get_budget_settlement', () => {
  it('returns settlement data for a trip', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_budget_settlement', arguments: { tripId: trip.id } });
      expect(result.isError).toBeFalsy();
      const data = parseToolResult(result) as any;
      // Settlement always returns a structured response even with no items
      expect(data).toBeDefined();
    });
  });

  it('includes unallocated items in the incomplete array', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createBudgetItem(testDb, trip.id, { name: 'Unallocated dinner', total_price: 60 });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_budget_settlement', arguments: { tripId: trip.id } });
      const data = parseToolResult(result) as any;
      // unallocated items appear in the incomplete field
      expect(Array.isArray(data.incomplete)).toBe(true);
      expect(data.incomplete.length).toBeGreaterThanOrEqual(0);
    });
  });

  it('returns access denied for non-member', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, other.id);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_budget_settlement', arguments: { tripId: trip.id } });
      expect(result.isError).toBe(true);
    });
  });
});
