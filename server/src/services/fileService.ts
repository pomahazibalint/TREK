import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { db, canAccessTrip } from '../db/database';
import { consumeEphemeralToken } from './ephemeralTokens';
import { TripFile } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_ALLOWED_EXTENSIONS = 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv,pass';

// Blocked extensions: executables, scripts, archives, and dangerous formats
export const BLOCKED_EXTENSIONS = [
  '.svg', '.html', '.htm', '.xml', '.js', '.ts', '.jsx', '.tsx',
  '.exe', '.bat', '.cmd', '.ps1', '.com', '.scr', '.vbs', '.pif',
  '.dll', '.sys', '.drv', '.ocx',
  '.zip', '.rar', '.7z', '.iso', '.dmg', '.pkg',
  '.jar', '.class', '.pyc', '.pyo', '.rb', '.sh', '.bash',
];

// MIME types allowed for upload (image, document, archive safe for viewing)
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv', 'text/csv; charset=utf-8',
  'application/vnd.apple.pkpass',
]);

export const filesDir = path.join(__dirname, '../../uploads/files');

// Magic byte signatures for file type verification
const MAGIC_BYTES: Record<string, Buffer[]> = {
  'image/jpeg': [Buffer.from([0xFF, 0xD8, 0xFF])],
  'image/png': [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  'image/gif': [Buffer.from([0x47, 0x49, 0x46, 0x38])], // GIF87a or GIF89a
  'image/webp': [Buffer.from([0x52, 0x49, 0x46, 0x46])], // RIFF (must verify WEBP signature)
  'application/pdf': [Buffer.from([0x25, 0x50, 0x44, 0x46])], // %PDF
  'application/vnd.apple.pkpass': [Buffer.from([0x50, 0x4B, 0x03, 0x04])], // ZIP (PK)
  'text/plain': [], // No specific magic bytes for text
  'text/csv': [], // No specific magic bytes for CSV
};

// ---------------------------------------------------------------------------
// File Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Verify file magic bytes (header signature) match the claimed MIME type.
 * Returns true if file header matches expected signature, false otherwise.
 */
export function verifyFileMagicBytes(buffer: Buffer, mimeType: string): boolean {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures || signatures.length === 0) {
    // Text files have no magic bytes; allow if MIME type is text-based
    return mimeType.startsWith('text/');
  }

  return signatures.some(sig => buffer.subarray(0, sig.length).equals(sig));
}

/**
 * Check if a MIME type is in the allowed list.
 */
export function isAllowedMimeType(mimeType: string): boolean {
  // Handle charset variants (e.g., "text/csv; charset=utf-8")
  const baseMimeType = mimeType.split(';')[0].trim();
  return ALLOWED_MIME_TYPES.has(baseMimeType);
}

/**
 * Validate a file for upload: check extension, MIME type, and magic bytes.
 * Returns { valid: true } or { valid: false, reason: string }
 */
