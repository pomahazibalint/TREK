interface GeoResult { city: string | null; country: string | null }

const cache = new Map<string, GeoResult>()
let lastCallAt = 0
const MIN_INTERVAL_MS = 1100

function cacheKey(lat: number, lng: number): string {
  // ~1.1 km grid — same city block = same key
  return `${Math.round(lat * 100) / 100},${Math.round(lng * 100) / 100}`
}

export async function reverseGeocode(lat: number, lng: number): Promise<GeoResult> {
  const key = cacheKey(lat, lng)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const now = Date.now()
  const wait = lastCallAt + MIN_INTERVAL_MS - now
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastCallAt = Date.now()

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'User-Agent': 'TREK-Travel-Planner/1.0 (self-hosted)' }, signal: AbortSignal.timeout(8000) as any }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as any
    const addr = data.address || {}
    const result: GeoResult = {
      city: addr.city || addr.town || addr.village || addr.municipality || addr.county || null,
      country: addr.country || null,
    }
    cache.set(key, result)
    return result
  } catch {
    const result: GeoResult = { city: null, country: null }
    cache.set(key, result)
    return result
  }
}
