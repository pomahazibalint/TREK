/**
 * Generic email text parser for booking confirmations.
 * Extracts booking data using regex patterns from labeled email text.
 * Supports both English and Hungarian labels.
 */

import { BookingParser, ParsedBooking } from './types.js'

interface ExtractedData {
  title?: string
  location?: string
  confirmationNumber?: string
  checkInDate?: string
  checkOutDate?: string
  startDate?: string
  endDate?: string
  notes?: string
}

/**
 * Extract date in various formats: DD/MM/YYYY, YYYY-MM-DD, DD.MM.YYYY, etc.
 */
function extractDate(text: string): string | undefined {
  // Try ISO format YYYY-MM-DD
  const iso = text.match(/\d{4}-\d{2}-\d{2}/)
  if (iso) return iso[0]

  // Try DD/MM/YYYY
  const slash = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (slash) {
    const [, day, month, year] = slash
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  // Try DD.MM.YYYY
  const dot = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (dot) {
    const [, day, month, year] = dot
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  // Try month name format (e.g., "March 15, 2024")
  const monthName = text.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December|Januar|február|március|április|május|június|július|augusztus|szeptember|október|november|december)\s+(\d{1,2}),?\s+(\d{4})/i)
  if (monthName) {
    const [fullMatch, day, year] = monthName
    const months: Record<string, number> = {
      january: 1, januar: 1,
      february: 2, február: 2,
      march: 3, március: 3,
      april: 4, április: 4,
      may: 5, május: 5,
      june: 6, június: 6,
      july: 7, július: 7,
      august: 8, augusztus: 8,
      september: 9, szeptember: 9,
      october: 10, október: 10,
      november: 11, november: 11,
      december: 12, december: 12,
    }
    const monthKey = fullMatch.toLowerCase().split(/\s/)[0]
    const month = months[monthKey]
    if (month) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }

  return undefined
}

/**
 * Extract a value after a labeled line (e.g., "Confirmation number: ABC123").
 */
function extractLabeledValue(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const regex = new RegExp(`${label}[:\\s]+([^\\n]+)`, 'i')
    const match = text.match(regex)
    if (match) {
      return match[1].trim().replace(/\s*[\r\n].+$/s, '') // Take first line only
    }
  }
  return undefined
}

function parseEmailText(text: string): ExtractedData {
  const data: ExtractedData = {}

  // Infer type from text
  const lowerText = text.toLowerCase()
  let inferredType = 'other'
  if (lowerText.includes('flight') || lowerText.includes('booking') && lowerText.includes('air')) inferredType = 'flight'
  else if (lowerText.includes('hotel') || lowerText.includes('accommodation') || lowerText.includes('szállás')) inferredType = 'hotel'
  else if (lowerText.includes('train') || lowerText.includes('railway') || lowerText.includes('vonat')) inferredType = 'train'
  else if (lowerText.includes('car rental') || lowerText.includes('autóbérlés')) inferredType = 'car'

  // Title/subject — often first line or after "Subject:" or "Tárgy:"
  const titleMatch = text.match(/(?:^|\n)(?:Subject|Tárgy|Re):\s*(.+)$/m)
  if (titleMatch) {
    data.title = titleMatch[1].trim()
  } else {
    // Fall back to first line
    const firstLine = text.split('\n')[0].trim()
    if (firstLine && firstLine.length < 100) {
      data.title = firstLine
    }
  }

  // Confirmation numbers — many formats
  data.confirmationNumber = extractLabeledValue(text, [
    'Confirmation[\\s#]*(?:number|code|#)',
    'Confirmation',
    'Book(?:ing)?[\\s#]*(?:ref|reference|#|número|szám)',
    'Ref(?:erence)?[\\s#]*(?:code|#)',
    'Foglalási azonosító',
    'Foglalás száma',
    'Order(?:ing)?[\\s#]*(?:ref|id|#)',
  ])

  // Location — hotel name, city, etc.
  data.location = extractLabeledValue(text, [
    'Hotel(?:\\sname)?',
    'Property',
    'Location',
    'Address',
    'Cím',
    'Szállás',
    'Destination',
  ])

  // Check-in / Check-out dates for hotels
  const checkInMatch = text.match(/(?:Check-?in|Arrival|Bejelentkezés)[:\s]+([^\n]+)/i)
  if (checkInMatch) {
    data.checkInDate = extractDate(checkInMatch[1])
  }

  const checkOutMatch = text.match(/(?:Check-?out|Departure|Kijelentkezés)[:\s]+([^\n]+)/i)
  if (checkOutMatch) {
    data.checkOutDate = extractDate(checkOutMatch[1])
  }

  // Departure / Arrival dates for flights
  if (!data.checkInDate) {
    const departureMatch = text.match(/(?:Departure|Start|Indulás|Oda)[:\s]+([^\n]+)/i)
    if (departureMatch) {
      data.startDate = extractDate(departureMatch[1])
    }
  }

  if (!data.checkOutDate) {
    const arrivalMatch = text.match(/(?:Arrival|End|Érkezés|Visszaút)[:\s]+([^\n]+)/i)
    if (arrivalMatch) {
      data.endDate = extractDate(arrivalMatch[1])
    }
  }

  // Extract first ~500 chars of additional notes
  const notesMatch = text.match(/(?:Remarks|Notes|Details|Megjegyzések)[:\s]+(.+?)(?:\n\n|\n--|\Z)/is)
  if (notesMatch) {
    data.notes = notesMatch[1].trim().slice(0, 500)
  }

  return data
}

const emailTextParser: BookingParser = {
  id: 'email-text',
  name: 'Email Text',
  description: 'Parse booking confirmation from plain-text email',

  detect(input: string, mimeType?: string): boolean {
    const lowerText = input.toLowerCase()

    // Heuristics: look for confirmation keywords
    if (
      lowerText.includes('confirmation') ||
      lowerText.includes('booking') ||
      lowerText.includes('reservation') ||
      lowerText.includes('check-in') ||
      lowerText.includes('departure') ||
      lowerText.includes('foglalás') ||
      lowerText.includes('bejelentkezés') ||
      lowerText.includes('indulás')
    ) {
      // But not ICS or HTML
      if (!input.includes('BEGIN:VCALENDAR') && !input.includes('<!DOCTYPE') && !input.includes('<html')) {
        return true
      }
    }

    return false
  },

  parse(input: string): ParsedBooking | null {
    const data = parseEmailText(input)

    if (!data.title) {
      return null // No meaningful data extracted
    }

    // Infer type from content
    const lowerText = input.toLowerCase()
    let type = 'other'
    if (lowerText.includes('flight') || lowerText.includes('airway')) type = 'flight'
    else if (lowerText.includes('hotel') || lowerText.includes('accommodation') || lowerText.includes('szállás')) type = 'hotel'
    else if (lowerText.includes('train') || lowerText.includes('vonat')) type = 'train'
    else if (lowerText.includes('car rental')) type = 'car'

    return {
      title: data.title,
      type,
      confirmation_number: data.confirmationNumber,
      reservation_time: data.checkInDate || data.startDate,
      reservation_end_time: data.checkOutDate || data.endDate,
      location: data.location,
      notes: data.notes,
    }
  },
}

export default emailTextParser