export function validateFileUpload(
  filename: string,
  mimeType: string,
  buffer?: Buffer
): { valid: true } | { valid: false; reason: string } {
  const ext = path.extname(filename).toLowerCase();

  // Check blocked extensions
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    return { valid: false, reason: `File type "${ext}" is not allowed` };
  }

  // Check against allowed MIME types
  if (!isAllowedMimeType(mimeType)) {
    return { valid: false, reason: 'File MIME type is not allowed' };
  }

  // Verify magic bytes for binary formats if buffer is provided
  if (buffer && buffer.length > 0) {
    if (mimeType.startsWith('image/') || mimeType === 'application/pdf' || mimeType === 'application/vnd.apple.pkpass') {
      if (!verifyFileMagicBytes(buffer, mimeType)) {
        return { valid: false, reason: 'File content does not match declared type' };
      }
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function verifyTripAccess(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

export function getAllowedExtensions(): string {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get() as { value: string } | undefined;
    return row?.value || DEFAULT_ALLOWED_EXTENSIONS;
  } catch { return DEFAULT_ALLOWED_EXTENSIONS; }
}

const FILE_SELECT = `
  SELECT f.*, r.title as reservation_title, u.username as uploaded_by_name, u.avatar as uploaded_by_avatar
  FROM trip_files f
  LEFT JOIN reservations r ON f.reservation_id = r.id
  LEFT JOIN users u ON f.uploaded_by = u.id
`;

export function formatFile(file: TripFile & { trip_id?: number }) {
  const tripId = file.trip_id;
  return {
    ...file,
    url: `/api/trips/${tripId}/files/${file.id}/download`,
    uploaded_by_avatar: file.uploaded_by_avatar ? `/uploads/avatars/${file.uploaded_by_avatar}` : null,
  };
}

// ---------------------------------------------------------------------------
// File path resolution & validation
// ---------------------------------------------------------------------------

export function resolveFilePath(filename: string): { resolved: string; safe: boolean } {
  const safeName = path.basename(filename);
  const filePath = path.join(filesDir, safeName);
  const resolved = path.resolve(filePath);
  const safe = resolved.startsWith(path.resolve(filesDir));
  return { resolved, safe };
}

// ---------------------------------------------------------------------------
// Token-based download auth
// ---------------------------------------------------------------------------

export function authenticateDownload(bearerToken: string | undefined, queryToken: string | undefined): { userId: number } | { error: string; status: number } {
  if (!bearerToken && !queryToken) {
    return { error: 'Authentication required', status: 401 };
  }

  if (bearerToken) {
    try {
      const decoded = jwt.verify(bearerToken, JWT_SECRET, { algorithms: ['HS256'] }) as { id: number };
      return { userId: decoded.id };
    } catch {
      return { error: 'Invalid or expired token', status: 401 };
    }
  }

  const uid = consumeEphemeralToken(queryToken!, 'download');
  if (!uid) return { error: 'Invalid or expired token', status: 401 };
  return { userId: uid };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface FileLink {
  file_id: number;
  reservation_id: number | null;
  place_id: number | null;
}

export function getFileById(id: string | number, tripId: string | number): TripFile | undefined {
  return db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId) as TripFile | undefined;
}

export function getFileByIdFull(id: string | number): TripFile {
  return db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
}

export function getDeletedFile(id: string | number, tripId: string | number): TripFile | undefined {
  return db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ? AND deleted_at IS NOT NULL').get(id, tripId) as TripFile | undefined;
}

export function listFiles(tripId: string | number, showTrash: boolean) {
  const where = showTrash ? 'f.trip_id = ? AND f.deleted_at IS NOT NULL' : 'f.trip_id = ? AND f.deleted_at IS NULL';
  const files = db.prepare(`${FILE_SELECT} WHERE ${where} ORDER BY f.starred DESC, f.created_at DESC`).all(tripId) as TripFile[];

  const fileIds = files.map(f => f.id);
  let linksMap: Record<number, FileLink[]> = {};
  if (fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(',');
    const links = db.prepare(`SELECT file_id, reservation_id, place_id FROM file_links WHERE file_id IN (${placeholders})`).all(...fileIds) as FileLink[];
    for (const link of links) {
      if (!linksMap[link.file_id]) linksMap[link.file_id] = [];
      linksMap[link.file_id].push(link);
    }
  }

  return files.map(f => {
    const fileLinks = linksMap[f.id] || [];
    return {
      ...formatFile(f),
      linked_reservation_ids: fileLinks.filter(l => l.reservation_id).map(l => l.reservation_id),
      linked_place_ids: fileLinks.filter(l => l.place_id).map(l => l.place_id),
    };
  });
}

export function createFile(
  tripId: string | number,
  file: { filename: string; originalname: string; size: number; mimetype: string },
  uploadedBy: number,
  opts: { place_id?: string | null; reservation_id?: string | null; description?: string | null }
) {
  const result = db.prepare(`
    INSERT INTO trip_files (trip_id, place_id, reservation_id, filename, original_name, file_size, mime_type, description, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId,
    opts.place_id || null,
    opts.reservation_id || null,
    file.filename,
    file.originalname,
    file.size,
    file.mimetype,
    opts.description || null,
    uploadedBy
  );

  const created = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(result.lastInsertRowid) as TripFile;
  return formatFile(created);
}

export function updateFile(
  id: string | number,
  current: TripFile,
  updates: { description?: string; place_id?: string | null; reservation_id?: string | null }
) {
  db.prepare(`
    UPDATE trip_files SET
      description = ?,
      place_id = ?,
      reservation_id = ?
    WHERE id = ?
  `).run(
    updates.description !== undefined ? updates.description : current.description,
    updates.place_id !== undefined ? (updates.place_id || null) : current.place_id,
    updates.reservation_id !== undefined ? (updates.reservation_id || null) : current.reservation_id,
    id
  );

  const updated = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
  return formatFile(updated);
}

export function toggleStarred(id: string | number, currentStarred: number | undefined) {
  const newStarred = currentStarred ? 0 : 1;
  db.prepare('UPDATE trip_files SET starred = ? WHERE id = ?').run(newStarred, id);

  const updated = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
  return formatFile(updated);
}

export function softDeleteFile(id: string | number) {
  db.prepare('UPDATE trip_files SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

export function restoreFile(id: string | number) {
  db.prepare('UPDATE trip_files SET deleted_at = NULL WHERE id = ?').run(id);
  const restored = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as TripFile;
  return formatFile(restored);
}

export function permanentDeleteFile(file: TripFile) {
  const { resolved } = resolveFilePath(file.filename);
  let unlinkOk = true;
  if (fs.existsSync(resolved)) {
    try { fs.unlinkSync(resolved); }
    catch (e) { console.error('Error deleting file:', e); unlinkOk = false; }
  }
  // Only remove the DB row when the on-disk unlink succeeded (or the file
  // didn't exist). Swallowing unlink failures and deleting unconditionally
  // would orphan bytes on disk with no way to recover them.
  if (unlinkOk) db.prepare('DELETE FROM trip_files WHERE id = ?').run(file.id);
}

export function emptyTrash(tripId: string | number): number {
  const trashed = db.prepare('SELECT * FROM trip_files WHERE trip_id = ? AND deleted_at IS NOT NULL').all(tripId) as TripFile[];
  const deleted: number[] = [];
  for (const file of trashed) {
    const { resolved } = resolveFilePath(file.filename);
    let unlinkOk = true;
    if (fs.existsSync(resolved)) {
      try { fs.unlinkSync(resolved); }
      catch (e) { console.error('Error deleting file:', e); unlinkOk = false; }
    }
    if (unlinkOk) deleted.push(file.id);
  }
  if (deleted.length > 0) {
    const ph = deleted.map(() => '?').join(',');
    db.prepare(`DELETE FROM trip_files WHERE id IN (${ph})`).run(...deleted);
  }
  return deleted.length;
}

// ---------------------------------------------------------------------------
// File links (many-to-many)
// ---------------------------------------------------------------------------

export function createFileLink(
  fileId: string | number,
  opts: { reservation_id?: string | null; assignment_id?: string | null; place_id?: string | null; budget_item_id?: string | null }
) {
  try {
    db.prepare('INSERT OR IGNORE INTO file_links (file_id, reservation_id, assignment_id, place_id, budget_item_id) VALUES (?, ?, ?, ?, ?)').run(
      fileId, opts.reservation_id || null, opts.assignment_id || null, opts.place_id || null, opts.budget_item_id || null
    );
  } catch (err) {
    console.error('[Files] Error creating file link:', err instanceof Error ? err.message : err);
  }
  return db.prepare('SELECT * FROM file_links WHERE file_id = ?').all(fileId);
}

export function listFilesForBudgetItem(budgetItemId: string | number) {
  return db.prepare(`${FILE_SELECT} WHERE f.deleted_at IS NULL AND EXISTS (SELECT 1 FROM file_links fl WHERE fl.file_id = f.id AND fl.budget_item_id = ?) ORDER BY f.created_at DESC`).all(budgetItemId).map(formatFile);
}

export function deleteFileLink(linkId: string | number, fileId: string | number) {
  db.prepare('DELETE FROM file_links WHERE id = ? AND file_id = ?').run(linkId, fileId);
}

export function getFileLinks(fileId: string | number) {
  return db.prepare(`
    SELECT fl.*, r.title as reservation_title
    FROM file_links fl
    LEFT JOIN reservations r ON fl.reservation_id = r.id
    WHERE fl.file_id = ?
  `).all(fileId);
}
