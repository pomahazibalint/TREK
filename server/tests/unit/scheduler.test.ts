import { describe, it, expect, vi } from 'vitest';

// Prevent node-cron from scheduling anything at import time
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(), validate: vi.fn(() => true) },
  schedule: vi.fn(),
  validate: vi.fn(() => true),
}));
// Prevent archiver from causing side effects
vi.mock('archiver', () => ({ default: vi.fn() }));
// Prevent fs side effects (creating directories, reading files)
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ mtime: new Date(), mtimeMs: Date.now(), size: 0 })),
    unlinkSync: vi.fn(),
    createWriteStream: vi.fn(() => ({ on: vi.fn(), pipe: vi.fn() })),
  },
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtime: new Date(), mtimeMs: Date.now(), size: 0 })),
  unlinkSync: vi.fn(),
  createWriteStream: vi.fn(() => ({ on: vi.fn(), pipe: vi.fn() })),
}));
vi.mock('../../../src/db/database', () => ({
  db: { prepare: () => ({ all: vi.fn(() => []), get: vi.fn(), run: vi.fn() }) },
}));
vi.mock('../../../src/config', () => ({ JWT_SECRET: 'test-secret', ENCRYPTION_KEY: '0'.repeat(64) }));
import { buildCronExpression, parseAutoBackupTimestamp } from '../../src/scheduler';

interface BackupSettings {
  enabled: boolean;
  interval: string;
  keep_days: number;
  hour: number;
  day_of_week: number;
  day_of_month: number;
}

function settings(overrides: Partial<BackupSettings> = {}): BackupSettings {
  return {
    enabled: true,
    interval: 'daily',
    keep_days: 7,
    hour: 2,
    day_of_week: 0,
    day_of_month: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseAutoBackupTimestamp — retention logic
// ---------------------------------------------------------------------------

describe('parseAutoBackupTimestamp', () => {
  function makeFilename(daysAgo: number): string {
    const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const ts = d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `auto-backup-${ts}.zip`;
  }

  it('parses a well-formed auto-backup filename into a UTC millisecond timestamp', () => {
    const ts = parseAutoBackupTimestamp('auto-backup-2024-04-28T12-30-00.zip');
    expect(ts).toBe(new Date('2024-04-28T12:30:00Z').getTime());
  });

  it('returns a timestamp in the past for an old filename', () => {
    const file = makeFilename(10);
    const ts = parseAutoBackupTimestamp(file);
    expect(ts).not.toBeNull();
    expect(ts!).toBeLessThan(Date.now() - 9 * 24 * 60 * 60 * 1000);
  });

  it('returns a timestamp in the recent past for a fresh filename', () => {
    const file = makeFilename(1);
    const ts = parseAutoBackupTimestamp(file);
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThan(Date.now() - 2 * 24 * 60 * 60 * 1000);
  });

  it('returns null for a manual backup filename (no auto-backup prefix)', () => {
    expect(parseAutoBackupTimestamp('manual-backup-2024-04-28T12-30-00.zip')).toBeNull();
  });

  it('returns null for an auto-backup with an unparseable timestamp section', () => {
    expect(parseAutoBackupTimestamp('auto-backup-unknown.zip')).toBeNull();
  });

  it('returns null for a plain .zip with no recognisable pattern', () => {
    expect(parseAutoBackupTimestamp('data-export.zip')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildCronExpression
// ---------------------------------------------------------------------------

describe('buildCronExpression', () => {
  describe('hourly', () => {
    it('returns 0 * * * * regardless of hour/dow/dom', () => {
      expect(buildCronExpression(settings({ interval: 'hourly', hour: 5, day_of_week: 3, day_of_month: 15 }))).toBe('0 * * * *');
    });
  });

  describe('daily', () => {
    it('returns 0 <hour> * * *', () => {
      expect(buildCronExpression(settings({ interval: 'daily', hour: 3 }))).toBe('0 3 * * *');
    });

    it('handles midnight (hour 0)', () => {
      expect(buildCronExpression(settings({ interval: 'daily', hour: 0 }))).toBe('0 0 * * *');
    });

    it('handles last valid hour (23)', () => {
      expect(buildCronExpression(settings({ interval: 'daily', hour: 23 }))).toBe('0 23 * * *');
    });

    it('falls back to hour 2 for invalid hour (24)', () => {
      expect(buildCronExpression(settings({ interval: 'daily', hour: 24 }))).toBe('0 2 * * *');
    });

    it('falls back to hour 2 for negative hour', () => {
      expect(buildCronExpression(settings({ interval: 'daily', hour: -1 }))).toBe('0 2 * * *');
    });
  });

  describe('weekly', () => {
    it('returns 0 <hour> * * <dow>', () => {
      expect(buildCronExpression(settings({ interval: 'weekly', hour: 5, day_of_week: 3 }))).toBe('0 5 * * 3');
    });

    it('handles Sunday (dow 0)', () => {
      expect(buildCronExpression(settings({ interval: 'weekly', hour: 2, day_of_week: 0 }))).toBe('0 2 * * 0');
    });

    it('handles Saturday (dow 6)', () => {
      expect(buildCronExpression(settings({ interval: 'weekly', hour: 2, day_of_week: 6 }))).toBe('0 2 * * 6');
    });

    it('falls back to dow 0 for invalid day_of_week (7)', () => {
      expect(buildCronExpression(settings({ interval: 'weekly', hour: 2, day_of_week: 7 }))).toBe('0 2 * * 0');
    });
  });

  describe('monthly', () => {
    it('returns 0 <hour> <dom> * *', () => {
      expect(buildCronExpression(settings({ interval: 'monthly', hour: 2, day_of_month: 15 }))).toBe('0 2 15 * *');
    });

    it('handles day_of_month 1', () => {
      expect(buildCronExpression(settings({ interval: 'monthly', hour: 2, day_of_month: 1 }))).toBe('0 2 1 * *');
    });

    it('handles max valid day_of_month (28)', () => {
      expect(buildCronExpression(settings({ interval: 'monthly', hour: 2, day_of_month: 28 }))).toBe('0 2 28 * *');
    });

    it('falls back to dom 1 for day_of_month 29', () => {
      expect(buildCronExpression(settings({ interval: 'monthly', hour: 2, day_of_month: 29 }))).toBe('0 2 1 * *');
    });

    it('falls back to dom 1 for day_of_month 0', () => {
      expect(buildCronExpression(settings({ interval: 'monthly', hour: 2, day_of_month: 0 }))).toBe('0 2 1 * *');
    });
  });

  describe('unknown interval', () => {
    it('defaults to daily pattern', () => {
      expect(buildCronExpression(settings({ interval: 'unknown', hour: 4 }))).toBe('0 4 * * *');
    });
  });
});
