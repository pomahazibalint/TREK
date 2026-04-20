import cron, { type ScheduledTask } from 'node-cron';
import archiver from 'archiver';
import path from 'node:path';
import fs from 'node:fs';

const dataDir = path.join(__dirname, '../data');
const backupsDir = path.join(dataDir, 'backups');
const uploadsDir = path.join(__dirname, '../uploads');
const settingsFile = path.join(dataDir, 'backup-settings.json');

const VALID_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly'];
const VALID_DAYS_OF_WEEK = new Set([0, 1, 2, 3, 4, 5, 6]); // 0=Sunday
const VALID_HOURS = new Set(Array.from({length: 24}, (_, i) => i));

interface BackupSettings {
  enabled: boolean;
  interval: string;
  keep_days: number;
  hour: number;
  day_of_week: number;
  day_of_month: number;
}

export function buildCronExpression(settings: BackupSettings): string {
  const hour = VALID_HOURS.has(settings.hour) ? settings.hour : 2;
  const dow = VALID_DAYS_OF_WEEK.has(settings.day_of_week) ? settings.day_of_week : 0;
  const dom = settings.day_of_month >= 1 && settings.day_of_month <= 28 ? settings.day_of_month : 1;

  switch (settings.interval) {
    case 'hourly':  return '0 * * * *';
    case 'daily':   return `0 ${hour} * * *`;
    case 'weekly':  return `0 ${hour} * * ${dow}`;
    case 'monthly': return `0 ${hour} ${dom} * *`;
    default:        return `0 ${hour} * * *`;
  }
}

let currentTask: ScheduledTask | null = null;

function getDefaults(): BackupSettings {
  return { enabled: false, interval: 'daily', keep_days: 7, hour: 2, day_of_week: 0, day_of_month: 1 };
}

function loadSettings(): BackupSettings {
  let settings = getDefaults();
  try {
    if (fs.existsSync(settingsFile)) {
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      settings = { ...settings, ...saved };
    }
  } catch (e) {}
  return settings;
}

function saveSettings(settings: BackupSettings): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

async function runBackup(): Promise<void> {
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `auto-backup-${timestamp}.zip`;
  const outputPath = path.join(backupsDir, filename);

  try {
    // Flush WAL to main DB file before archiving
    try { const { db } = require('./db/database'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      const dbPath = path.join(dataDir, 'travel.db');
      if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'travel.db' });
      if (fs.existsSync(uploadsDir)) archive.directory(uploadsDir, 'uploads');
      archive.finalize();
    });
    const { logInfo: li } = require('./services/auditLog');
    li(`Auto-Backup created: ${filename}`);
  } catch (err: unknown) {
    const { logError: le } = require('./services/auditLog');
    le(`Auto-Backup: ${err instanceof Error ? err.message : err}`);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return;
  }

  const settings = loadSettings();
  if (settings.keep_days > 0) {
    cleanupOldBackups(settings.keep_days);
  }
}

function cleanupOldBackups(keepDays: number): void {
  try {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - keepDays * MS_PER_DAY;
    const files = fs.readdirSync(backupsDir).filter(f => f.endsWith('.zip'));
    for (const file of files) {
      const filePath = path.join(backupsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.birthtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        const { logInfo: li } = require('./services/auditLog');
        li(`Auto-Backup old backup deleted: ${file}`);
      }
    }
  } catch (err: unknown) {
    const { logError: le } = require('./services/auditLog');
    le(`Auto-Backup cleanup: ${err instanceof Error ? err.message : err}`);
  }
}

function start(): void {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  const settings = loadSettings();
  if (!settings.enabled) {
    const { logInfo: li } = require('./services/auditLog');
    li('Auto-Backup disabled');
    return;
  }

  const expression = buildCronExpression(settings);
  const tz = process.env.TZ || 'UTC';
  currentTask = cron.schedule(expression, runBackup, { timezone: tz });
  const { logInfo: li2 } = require('./services/auditLog');
  li2(`Auto-Backup scheduled: ${settings.interval} (${expression}), tz: ${tz}, retention: ${settings.keep_days === 0 ? 'forever' : settings.keep_days + ' days'}`);
}

