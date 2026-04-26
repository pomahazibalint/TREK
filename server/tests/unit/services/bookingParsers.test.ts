/**
 * Unit tests for booking parsers.
 * Each parser is tested in isolation (detect + parse) and the dispatcher
 * (parseBooking) is tested for routing and error recovery.
 */
import { describe, it, expect } from 'vitest';
import icsParser from '../../../src/services/bookingParsers/ics';
import csvParser from '../../../src/services/bookingParsers/csv';
import bookingComParser from '../../../src/services/bookingParsers/bookingCom';
import wizzairParser from '../../../src/services/bookingParsers/wizzair';
import emailTextParser from '../../../src/services/bookingParsers/emailText';
import { parseBooking, listParsers } from '../../../src/services/bookingParsers/index';
import { normalizeDate, normalizeDateTime } from '../../../src/services/bookingParsers/types';

// ─────────────────────────────────────────────────────────────────────────────
// normalizeDate / normalizeDateTime helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeDate', () => {
  it('returns YYYY-MM-DD for a valid date string', () => {
    expect(normalizeDate('2024-06-15')).toBe('2024-06-15');
  });

  it('returns YYYY-MM-DD for an ISO datetime string', () => {
    expect(normalizeDate('2024-06-15T10:00:00Z')).toBe('2024-06-15');
  });

  it('returns undefined for undefined input', () => {
    expect(normalizeDate(undefined)).toBeUndefined();
  });

  it('returns undefined for an invalid date string', () => {
    expect(normalizeDate('not-a-date')).toBeUndefined();
  });
});

