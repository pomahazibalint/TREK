/**
 * Booking.com confirmation email parser.
 * Extracts hotel booking details from Booking.com confirmation emails.
 */

import { BookingParser, ParsedBooking } from './types.js'

const bookingComParser: BookingParser = {
  id: 'booking-com',
  name: 'Booking.com',
  description: 'Parse Booking.com hotel confirmation emails',

  detect(input: string): boolean {
    return input.toLowerCase().includes('booking.com') || input.includes('booking confirmation')
  },

  parse(input: string): ParsedBooking | null {
    const lowerText = input.toLowerCase()

    // Must be a hotel/accommodation booking
    if (!lowerText.includes('hotel') && !lowerText.includes('accommodation') && !lowerText.includes('reservation')) {
      return null
    }

    // Extract hotel name (often in bold or as a heading)
    let hotelName: string | undefined
    const hotelMatch = input.match(/(?:Hotel:|Property:|<h[1-3]>)?\s*([^\n<]+(?:Hotel|Resort|Inn|Lodge|House|Apartments?|Bed & Breakfast)?)/i)
    if (hotelMatch) {
      hotelName = hotelMatch[1].trim().replace(/<[^>]+>/g, '')
    }

    // Extract confirmation number
    let confirmationNumber: string | undefined
    const confirmMatch = input.match(/Confirmation[:\s]+#?([A-Z0-9]{6,})/i)
    if (confirmMatch) {
      confirmationNumber = confirmMatch[1]
    }

    // Extract address/location
    let location: string | undefined
    const addressMatch = input.match(/(?:Address|Location|Cím)[:\s]+([^\n]+)/i)
    if (addressMatch) {
      location = addressMatch[1].trim()
    }

    // Extract check-in date
    let checkInDate: string | undefined
    const checkInMatch = input.match(/Check-?in[:\s]+(\d{1,2}[\s/-](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s/-]\d{4})/i)
    if (checkInMatch) {
      checkInDate = checkInMatch[1]
    }

    // Extract check-out date
    let checkOutDate: string | undefined
    const checkOutMatch = input.match(/Check-?out[:\s]+(\d{1,2}[\s/-](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s/-]\d{4})/i)
    if (checkOutMatch) {
      checkOutDate = checkOutMatch[1]
    }

    if (!hotelName) {
      return null
    }

    return {
      title: hotelName,
      type: 'hotel',
      confirmation_number: confirmationNumber,
      reservation_time: checkInDate,
      reservation_end_time: checkOutDate,
      location: location || hotelName,
      notes: `Booked via Booking.com`,
    }
  },
}

export default bookingComParser
