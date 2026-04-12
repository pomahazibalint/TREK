/**
 * Booking parser types and interfaces.
 * Each parser identifies and extracts reservation data from various booking confirmation formats.
 */

export interface ParsedBooking {
  title: string
  type: string // 'flight' | 'hotel' | 'train' | 'car' | 'cruise' | 'event' | 'tour' | 'restaurant' | 'other'
  confirmation_number?: string
  reservation_time?: string // ISO datetime or date string
  reservation_end_time?: string // ISO datetime or date string
  location?: string
  notes?: string
  metadata?: Record<string, string>
}

export interface BookingParser {
  id: string
  name: string
  description: string

  /**
   * Quick heuristic check: should this parser attempt to parse the input?
   * @param input The raw input string (email text, HTML, etc.)
   * @param mimeType Optional MIME type hint (e.g., 'text/html', 'text/plain')
   */
  detect(input: string, mimeType?: string): boolean

  /**
   * Parse the input and return one or more reservations.
   * @param input The raw input string
   * @param mimeType Optional MIME type hint
   * @returns One or more ParsedBooking objects, or null if parsing failed
   */
  parse(input: string, mimeType?: string): ParsedBooking | ParsedBooking[] | null
}

/**
 * Utility to extract date/time strings from various formats.
 */
export function normalizeDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return undefined
    return d.toISOString().slice(0, 10) // YYYY-MM-DD
  } catch {
    return undefined
  }
}

/**
 * Extract ISO datetime from a date string. If only date is provided, returns date at 00:00:00 UTC.
 */
export function normalizeDateTime(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return undefined
    return d.toISOString()
  } catch {
    return undefined
  }
}