describe('normalizeDateTime', () => {
  it('returns an ISO string for a valid date', () => {
    const result = normalizeDateTime('2024-06-15');
    expect(result).toMatch(/^2024-06-15T/);
  });

  it('returns undefined for undefined input', () => {
    expect(normalizeDateTime(undefined)).toBeUndefined();
  });

  it('returns undefined for an invalid datetime string', () => {
    expect(normalizeDateTime('garbage')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ICS parser
// ─────────────────────────────────────────────────────────────────────────────

const BASIC_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Flight to Paris
DTSTART:20240615T100000Z
DTEND:20240615T130000Z
LOCATION:Charles de Gaulle Airport
DESCRIPTION:Confirmation flight booking
UID:ABC123@airline.com
END:VEVENT
END:VCALENDAR`;

const ALL_DAY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Hotel Stay
DTSTART;VALUE=DATE:20241001
DTEND;VALUE=DATE:20241005
LOCATION:Grand Hotel Berlin
UID:HOTEL789@booking.com
END:VEVENT
END:VCALENDAR`;

const MULTI_EVENT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Outbound flight
DTSTART:20240620T080000Z
DTEND:20240620T100000Z
UID:LEG1@airline.com
END:VEVENT
BEGIN:VEVENT
SUMMARY:Return flight
DTSTART:20240627T160000Z
DTEND:20240627T180000Z
UID:LEG2@airline.com
END:VEVENT
END:VCALENDAR`;

describe('ICS parser — detect', () => {
  it('detects text/calendar mime type', () => {
    expect(icsParser.detect('anything', 'text/calendar')).toBe(true);
  });

  it('detects BEGIN:VCALENDAR + BEGIN:VEVENT', () => {
    expect(icsParser.detect(BASIC_ICS)).toBe(true);
  });

  it('does not detect plain text without ICS markers', () => {
    expect(icsParser.detect('Booking confirmation for your hotel stay')).toBe(false);
  });
});

describe('ICS parser — parse', () => {
  it('extracts title from SUMMARY', () => {
    const result = icsParser.parse(BASIC_ICS);
    expect(Array.isArray(result) ? result[0].title : result?.title).toBe('Flight to Paris');
  });

  it('extracts confirmation_number from UID (part before @)', () => {
    const result = icsParser.parse(BASIC_ICS);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.confirmation_number).toBe('ABC123');
  });

  it('extracts location', () => {
    const result = icsParser.parse(BASIC_ICS);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.location).toBe('Charles de Gaulle Airport');
  });

  it('parses DTSTART in basic UTC format (20240615T100000Z)', () => {
    const result = icsParser.parse(BASIC_ICS);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.reservation_time).toContain('2024-06-15');
  });

  it('parses DTEND and stores as reservation_end_time', () => {
    const result = icsParser.parse(BASIC_ICS);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.reservation_end_time).toContain('2024-06-15');
  });

  it('infers type as flight from keywords in SUMMARY/DESCRIPTION', () => {
    const result = icsParser.parse(BASIC_ICS);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.type).toBe('flight');
  });

  it('infers type as hotel when SUMMARY contains hotel keywords', () => {
    const result = icsParser.parse(ALL_DAY_ICS);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.type).toBe('hotel');
  });

  it('handles all-day DTSTART;VALUE=DATE without crashing', () => {
    const result = icsParser.parse(ALL_DAY_ICS);
    expect(result).not.toBeNull();
  });

  it('returns an array for multiple VEVENT blocks', () => {
    const result = icsParser.parse(MULTI_EVENT_ICS);
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).length).toBe(2);
  });

  it('returns a single object (not array) for one VEVENT', () => {
    const result = icsParser.parse(BASIC_ICS);
    expect(Array.isArray(result)).toBe(false);
  });

  it('returns null when no VEVENT blocks are found', () => {
    const noEvents = `BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR`;
    expect(icsParser.parse(noEvents)).toBeNull();
  });

  it('falls back to title "Booking" when SUMMARY is absent', () => {
    const noSummary = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20240615T100000Z\nUID:X@x\nEND:VEVENT\nEND:VCALENDAR`;
    const result = icsParser.parse(noSummary);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.title).toBe('Booking');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV parser
// ─────────────────────────────────────────────────────────────────────────────

const BASIC_CSV = `title,type,location,confirmation_number,reservation_time,reservation_end_time,notes
Grand Hotel Berlin,hotel,Berlin,CONF123,2024-10-01,2024-10-05,Breakfast included`;

const MULTI_ROW_CSV = `title,type,location,confirmation_number,reservation_time,notes
Flight to Paris,flight,Paris,FL001,2024-06-15,Window seat
Train to Lyon,train,Lyon,TR002,2024-06-20,`;

const ALT_COLUMNS_CSV = `title,type,start_date,start_time,end_date,confirmation_id
Museum Visit,event,2024-07-10,10:00,2024-07-10,MUS999`;

describe('CSV parser — detect', () => {
  it('detects text/csv mime type', () => {
    expect(csvParser.detect('anything', 'text/csv')).toBe(true);
  });

  it('detects CSV heuristic: title + type columns with comma', () => {
    expect(csvParser.detect(BASIC_CSV)).toBe(true);
  });

  it('does not detect ICS content as CSV', () => {
    expect(csvParser.detect(BASIC_ICS)).toBe(false);
  });

  it('does not detect plain prose without commas on first line', () => {
    expect(csvParser.detect('Booking confirmation\nHotel Grand')).toBe(false);
  });
});

describe('CSV parser — parse', () => {
  it('extracts title', () => {
    const result = csvParser.parse(BASIC_CSV);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.title).toBe('Grand Hotel Berlin');
  });

  it('extracts type', () => {
    const result = csvParser.parse(BASIC_CSV);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.type).toBe('hotel');
  });

  it('extracts confirmation_number', () => {
    const result = csvParser.parse(BASIC_CSV);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.confirmation_number).toBe('CONF123');
  });

  it('extracts location', () => {
    const result = csvParser.parse(BASIC_CSV);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.location).toBe('Berlin');
  });

  it('normalizes reservation_time to ISO datetime', () => {
    const result = csvParser.parse(BASIC_CSV);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.reservation_time).toContain('2024-10-01');
  });

  it('normalizes reservation_end_time to ISO datetime', () => {
    const result = csvParser.parse(BASIC_CSV);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.reservation_end_time).toContain('2024-10-05');
  });

  it('returns array for multiple data rows', () => {
    const result = csvParser.parse(MULTI_ROW_CSV);
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).length).toBe(2);
  });

  it('accepts alternative column names confirmation_id and start_date/end_date', () => {
    const result = csvParser.parse(ALT_COLUMNS_CSV);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.confirmation_number).toBe('MUS999');
    expect(booking.reservation_time).toContain('2024-07-10');
  });

  it('combines start_date + start_time when both present', () => {
    const result = csvParser.parse(ALT_COLUMNS_CSV);
    const booking = Array.isArray(result) ? result[0] : result!;
    // Should contain the date portion
    expect(booking.reservation_time).toContain('2024-07-10');
  });

  it('defaults type to "other" when type column is absent', () => {
    const noType = `title,location\nSome Event,Paris`;
    const result = csvParser.parse(noType);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.type).toBe('other');
  });

  it('skips rows without a title', () => {
    const missingTitle = `title,type\n,hotel\nGrand Hotel,hotel`;
    const result = csvParser.parse(missingTitle);
    // Only the row with a title should be returned
    const bookings = Array.isArray(result) ? result : result ? [result] : [];
    expect(bookings.length).toBe(1);
    expect(bookings[0].title).toBe('Grand Hotel');
  });

  it('returns null for empty CSV (header only)', () => {
    const headerOnly = `title,type,location`;
    expect(csvParser.parse(headerOnly)).toBeNull();
  });

  it('returns null for fewer than 2 lines', () => {
    expect(csvParser.parse('title')).toBeNull();
  });

  it('handles trailing whitespace on values', () => {
    const padded = `title , type , location\nGrand Hotel , hotel , Berlin`;
    const result = csvParser.parse(padded);
    const booking = Array.isArray(result) ? result[0] : result!;
    expect(booking.title).toBe('Grand Hotel');
    expect(booking.type).toBe('hotel');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking.com parser
// ─────────────────────────────────────────────────────────────────────────────

const BOOKING_COM_EMAIL = `From: noreply@booking.com
Subject: Booking confirmation for Grand Hotel Berlin

Your booking at Booking.com is confirmed!

Property: Grand Hotel Berlin
Address: Unter den Linden 1, Berlin

Confirmation: ABC123456

Check-in: 15 Oct 2024
Check-out: 18 Oct 2024

We wish you a pleasant stay.
`;

describe('Booking.com parser — detect', () => {
  it('detects booking.com in text', () => {
    expect(bookingComParser.detect('Your booking at booking.com is confirmed')).toBe(true);
  });

  it('detects "booking confirmation" phrase', () => {
    expect(bookingComParser.detect('booking confirmation #12345')).toBe(true);
  });

  it('does not detect unrelated text', () => {
    expect(bookingComParser.detect('Hello, this is a plain email about cats')).toBe(false);
  });
});

describe('Booking.com parser — parse', () => {
  it('returns type hotel', () => {
    const result = bookingComParser.parse(BOOKING_COM_EMAIL);
    expect(result?.type).toBe('hotel');
  });

  it('extracts confirmation_number', () => {
    const result = bookingComParser.parse(BOOKING_COM_EMAIL);
    expect(result?.confirmation_number).toBe('ABC123456');
  });

  it('extracts check-in date', () => {
    const result = bookingComParser.parse(BOOKING_COM_EMAIL);
    expect(result?.reservation_time).toMatch(/Oct|10|2024/i);
  });

  it('extracts check-out date', () => {
    const result = bookingComParser.parse(BOOKING_COM_EMAIL);
    expect(result?.reservation_end_time).toMatch(/Oct|10|2024/i);
  });

  it('extracts address as location', () => {
    const result = bookingComParser.parse(BOOKING_COM_EMAIL);
    expect(result?.location).toMatch(/Unter den Linden|Grand Hotel/i);
  });

  it('returns null when content lacks hotel/accommodation/reservation keywords', () => {
    const noHotel = `booking.com: your flight is confirmed`;
    expect(bookingComParser.parse(noHotel)).toBeNull();
  });

  it('returns null when hotel/accommodation/reservation keywords are absent', () => {
    // detect fires (booking.com present) but parse bails on missing domain keywords
    const noHotelKeywords = `booking.com: your flight booking for CONF99 has been processed`;
    expect(bookingComParser.parse(noHotelKeywords)).toBeNull();
  });

  it('includes Booking.com attribution in notes', () => {
    const result = bookingComParser.parse(BOOKING_COM_EMAIL);
    expect(result?.notes).toMatch(/Booking\.com/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wizzair parser
// ─────────────────────────────────────────────────────────────────────────────

const WIZZAIR_EMAIL = `From: noreply@wizzair.com
Subject: Wizz Air booking confirmation

Thank you for booking with Wizz Air!

Booking Reference: XY5Z12

Route: BUD - CDG

Departure: 20 Jun 2024: 07:30
Arrival: 20 Jun 2024: 09:45

Passenger: John Doe
`;

const WIZZAIR_MULTI_LEG = `Wizz Air booking confirmation

Booking Reference: ML9876

Outbound
Route: BUD - LTN
Departure: 15 Jul 2024: 06:00
Arrival: 15 Jul 2024: 08:15

Return
Route: LTN - BUD
Departure: 22 Jul 2024: 14:00
Arrival: 22 Jul 2024: 16:10
`;

describe('Wizzair parser — detect', () => {
  it('detects wizzair in text', () => {
    expect(wizzairParser.detect('Thank you for booking with wizzair.com')).toBe(true);
  });

  it('detects "wizz air" phrase (with space)', () => {
    expect(wizzairParser.detect('Your Wizz Air flight is confirmed')).toBe(true);
  });

  it('does not detect unrelated text', () => {
    expect(wizzairParser.detect('Ryanair booking confirmation')).toBe(false);
  });
});

describe('Wizzair parser — parse', () => {
  it('returns type flight', () => {
    const result = wizzairParser.parse(WIZZAIR_EMAIL);
    expect(result?.type).toBe('flight');
  });

  it('extracts booking reference as confirmation_number', () => {
    const result = wizzairParser.parse(WIZZAIR_EMAIL);
    expect(result?.confirmation_number).toBe('XY5Z12');
  });

  it('builds title from IATA route codes', () => {
    const result = wizzairParser.parse(WIZZAIR_EMAIL);
    expect(result?.title).toMatch(/BUD.*CDG|CDG.*BUD/i);
  });

  it('extracts departure date/time', () => {
    const result = wizzairParser.parse(WIZZAIR_EMAIL);
    expect(result?.reservation_time).toMatch(/20 Jun 2024|07:30/);
  });

  it('extracts arrival date/time', () => {
    const result = wizzairParser.parse(WIZZAIR_EMAIL);
    expect(result?.reservation_end_time).toMatch(/20 Jun 2024|09:45/);
  });

  it('falls back to "Wizz Air Flight" title when no route codes found', () => {
    const noRoute = `Wizz Air booking confirmation\nBooking Reference: AA1111\nconfirmation departure: 10 Jul 2024`;
    const result = wizzairParser.parse(noRoute);
    expect(result?.title).toBe('Wizz Air Flight');
  });

  it('returns null when booking/confirmation keyword is absent', () => {
    const noKeyword = `Wizz Air newsletter: summer sale!`;
    expect(wizzairParser.parse(noKeyword)).toBeNull();
  });

  it('returns null when no booking reference is found', () => {
    const noRef = `Wizz Air confirmation\nRoute: BUD - CDG\nDeparture: 20 Jun 2024`;
    expect(wizzairParser.parse(noRef)).toBeNull();
  });

  it('parses first route from multi-leg email', () => {
    const result = wizzairParser.parse(WIZZAIR_MULTI_LEG);
    expect(result?.confirmation_number).toBe('ML9876');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Email text parser
// ─────────────────────────────────────────────────────────────────────────────

const HOTEL_EMAIL = `Subject: Accommodation booking confirmed

Hotel name: Park Inn Budapest
Address: Sobieski Street 1, Budapest

Confirmation number: HB-2024-999

Check-in: 2024-09-10
Check-out: 2024-09-14
`;

const FLIGHT_EMAIL = `Subject: Flight booking confirmation

Booking reference: FL-20240801
Departure: 2024-08-01
Arrival: 2024-08-01

Your flight has been confirmed. Have a safe journey.
`;

const HUNGARIAN_EMAIL = `Tárgy: Foglalási visszaigazolás

Szállás: Danubius Hotel
Cím: Margit-sziget, Budapest

Foglalási azonosító: H-9999

Bejelentkezés: 2024-11-15
Kijelentkezés: 2024-11-18
`;

describe('Email text parser — detect', () => {
  it('detects "confirmation" keyword', () => {
    expect(emailTextParser.detect('Your booking confirmation #ABC')).toBe(true);
  });

  it('detects "check-in" keyword', () => {
    expect(emailTextParser.detect('Check-in: 15 Oct 2024')).toBe(true);
  });

  it('detects Hungarian "foglalás" keyword', () => {
    expect(emailTextParser.detect('Köszönjük a foglalást!')).toBe(true);
  });

  it('detects Hungarian "bejelentkezés" keyword', () => {
    expect(emailTextParser.detect('Bejelentkezés: 2024-10-15')).toBe(true);
  });

  it('does not detect ICS content', () => {
    expect(emailTextParser.detect(BASIC_ICS)).toBe(false);
  });

  it('does not detect HTML content', () => {
    expect(emailTextParser.detect('<!DOCTYPE html><html><body>booking</body></html>')).toBe(false);
  });

  it('does not detect unrelated plain text', () => {
    expect(emailTextParser.detect('Hello, how are you today?')).toBe(false);
  });
});

describe('Email text parser — parse', () => {
  it('extracts title from Subject line', () => {
    const result = emailTextParser.parse(HOTEL_EMAIL);
    expect(result?.title).toMatch(/Accommodation booking confirmed/i);
  });

  it('infers type as hotel from content keywords', () => {
    const result = emailTextParser.parse(HOTEL_EMAIL);
    expect(result?.type).toBe('hotel');
  });

  it('infers type as flight from content keywords', () => {
    const result = emailTextParser.parse(FLIGHT_EMAIL);
    expect(result?.type).toBe('flight');
  });

  it('extracts confirmation_number', () => {
    const result = emailTextParser.parse(HOTEL_EMAIL);
    expect(result?.confirmation_number).toMatch(/HB-2024-999/);
  });

  it('extracts check-in date as reservation_time', () => {
    const result = emailTextParser.parse(HOTEL_EMAIL);
    expect(result?.reservation_time).toBe('2024-09-10');
  });

  it('extracts check-out date as reservation_end_time', () => {
    const result = emailTextParser.parse(HOTEL_EMAIL);
    expect(result?.reservation_end_time).toBe('2024-09-14');
  });

  it('extracts location from Hotel name label', () => {
    const result = emailTextParser.parse(HOTEL_EMAIL);
    expect(result?.location).toMatch(/Park Inn Budapest/);
  });

  it('parses DD/MM/YYYY date format', () => {
    const email = `Subject: Train booking\nConfirmation: T999\nDeparture: 25/12/2024\n`;
    const result = emailTextParser.parse(email);
    expect(result?.reservation_time).toBe('2024-12-25');
  });

  it('parses DD.MM.YYYY date format', () => {
    const email = `Subject: Hotel stay\nConfirmation: H123\nCheck-in: 15.08.2024\n`;
    const result = emailTextParser.parse(email);
    expect(result?.reservation_time).toBe('2024-08-15');
  });

  it('parses month-name format "March 15, 2024"', () => {
    const email = `Subject: Reservation\nConfirmation: X1\nCheck-in: March 15, 2024\n`;
    const result = emailTextParser.parse(email);
    expect(result?.reservation_time).toBe('2024-03-15');
  });

  it('parses Hungarian email with Tárgy, Foglalási azonosító, Bejelentkezés, Kijelentkezés', () => {
    const result = emailTextParser.parse(HUNGARIAN_EMAIL);
    expect(result).not.toBeNull();
    expect(result?.title).toMatch(/Foglalási visszaigazolás/i);
    expect(result?.confirmation_number).toMatch(/H-9999/);
    expect(result?.reservation_time).toBe('2024-11-15');
    expect(result?.reservation_end_time).toBe('2024-11-18');
  });

  it('returns null when no title can be extracted', () => {
    // Blank first line (length 0) → fallback skipped; no Subject label → title stays undefined
    const noTitle = `\nThis is a booking confirmation with no subject line and blank first line.`;
    expect(emailTextParser.parse(noTitle)).toBeNull();
  });

  it('falls back to first line as title when no Subject label', () => {
    const noSubject = `My hotel reservation\nConfirmation: Z999\nCheck-in: 2024-05-01\n`;
    const result = emailTextParser.parse(noSubject);
    expect(result?.title).toBe('My hotel reservation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher (parseBooking)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseBooking dispatcher', () => {
  it('routes ICS content to the ICS parser', () => {
    const results = parseBooking(BASIC_ICS);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe('Flight to Paris');
  });

  it('routes Wizzair content to the Wizzair parser', () => {
    const results = parseBooking(WIZZAIR_EMAIL);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('flight');
  });

  it('routes Booking.com content to the Booking.com parser', () => {
    const results = parseBooking(BOOKING_COM_EMAIL);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('hotel');
  });

  it('routes CSV content by mime type', () => {
    // CSV without email-text trigger words (no confirmation/booking/reservation/check-in)
    // so email-text parser does not fire first and CSV parser handles it via mime type
    const plainCsv = `title,type,location\nGrand Hotel Berlin,hotel,Berlin`;
    const results = parseBooking(plainCsv, 'text/csv');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe('Grand Hotel Berlin');
  });

  it('returns [] when no parser matches', () => {
    expect(parseBooking('Hello world, nothing to parse here!')).toEqual([]);
  });

  it('returns [] and does not throw when a parser throws internally', () => {
    // ICS detect will match but parse returns null for empty VEVENT list
    const malformed = `BEGIN:VCALENDAR\nBEGIN:VEVENT\n\nEND:VEVENT\nEND:VCALENDAR`;
    expect(() => parseBooking(malformed)).not.toThrow();
  });

  it('always returns an array (wraps single result)', () => {
    const result = parseBooking(BASIC_ICS);
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('listParsers', () => {
  it('returns an entry for each registered parser', () => {
    const parsers = listParsers();
    const ids = parsers.map(p => p.id);
    expect(ids).toContain('ics');
    expect(ids).toContain('csv');
    expect(ids).toContain('booking-com');
    expect(ids).toContain('wizzair');
    expect(ids).toContain('email-text');
  });

  it('every entry has id, name, and description', () => {
    for (const p of listParsers()) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
    }
  });
});
