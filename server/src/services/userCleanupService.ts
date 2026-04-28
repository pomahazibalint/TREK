import { db } from '../db/database';

/**
 * Delete a user and null/remove every FK that references their row.
 *
 * Columns without ON DELETE CASCADE or ON DELETE SET NULL that reference
 * users(id):
 *   - trip_members.invited_by       (nullable, no action)
 *   - budget_items.paid_by_user_id  (nullable, no action)
 *   - share_tokens.created_by       (NOT NULL, no action) — rows deleted
 *
 * All other tables use ON DELETE CASCADE, so they are cleaned up automatically
 * when the users row is removed.
 */
export function deleteUserWithCleanup(userId: number): void {
  db.transaction(() => {
    db.prepare('UPDATE trip_members SET invited_by = NULL WHERE invited_by = ?').run(userId);
    db.prepare('UPDATE budget_items SET paid_by_user_id = NULL WHERE paid_by_user_id = ?').run(userId);
    db.prepare('DELETE FROM share_tokens WHERE created_by = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
}
