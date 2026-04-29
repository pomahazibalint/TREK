import { mapsApi } from '../api/client'
import type { Place } from '../types'

// Shared photo cache — used by PlaceAvatar (sidebar) and MapView (map markers)
interface PhotoEntry {
  photoUrl: string | null
  thumbDataUrl: string | null
}

const cache = new Map<string, PhotoEntry>()
const inFlight = new Set<string>()
const listeners = new Map<string, Set<(entry: PhotoEntry) => void>>()
// Separate thumb listeners — called when thumbDataUrl becomes available after initial load
const thumbListeners = new Map<string, Set<(thumb: string) => void>>()

// Concurrency limiter — prevents simultaneous burst requests that trip crawl detection
const MAX_CONCURRENT = 4
let activeRequests = 0
interface QueueItem { cacheKey: string; photoId: string; lat?: number; lng?: number; name?: string }
const requestQueue: QueueItem[] = []

function drainQueue() {
  while (activeRequests < MAX_CONCURRENT && requestQueue.length > 0) {
    const item = requestQueue.shift()!
    activeRequests++
    mapsApi.placePhoto(item.photoId, item.lat, item.lng, item.name)
      .then(async (data: { photoUrl?: string }) => {
        const photoUrl = data.photoUrl || null
        if (!photoUrl) {
          const entry: PhotoEntry = { photoUrl: null, thumbDataUrl: null }
          cache.set(item.cacheKey, entry)
          notify(item.cacheKey, entry)
          return
        }
        const entry: PhotoEntry = { photoUrl, thumbDataUrl: null }
        cache.set(item.cacheKey, entry)
        notify(item.cacheKey, entry)
        const thumb = await urlToBase64(photoUrl)
        if (thumb) {
          entry.thumbDataUrl = thumb
          notifyThumb(item.cacheKey, thumb)
          mapsApi.reportThumb(item.photoId, thumb).catch(() => {})
        }
      })
      .catch(() => {
        const entry: PhotoEntry = { photoUrl: null, thumbDataUrl: null }
        cache.set(item.cacheKey, entry)
        notify(item.cacheKey, entry)
      })
      .finally(() => {
        inFlight.delete(item.cacheKey)
        activeRequests--
        drainQueue()
      })
  }
}

function notify(key: string, entry: PhotoEntry) {
  listeners.get(key)?.forEach(fn => fn(entry))
  listeners.delete(key)
}

function notifyThumb(key: string, thumb: string) {
  thumbListeners.get(key)?.forEach(fn => fn(thumb))
  thumbListeners.delete(key)
}

export function onPhotoLoaded(key: string, fn: (entry: PhotoEntry) => void): () => void {
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key)!.add(fn)
  return () => { listeners.get(key)?.delete(fn) }
}

// Subscribe to thumb availability — called when base64 thumb is ready (may be after photoUrl)
export function onThumbReady(key: string, fn: (thumb: string) => void): () => void {
  if (!thumbListeners.has(key)) thumbListeners.set(key, new Set())
  thumbListeners.get(key)!.add(fn)
  return () => { thumbListeners.get(key)?.delete(fn) }
}

export function getCached(key: string): PhotoEntry | undefined {
  return cache.get(key)
}

export function isLoading(key: string): boolean {
  return inFlight.has(key)
}

// Convert image URL to base64 via canvas (CORS required — Wikimedia supports it)
export function urlToBase64(url: string, size: number = 48): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')!
        const s = Math.min(img.naturalWidth, img.naturalHeight)
        const sx = (img.naturalWidth - s) / 2
        const sy = (img.naturalHeight - s) / 2
        ctx.beginPath()
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
        ctx.clip()
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size)
        resolve(canvas.toDataURL('image/webp', 0.6))
      } catch { resolve(null) }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export function seedFromPlace(place: Place): void {
  const cacheKey = place.google_place_id || place.osm_id || `${place.lat},${place.lng}`
  if (!cacheKey || cache.has(cacheKey)) return

  if (place.thumb_b64) {
    cache.set(cacheKey, { photoUrl: place.photo_url ?? null, thumbDataUrl: place.thumb_b64 })
    return
  }

  if (place.photo_url) {
    const placeKey = place.google_place_id || place.osm_id
    const entry: PhotoEntry = { photoUrl: place.photo_url, thumbDataUrl: null }
    cache.set(cacheKey, entry)
    // Generate thumbnail locally then report back so subsequent loads are fully cached
    urlToBase64(place.photo_url).then(thumb => {
      if (!thumb) return
      entry.thumbDataUrl = thumb
      notifyThumb(cacheKey, thumb)
      if (placeKey) {
        mapsApi.reportThumb(placeKey, thumb).catch(() => {})
      }
    })
  }
}

export function fetchPhoto(
  cacheKey: string,
  photoId: string,
  lat?: number,
  lng?: number,
  name?: string,
  callback?: (entry: PhotoEntry) => void,
  isOnline: boolean = navigator.onLine
) {
  const cached = cache.get(cacheKey)
  if (cached) { callback?.(cached); return }

  if (inFlight.has(cacheKey)) {
    if (callback) onPhotoLoaded(cacheKey, callback)
    return
  }

  // Skip API calls when offline — cache empty result so we don't retry
  if (!isOnline) {
    const entry: PhotoEntry = { photoUrl: null, thumbDataUrl: null }
    cache.set(cacheKey, entry)
    callback?.(entry)
    notify(cacheKey, entry)
    return
  }

  inFlight.add(cacheKey)
  if (callback) onPhotoLoaded(cacheKey, callback)
  requestQueue.push({ cacheKey, photoId, lat, lng, name })
  drainQueue()
}

export function getAllThumbs(): Record<string, string> {
  const r: Record<string, string> = {}
  for (const [k, v] of cache.entries()) {
    if (v.thumbDataUrl) r[k] = v.thumbDataUrl
  }
  return r
}
