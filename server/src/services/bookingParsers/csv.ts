/**
 * CSV parser for bulk reservation import.
 * Expects columns: title, type, location, confirmation_number, reservation_time, reservation_end_time, notes
 */

import { BookingParser, ParsedBooking, normalizeDateTime } from './types.js'

interface CsvRow {
  title?: string
  type?: string
  location?: string
  confirmation_number?: string
  confirmation_id?: string // alternative column name
  reservation_time?: string
  start_date?: string // alternative column name
  start_time?: string // combined with start_date
  reservation_end_time?: string
  end_date?: string // alternative column name
  end_time?: string // combined with end_date
  notes?: string
  [key: string]: string | undefined
}

/**
 * Parse a simple CSV (comma-separated). Handles basic unquoted values.
 * For complex CSV with quoted fields, consider adding a proper CSV library.
 */
function parseCsvText(text: string): CsvRow[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l)
  if (lines.length < 2) return []

  const headerLine = lines[0]
  const headers = headerLine.split(',').map(h => h.trim().toLowerCase())

  const rows: CsvRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const values = line.split(',').map(v => v.trim())

    if (values.length === 0 || !values[0]) continue

    const row: CsvRow = {}
    for (let j = 0; j < headers.length && j < values.length; j++) {
      row[headers[j]] = values[j]
    }
    rows.push(row)
  }

  return rows
}

/**
 * Combine date and time fields if separated.
 */
function combineDateTime(dateStr?: string, timeStr?: string): string | undefined {
  if (!dateStr) return undefined
  const combined = `${dateStr} ${timeStr || ''}`.trim()
  return normalizeDateTime(combined)
}

const csvParser: BookingParser = {
  id: 'csv',
  name: 'CSV',
  description: 'Import reservations from CSV file with columns: title, type, location, confirmation_number, reservation_time, notes',

  detect(input: string, mimeType?: string): boolean {
    if (mimeType === 'text/csv') return true

    // Heuristic: looks like CSV with booking columns
    if (input.includes('title') && (input.includes('type') || input.includes('location'))) {
      // First line should be headers
      const firstLine = input.split('\n')[0]
      return firstLine.toLowerCase().includes(',')
    }

    return false
  },

  parse(input: string): ParsedBooking | ParsedBooking[] | null {
    const rows = parseCsvText(input)

    if (rows.length === 0) {
      return null
    }

    const bookings: ParsedBooking[] = rows
      .filter(row => row.title) // Must have title
      .map(row => ({
        title: row.title || 'Booking',
        type: row.type || 'other',
        confirmation_number: row.confirmation_number || row.confirmation_id,
        reservation_time: combineDateTime(row.reservation_time || row.start_date, row.start_time),
        reservation_end_time: combineDateTime(row.reservation_end_time || row.end_date, row.end_time),
        location: row.location,
        notes: row.notes,
      }))

    return bookings.length === 1 ? bookings[0] : bookings.length > 0 ? bookings : null
  },
}

export default csvParser