// Demo mode: hourly reset of demo user data
let demoTask: ScheduledTask | null = null;

function startDemoReset(): void {
  if (demoTask) { demoTask.stop(); demoTask = null; }
  if (process.env.DEMO_MODE !== 'true') return;

  demoTask = cron.schedule('0 * * * *', () => {
    try {
      const { resetDemoUser } = require('./demo/demo-reset');
      resetDemoUser();
    } catch (err: unknown) {
      const { logError: le } = require('./services/auditLog');
      le(`Demo reset: ${err instanceof Error ? err.message : err}`);
    }
  });
  const { logInfo: li3 } = require('./services/auditLog');
  li3('Demo hourly reset scheduled');
}

// Trip reminders: daily check at 9 AM local time for trips starting tomorrow
let reminderTask: ScheduledTask | null = null;

function startTripReminders(): void {
  if (reminderTask) { reminderTask.stop(); reminderTask = null; }

  try {
    const { db } = require('./db/database');
    const getSetting = (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const reminderEnabled = getSetting('notify_trip_reminder') !== 'false';
    const channelsRaw = getSetting('notification_channels') || getSetting('notification_channel') || 'none';
    const activeChannels = channelsRaw === 'none' ? [] : channelsRaw.split(',').map((c: string) => c.trim());
    const hasEmail = activeChannels.includes('email') && !!(getSetting('smtp_host') || '').trim();
    const hasWebhook = activeChannels.includes('webhook');
    const channelReady = hasEmail || hasWebhook;

    if (!channelReady || !reminderEnabled) {
      const { logInfo: li } = require('./services/auditLog');
      const reason = !channelReady ? 'no notification channels configured' : 'trip reminders disabled in settings';
      li(`Trip reminders: disabled (${reason})`);
      return;
    }

    const tripCount = (db.prepare('SELECT COUNT(*) as c FROM trips WHERE reminder_days > 0 AND start_date IS NOT NULL').get() as { c: number }).c;
    const { logInfo: liSetup } = require('./services/auditLog');
    liSetup(`Trip reminders: enabled via [${activeChannels.join(',')}]${tripCount > 0 ? `, ${tripCount} trip(s) with active reminders` : ''}`);
  } catch {
    return;
  }

  const tz = process.env.TZ || 'UTC';
  reminderTask = cron.schedule('0 9 * * *', async () => {
    try {
      const { db } = require('./db/database');
      const { send } = require('./services/notificationService');

      const trips = db.prepare(`
        SELECT t.id, t.title, t.user_id, t.reminder_days FROM trips t
        WHERE t.reminder_days > 0
          AND t.start_date IS NOT NULL
          AND t.start_date = date('now', '+' || t.reminder_days || ' days')
      `).all() as { id: number; title: string; user_id: number; reminder_days: number }[];

      for (const trip of trips) {
        await send({ event: 'trip_reminder', actorId: null, scope: 'trip', targetId: trip.id, params: { trip: trip.title, tripId: String(trip.id) } }).catch(() => {});
      }

      const { logInfo: li } = require('./services/auditLog');
      if (trips.length > 0) {
        li(`Trip reminders sent for ${trips.length} trip(s): ${trips.map(t => `"${t.title}" (${t.reminder_days}d)`).join(', ')}`);
      }
    } catch (err: unknown) {
      const { logError: le } = require('./services/auditLog');
      le(`Trip reminder check failed: ${err instanceof Error ? err.message : err}`);
    }
  }, { timezone: tz });
}

// Version check: daily at 9 AM — notify admins if a new TREK release is available
let versionCheckTask: ScheduledTask | null = null;

function startVersionCheck(): void {
  if (versionCheckTask) { versionCheckTask.stop(); versionCheckTask = null; }

  const tz = process.env.TZ || 'UTC';
  versionCheckTask = cron.schedule('0 9 * * *', async () => {
    try {
      const { checkAndNotifyVersion } = require('./services/adminService');
      await checkAndNotifyVersion();
    } catch (err: unknown) {
      const { logError: le } = require('./services/auditLog');
      le(`Version check: ${err instanceof Error ? err.message : err}`);
    }
  }, { timezone: tz });
}

// Auto photo sync: every 6 hours for all album/date-range links with auto_sync enabled
let autoPhotoSyncTask: ScheduledTask | null = null;

function startAutoPhotoSync(): void {
  if (autoPhotoSyncTask) { autoPhotoSyncTask.stop(); autoPhotoSyncTask = null; }

  const tz = process.env.TZ || 'UTC';
  autoPhotoSyncTask = cron.schedule('0 */6 * * *', async () => {
    try {
      const { db } = require('./db/database');
      const links = db.prepare(`
        SELECT id, trip_id, user_id, provider, sync_type, sync_from_date, sync_to_date
        FROM trip_album_links
        WHERE auto_sync = 1
      `).all() as { id: number; trip_id: number; user_id: number; provider: string; sync_type: string; sync_from_date: string | null; sync_to_date: string | null }[];

      let synced = 0;
      for (const link of links) {
        try {
          if (link.provider === 'immich') {
            const { syncAlbumAssets: saa, syncDateRangePhotos: sdr } = require('./services/memories/immichService');
            if (link.sync_type === 'date_range' && link.sync_from_date && link.sync_to_date) {
              await sdr(String(link.trip_id), String(link.id), link.user_id, link.sync_from_date, link.sync_to_date, '');
            } else {
              await saa(String(link.trip_id), String(link.id), link.user_id, '');
            }
            synced++;
          }
        } catch (err: unknown) {
          const { logError: le } = require('./services/auditLog');
          le(`Auto Photo Sync link ${link.id}: ${err instanceof Error ? err.message : err}`);
        }
      }

      if (synced > 0) {
        const { logInfo: li } = require('./services/auditLog');
        li(`Auto Photo Sync: synced ${synced} link(s)`);
      }
    } catch (err: unknown) {
      const { logError: le } = require('./services/auditLog');
      le(`Auto Photo Sync: ${err instanceof Error ? err.message : err}`);
    }
  }, { timezone: tz });

  const { logInfo: li } = require('./services/auditLog');
  li('Auto Photo Sync scheduled: every 6 hours');
}

// Auto-archive: nightly at 3 AM — archive trips ended more than N days ago
let autoArchiveTask: ScheduledTask | null = null;

function startAutoArchive(): void {
  if (autoArchiveTask) { autoArchiveTask.stop(); autoArchiveTask = null; }

  const tz = process.env.TZ || 'UTC';
  autoArchiveTask = cron.schedule('0 3 * * *', () => {
    try {
      const { db } = require('./db/database');
      const { logInfo: li } = require('./services/auditLog');
      const days = parseInt((db.prepare("SELECT value FROM app_settings WHERE key = 'auto_archive_days'").get() as { value: string } | undefined)?.value ?? '60', 10);
      if (!days || days <= 0) return;
      const result = db.prepare(`
        UPDATE trips SET is_archived = 1
        WHERE is_archived = 0
          AND end_date IS NOT NULL
          AND end_date < date('now', '-' || ? || ' days')
      `).run(days);
      if (result.changes > 0) li(`Auto-archive: archived ${result.changes} trip(s) older than ${days} days`);
    } catch (err: unknown) {
      const { logError: le } = require('./services/auditLog');
      le(`Auto-archive: ${err instanceof Error ? err.message : err}`);
    }
  }, { timezone: tz });
}

function stop(): void {
  if (currentTask) { currentTask.stop(); currentTask = null; }
  if (demoTask) { demoTask.stop(); demoTask = null; }
  if (reminderTask) { reminderTask.stop(); reminderTask = null; }
  if (versionCheckTask) { versionCheckTask.stop(); versionCheckTask = null; }
  if (autoPhotoSyncTask) { autoPhotoSyncTask.stop(); autoPhotoSyncTask = null; }
  if (autoArchiveTask) { autoArchiveTask.stop(); autoArchiveTask = null; }
}

export { start, stop, startDemoReset, startTripReminders, startVersionCheck, startAutoPhotoSync, startAutoArchive, loadSettings, saveSettings, VALID_INTERVALS };
