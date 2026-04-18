import type { AssignmentsMap } from '../types'

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF'])

export function currencyDecimals(currency: string | undefined | null): number {
  if (!currency) return 2
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
}

export function formatDate(dateStr: string | null | undefined, locale: string, timeZone?: string, short?: boolean): string | null {
  if (!dateStr) return null
  const opts: Intl.DateTimeFormatOptions = {
    ...(short ? {} : { weekday: 'short' }),
    day: 'numeric', month: 'short',
    timeZone: timeZone || 'UTC',
  }
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString(locale, opts)
}

function abbreviateAmount(n: number): string {
  if (n < 1000) return n.toFixed(0)
  if (n < 1_000_000) {
    const k = n / 1000
    const rounded = Math.round(k * 10) / 10
    return rounded % 1 === 0 ? `${rounded.toFixed(0)}K` : `${rounded.toFixed(1)}K`
  }
  const m = n / 1_000_000
  const rounded = Math.round(m * 10) / 10
  return rounded % 1 === 0 ? `${rounded.toFixed(0)}M` : `${rounded.toFixed(1)}M`
}

export function formatTime(timeStr: string | null | undefined, locale: string, timeFormat: string): string {
  if (!timeStr) return ''
  try {
    const parts = timeStr.split(':')
    const h = Number(parts[0]) || 0
    const m = Number(parts[1]) || 0
    if (isNaN(h)) return timeStr
    if (timeFormat === '12h') {
      const period = h >= 12 ? 'PM' : 'AM'
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
      return `${h12}:${String(m).padStart(2, '0')} ${period}`
    }
    const str = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    return locale?.startsWith('de') ? `${str} Uhr` : str
  } catch { return timeStr }
}

export function dayTotalCost(dayId: number, assignments: AssignmentsMap, currency: string): string | null {
  const da = assignments[String(dayId)] || []
  const byCurrency: Record<string, number> = {}
  for (const a of da) {
    const visitPrice = (a as any).budget_entry_price
    const visitCurrency = (a as any).budget_entry_currency || currency
    const placePrice = parseFloat((a.place as any)?.price || '') || 0
    const placeCurrency = (a.place as any)?.currency || currency
    const price = visitPrice != null ? visitPrice : placePrice
    const cur = visitPrice != null ? visitCurrency : placeCurrency
    if (price > 0) byCurrency[cur] = (byCurrency[cur] || 0) + price
  }
  const parts = Object.entries(byCurrency).map(([cur, total]) => `${abbreviateAmount(total)} ${cur}`)
  return parts.length > 0 ? parts.join(' + ') : null
}

export function dayAvgPriceLevel(dayId: number, assignments: AssignmentsMap): number | null {
  const da = assignments[String(dayId)] || []
  const levels = da.map(a => a.place?.price_level).filter(v => v != null) as number[]
  if (levels.length === 0) return null
  return levels.reduce((s, v) => s + v, 0) / levels.length
}
