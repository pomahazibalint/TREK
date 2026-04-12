/**
 * Booking parser registry and dispatcher.
 *
 * Parsers are tried in order of specificity (most-specific first).
 * The first parser whose detect() method returns true will attempt to parse the input.
 */

import { BookingParser, ParsedBooking } from './types.js'
import icsParser from './ics.js'
import csvParser from './csv.js'
import emailTextParser from './emailText.js'
import bookingComParser from './bookingCom.js'
import wizzairParser from './wizzair.js'

/**
 * Registry of all parsers, ordered by specificity.
 * More specific (format-based or site-specific) parsers come first.
 */
const PARSERS: BookingParser[] = [
  icsParser, // ICS is very specific format
  wizzairParser, // Site-specific
  bookingComParser, // Site-specific
  emailTextParser, // Generic email text (must come before CSV to avoid false matches)
  csvParser, // Generic CSV format
]

/**
 * Parse booking confirmation from various input formats.
 *
 * @param input The raw input (email text, HTML, CSV, ICS, etc.)
 * @param mimeType Optional MIME type hint (e.g., 'text/html', 'text/csv', 'text/calendar')
 * @returns Array of successfully parsed bookings
 */
export function parseBooking(input: string, mimeType?: string): ParsedBooking[] {
  for (const parser of PARSERS) {
    if (parser.detect(input, mimeType)) {
      try {
        const result = parser.parse(input, mimeType)
        if (result) {
          return Array.isArray(result) ? result : [result]
        }
      } catch (err) {
        console.error(`[BookingParser] Error in parser "${parser.id}":`, err)
        // Continue to next parser on error
      }
    }
  }

  // No parser matched or all returned null
  return []
}

/**
 * Get list of available parsers (for UI/admin purposes).
 */
export function listParsers(): Array<{ id: string; name: string; description: string }> {
  return PARSERS.map(p => ({ id: p.id, name: p.name, description: p.description }))
}
