/**
 * ICS (iCalendar) parser for booking confirmations.
 * Handles .ics files and calendar data from various booking sites.
 */

import { BookingParser, ParsedBooking, normalizeDateTime } from './types.js'

interface IcsEvent {
  summary?: string
  dtstart?: string
  dtend?: string
  location?: string
  description?: string
  uid?: string
}

/**
 * Parse a simple iCalendar format.
 * Extracts VEVENT components and converts to booking data.
 */
function parseVEvent(vEventBlock: string): IcsEvent {
  const event: IcsEvent = {}

  // Extract SUMMARY
  const summaryMatch = vEventBlock.match(/^SUMMARY:(.+)$/m)
  if (summaryMatch) event.summary = summaryMatch[1].trim()

  // Extract DTSTART (RFC 5545 format: 20240315T100000Z or 20240315)
  const dtStartMatch = vEventBlock.match(/^DTSTART[^:]*:(.+)$/m)
  if (dtStartMatch) {
    const dt = dtStartMatch[1].trim()
    // Convert basic format to ISO
    if (/^\d{8}/.test(dt)) {
      // Basic format: 20240315 or 20240315T100000Z
      const year = dt.slice(0, 4)
      const month = dt.slice(4, 6)
      const day = dt.slice(6, 8)
      const time = dt.slice(9, 15) || '000000'
      const isUtc = dt.includes('Z')

      const isoDate = `${year}-${month}-${day}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}${isUtc ? 'Z' : ''}`
      event.dtstart = isoDate
    } else {
      event.dtstart = dt
    }
  }

  // Extract DTEND
  const dtEndMatch = vEventBlock.match(/^DTEND[^:]*:(.+)$/m)
  if (dtEndMatch) {
    const dt = dtEndMatch[1].trim()
    if (/^\d{8}/.test(dt)) {
      const year = dt.slice(0, 4)
      const month = dt.slice(4, 6)
      const day = dt.slice(6, 8)
      const time = dt.slice(9, 15) || '000000'
      const isUtc = dt.includes('Z')
      const isoDate = `${year}-${month}-${day}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}${isUtc ? 'Z' : ''}`
      event.dtend = isoDate
    } else {
      event.dtend = dt
    }
  }

  // Extract LOCATION
  const locationMatch = vEventBlock.match(/^LOCATION:(.+)$/m)
  if (locationMatch) event.location = locationMatch[1].trim()

  // Extract DESCRIPTION
  const descriptionMatch = vEventBlock.match(/^DESCRIPTION:(.+)$/m)
  if (descriptionMatch) event.description = descriptionMatch[1].trim()

  // Extract UID (often used as confirmation number)
  const uidMatch = vEventBlock.match(/^UID:(.+)$/m)
  if (uidMatch) event.uid = uidMatch[1].trim()

  return event
}

/**
 * Infer booking type from event summary/description.
 */
function inferType(summary?: string, description?: string): string {
  const combined = `${summary} ${description}`.toLowerCase()

  if (combined.includes('flight') || combined.includes('booking') && combined.includes('airway')) return 'flight'
  if (combined.includes('hotel') || combined.includes('accommodation') || combined.includes('room')) return 'hotel'
  if (combined.includes('train') || combined.includes('railway')) return 'train'
  if (combined.includes('car') || combined.includes('rental')) return 'car'
  if (combined.includes('cruise')) return 'cruise'
  if (combined.includes('event')) return 'event'
  if (combined.includes('tour')) return 'tour'
  if (combined.includes('restaurant') || combined.includes('dining')) return 'restaurant'

  return 'other'
}

const icsParser: BookingParser = {
  id: 'ics',
  name: 'iCalendar',
  description: 'Import from .ics calendar files or calendar invite text',

  detect(input: string, mimeType?: string): boolean {
    if (mimeType === 'text/calendar') return true
    if (input.includes('BEGIN:VCALENDAR') && input.includes('BEGIN:VEVENT')) return true
    return false
  },

  parse(input: string): ParsedBooking | ParsedBooking[] | null {
    // Extract all VEVENT blocks
    const vEventRegex = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g
    const matches = input.match(vEventRegex)

    if (!matches || matches.length === 0) {
      return null
    }

    const bookings: ParsedBooking[] = matches.map((vEventBlock) => {
      const event = parseVEvent(vEventBlock)

      return {
        title: event.summary || 'Booking',
        type: inferType(event.summary, event.description),
        confirmation_number: event.uid ? event.uid.split('@')[0] : undefined,
        reservation_time: normalizeDateTime(event.dtstart),
        reservation_end_time: normalizeDateTime(event.dtend),
        location: event.location,
        notes: event.description,
      }
    })

    return bookings.length === 1 ? bookings[0] : bookings
  },
}

export default icsParser
