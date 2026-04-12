/**
 * Wizzair flight confirmation parser.
 * Extracts flight details from Wizzair confirmation emails.
 */

import { BookingParser, ParsedBooking } from './types.js'

const wizzairParser: BookingParser = {
  id: 'wizzair',
  name: 'Wizz Air',
  description: 'Parse Wizz Air flight confirmation emails',

  detect(input: string): boolean {
    return input.toLowerCase().includes('wizzair') || input.toLowerCase().includes('wizz air')
  },

  parse(input: string): ParsedBooking | null {
    const lowerText = input.toLowerCase()

    // Must be a flight confirmation
    if (!lowerText.includes('booking') && !lowerText.includes('confirmation') && !lowerText.includes('reservation')) {
      return null
    }

    // Extract booking reference
    let bookingRef: string | undefined
    const refMatch = input.match(/Booking[:\s]+Reference[:\s]+([A-Z0-9]{6})/i)
    if (refMatch) {
      bookingRef = refMatch[1]
    }

    // Extract flight route (FROM - TO)
    let title = 'Wizz Air Flight'
    const routeMatch = input.match(/([A-Z]{3})\s*-\s*([A-Z]{3})/i)
    if (routeMatch) {
      title = `Wizz Air ${routeMatch[1]}-${routeMatch[2]}`
    }

    // Extract departure date/time
    let departureDateTime: string | undefined
    const depMatch = input.match(/Departure[:\s]+(\d{1,2}[\s/-][A-Za-z]{3,}[\s/-]\d{4})[:\s]+(\d{1,2}:\d{2})?/i)
    if (depMatch) {
      departureDateTime = `${depMatch[1]} ${depMatch[2] || ''}`.trim()
    }

    // Extract arrival date/time
    let arrivalDateTime: string | undefined
    const arrMatch = input.match(/Arrival[:\s]+(\d{1,2}[\s/-][A-Za-z]{3,}[\s/-]\d{4})[:\s]+(\d{1,2}:\d{2})?/i)
    if (arrMatch) {
      arrivalDateTime = `${arrMatch[1]} ${arrMatch[2] || ''}`.trim()
    }

    if (!bookingRef) {
      return null
    }

    return {
      title,
      type: 'flight',
      confirmation_number: bookingRef,
      reservation_time: departureDateTime,
      reservation_end_time: arrivalDateTime,
      notes: 'Wizz Air flight booking',
    }
  },
}

export default wizzairParser
