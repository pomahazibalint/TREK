/**
 * Unit tests for fileService — permanentDeleteFile and emptyTrash.
 * Verifies that the unlink-before-delete invariant holds: the DB row is only
 * removed when the on-disk unlink succeeds (or the file never existed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TripFile } from '../../../src/types';

// ─── in-memory DB (must be hoisted so the mock is in place before imports) ───

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

import fs from 'fs';
import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { permanentDeleteFile, emptyTrash } from '../../../src/services/fileService';

// Schema setup (once)
createTables(testDb);
runMigrations(testDb);

// Spies — declared here, initialised in beforeEach
let existsSpy: ReturnType<typeof vi.spyOn>;
let unlinkSpy: ReturnType<typeof vi.spyOn>;

// Helper: insert a minimal trip_files row and return it as a TripFile
let _seq = 0;
function insertFile(tripId: number, filename = `test-${++_seq}.jpg`): TripFile {
  testDb.prepare(
    "INSERT OR IGNORE INTO users (id, username, email, password_hash, role) VALUES (1, 'tester', 'tester@test.example', 'x', 'user')"
  ).run();
  testDb.prepare(
    'INSERT OR IGNORE INTO trips (id, user_id, title) VALUES (?, 1, ?)'
  ).run(tripId, `Trip ${tripId}`);
  const result = testDb.prepare(
    "INSERT INTO trip_files (trip_id, filename, original_name, file_size, mime_type, uploaded_by, deleted_at) VALUES (?, ?, ?, 100, 'image/jpeg', 1, CURRENT_TIMESTAMP)"
  ).run(tripId, filename, filename);
  return testDb.prepare('SELECT * FROM trip_files WHERE id = ?').get(result.lastInsertRowid) as TripFile;
}

beforeEach(() => {
  existsSpy = vi.spyOn(fs, 'existsSync');
  unlinkSpy = vi.spyOn(fs, 'unlinkSync');
  testDb.exec('DELETE FROM trip_files');
  testDb.exec('DELETE FROM trips');
});

// ─────────────────────────────────────────────────────────────────────────────
// permanentDeleteFile
// ─────────────────────────────────────────────────────────────────────────────

describe('permanentDeleteFile', () => {
  it('unlinks the file and deletes the DB row when unlink succeeds', () => {
    const file = insertFile(1);
    existsSpy.mockReturnValue(true);
    unlinkSpy.mockImplementation(() => {});

    permanentDeleteFile(file);

    expect(unlinkSpy).toHaveBeenCalledOnce();
    const row = testDb.prepare('SELECT id FROM trip_files WHERE id = ?').get(file.id);
    expect(row).toBeUndefined();
  });

  it('does NOT delete the DB row when unlinkSync throws', () => {
    const file = insertFile(1);
    existsSpy.mockReturnValue(true);
    unlinkSpy.mockImplementation(() => { throw new Error('EPERM'); });

    permanentDeleteFile(file);

    const row = testDb.prepare('SELECT id FROM trip_files WHERE id = ?').get(file.id);
    expect(row).toBeDefined();
  });

  it('deletes the DB row without calling unlinkSync when file does not exist on disk', () => {
    const file = insertFile(1);
    existsSpy.mockReturnValue(false);

    permanentDeleteFile(file);

    expect(unlinkSpy).not.toHaveBeenCalled();
    const row = testDb.prepare('SELECT id FROM trip_files WHERE id = ?').get(file.id);
    expect(row).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// emptyTrash
// ─────────────────────────────────────────────────────────────────────────────

describe('emptyTrash', () => {
  it('returns the count of successfully deleted files', () => {
    insertFile(2, 'a.jpg');
    insertFile(2, 'b.jpg');
    existsSpy.mockReturnValue(true);
    unlinkSpy.mockImplementation(() => {});

    const count = emptyTrash(2);
    expect(count).toBe(2);
  });

  it('removes DB rows only for files whose unlink succeeded', () => {
    const good = insertFile(3, 'good.jpg');
    const bad = insertFile(3, 'bad.jpg');

    existsSpy.mockReturnValue(true);
    unlinkSpy.mockImplementation((p: fs.PathLike) => {
      if (String(p).includes('bad.jpg')) throw new Error('EPERM');
    });

    const count = emptyTrash(3);
    expect(count).toBe(1);

    const goodRow = testDb.prepare('SELECT id FROM trip_files WHERE id = ?').get(good.id);
    const badRow = testDb.prepare('SELECT id FROM trip_files WHERE id = ?').get(bad.id);
    expect(goodRow).toBeUndefined();
    expect(badRow).toBeDefined();
  });

  it('returns 0 and leaves DB untouched when all unlinks fail', () => {
    insertFile(4, 'fail1.jpg');
    insertFile(4, 'fail2.jpg');
    existsSpy.mockReturnValue(true);
    unlinkSpy.mockImplementation(() => { throw new Error('EPERM'); });

    const count = emptyTrash(4);
    expect(count).toBe(0);

    const rows = testDb.prepare('SELECT id FROM trip_files WHERE trip_id = 4').all();
    expect(rows.length).toBe(2);
  });

  it('returns 0 when the trash is empty', () => {
    // user first, then trip (FK order)
    testDb.prepare("INSERT OR IGNORE INTO users (id, username, email, password_hash, role) VALUES (1, 'tester', 'tester@test.example', 'x', 'user')").run();
    testDb.prepare("INSERT OR IGNORE INTO trips (id, user_id, title) VALUES (5, 1, 'T5')").run();
    testDb.prepare(
      "INSERT INTO trip_files (trip_id, filename, original_name, file_size, mime_type, uploaded_by, deleted_at) VALUES (5, 'live.jpg', 'live.jpg', 100, 'image/jpeg', 1, NULL)"
    ).run();

    const count = emptyTrash(5);
    expect(count).toBe(0);
    expect(unlinkSpy).not.toHaveBeenCalled();
  });
});
