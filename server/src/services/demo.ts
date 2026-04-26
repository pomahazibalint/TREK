// Single source of truth for demo-mode email addresses.
// Used by demoUploadBlock, mfaPolicy, and every demo-mode guard in authService.
// Previously only 'demo@nomad.app' was blocked by demoUploadBlock, so the
// canonical 'demo@trek.app' seed user could in fact upload files in demo mode.
export const DEMO_EMAIL_PRIMARY = 'demo@trek.app';
export const DEMO_EMAILS = new Set(['demo@trek.app', 'demo@nomad.app']);

export function isDemoEmail(email?: string | null): boolean {
  return !!email && DEMO_EMAILS.has(email);
}
