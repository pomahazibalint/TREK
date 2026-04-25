import { Request, Response, NextFunction } from 'express';
import { db } from '../db/database';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_KEY_LENGTH = 128;
const MAX_CACHED_BODY_BYTES = 256 * 1024;

interface IdempotencyRow {
  status_code: number;
  response_body: string;
}

/**
 * Called from within `authenticate` after req.user is set.
 *
 * For mutating requests carrying X-Idempotency-Key:
 * - If (key, userId, method, path) already stored: replays the cached response.
 * - Otherwise: wraps res.json to capture and store a successful response.
 *
 * Key length is capped and the cached body is skipped when it exceeds
 * MAX_CACHED_BODY_BYTES to prevent large backups blowing up the table.
 */
export function applyIdempotency(req: Request, res: Response, next: NextFunction, userId: number): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const key = req.headers['x-idempotency-key'] as string | undefined;
  if (!key) {
    next();
    return;
  }
  if (key.length > MAX_KEY_LENGTH) {
    res.status(400).json({ error: 'X-Idempotency-Key exceeds maximum length of 128 characters' });
    return;
  }

  const existing = db.prepare(
    'SELECT status_code, response_body FROM idempotency_keys WHERE key = ? AND user_id = ? AND method = ? AND path = ?'
  ).get(key, userId, req.method, req.path) as IdempotencyRow | undefined;

  if (existing) {
    res.status(existing.status_code).json(JSON.parse(existing.response_body));
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const serialized = JSON.stringify(body);
      if (serialized.length <= MAX_CACHED_BODY_BYTES) {
        try {
          db.prepare(
            'INSERT OR IGNORE INTO idempotency_keys (key, user_id, method, path, status_code, response_body) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(key, userId, req.method, req.path, res.statusCode, serialized);
        } catch {
          // Non-fatal: idempotency is best-effort if the table is missing
        }
      }
    }
    return originalJson(body);
  };

  next();
}
